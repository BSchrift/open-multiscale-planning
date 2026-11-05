import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createAuth } from './auth';
import { fixedClock } from './clock';
import { memoryTokens } from '../platform/memory';

const REDIRECT = 'multiscale://auth/callback';
const NOW = Date.parse('2026-11-02T15:00:00Z');

const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status });
const tokens = (access: string, extra: object = {}) => ({ access_token: access, expires_in: 3600, token_type: 'Bearer', ...extra });

function setup(tokenEndpoint?: (form: URLSearchParams) => Response | Promise<Response>, revokeEndpoint: () => Response = () => new Response(null, { status: 200 })) {
  const clock = fixedClock(NOW);
  const store = memoryTokens();
  const opened: string[] = [];
  const forms: URLSearchParams[] = [];
  const revoked: URLSearchParams[] = [];
  const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'content-type': 'application/x-www-form-urlencoded' });
    const form = new URLSearchParams(init.body as string);
    if (url === 'https://auth.example.test/oauth2/revoke') return (revoked.push(form), revokeEndpoint());
    expect(url).toBe('https://auth.example.test/oauth2/token');
    forms.push(form);
    return tokenEndpoint ? tokenEndpoint(form) : json(200, tokens('access-1', { refresh_token: 'refresh-1' }));
  });
  const auth = createAuth({
    authUrl: 'https://auth.example.test',
    clientId: 'client-1',
    redirectUri: REDIRECT,
    clock,
    tokens: store,
    openExternal: async (url) => void opened.push(url),
    fetch: fetchFn,
  });
  return { auth, clock, store, opened, forms, revoked, fetchFn };
}

async function signedIn(t: ReturnType<typeof setup>) {
  await t.auth.signIn();
  const state = new URL(t.opened.at(-1)!).searchParams.get('state')!;
  await t.auth.handleRedirect(`${REDIRECT}?code=the-code&state=${state}`);
}

describe('sign-in', () => {
  it('opens the authorize page with an S256 challenge, a state and no secret', async () => {
    const t = setup();
    await t.auth.signIn();
    const url = new URL(t.opened[0]!);
    expect(url.origin + url.pathname).toBe('https://auth.example.test/oauth2/authorize');
    const q = url.searchParams;
    expect(q.get('response_type')).toBe('code');
    expect(q.get('client_id')).toBe('client-1');
    expect(q.get('redirect_uri')).toBe(REDIRECT);
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(q.get('state')!.length).toBeGreaterThanOrEqual(32);
    expect(q.get('scope')).toContain('openid');
  });

  it('exchanges the code with the verifier that matches the challenge', async () => {
    const t = setup();
    await t.auth.signIn();
    const q = new URL(t.opened[0]!).searchParams;

    expect(await t.auth.handleRedirect(`${REDIRECT}?code=the-code&state=${q.get('state')}`)).toBe(true);

    const form = t.forms[0]!;
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('code')).toBe('the-code');
    expect(form.get('client_id')).toBe('client-1');
    expect(form.get('redirect_uri')).toBe(REDIRECT);
    const verifier = form.get('code_verifier')!;
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(q.get('code_challenge'));
    expect(await t.auth.accessToken()).toBe('access-1');
  });

  it('makes a new verifier and state each time', async () => {
    const t = setup();
    await t.auth.signIn();
    await t.auth.signIn();
    const [a, b] = t.opened.map((u) => new URL(u).searchParams);
    expect(a!.get('state')).not.toBe(b!.get('state'));
    expect(a!.get('code_challenge')).not.toBe(b!.get('code_challenge'));
  });

  it('survives the app restarting while the browser is open', async () => {
    const t = setup();
    await t.auth.signIn();
    const state = new URL(t.opened[0]!).searchParams.get('state');
    const restarted = createAuth({
      authUrl: 'https://auth.example.test',
      clientId: 'client-1',
      redirectUri: REDIRECT,
      clock: t.clock,
      tokens: t.store,
      openExternal: async () => undefined,
      fetch: t.fetchFn,
    });
    expect(await restarted.handleRedirect(`${REDIRECT}?code=c&state=${state}`)).toBe(true);
    expect(await restarted.accessToken()).toBe('access-1');
  });

  it('ignores a deep link that is not the sign-in callback', async () => {
    const t = setup();
    await t.auth.signIn();
    expect(await t.auth.handleRedirect('multiscale://capture?text=x')).toBe(false);
    expect(await t.auth.handleRedirect('multiscale://auth/callbackish?code=c')).toBe(false);
    expect(t.fetchFn).not.toHaveBeenCalled();
  });

  it('refuses a wrong state, and never exchanges the code', async () => {
    const t = setup();
    await t.auth.signIn();
    await expect(t.auth.handleRedirect(`${REDIRECT}?code=stolen&state=forged`)).rejects.toThrow();
    expect(t.fetchFn).not.toHaveBeenCalled();
  });

  it('refuses a callback when no sign-in was started', async () => {
    const t = setup();
    await expect(t.auth.handleRedirect(`${REDIRECT}?code=c&state=s`)).rejects.toThrow();
    expect(t.fetchFn).not.toHaveBeenCalled();
  });

  it('accepts a state only once', async () => {
    const t = setup();
    await t.auth.signIn();
    const state = new URL(t.opened[0]!).searchParams.get('state');
    await t.auth.handleRedirect(`${REDIRECT}?code=c&state=${state}`);
    await expect(t.auth.handleRedirect(`${REDIRECT}?code=c&state=${state}`)).rejects.toThrow();
    expect(t.fetchFn).toHaveBeenCalledTimes(1);
  });

  it('reports a denied sign-in or a failed exchange without storing tokens', async () => {
    const t = setup(() => json(400, { error: 'invalid_grant' }));
    await t.auth.signIn();
    const state = new URL(t.opened[0]!).searchParams.get('state');
    await expect(t.auth.handleRedirect(`${REDIRECT}?error=access_denied&state=${state}`)).rejects.toThrow();
    await t.auth.signIn();
    const next = new URL(t.opened[1]!).searchParams.get('state');
    await expect(t.auth.handleRedirect(`${REDIRECT}?code=c&state=${next}`)).rejects.toThrow();
    await expect(t.auth.accessToken()).rejects.toMatchObject({ code: 'sign_in_expired' });
  });

  it('rejects a token response without an access token', async () => {
    const t = setup(() => json(200, { expires_in: 3600 }));
    await t.auth.signIn();
    const state = new URL(t.opened[0]!).searchParams.get('state');
    await expect(t.auth.handleRedirect(`${REDIRECT}?code=c&state=${state}`)).rejects.toThrow();
    await expect(t.auth.accessToken()).rejects.toMatchObject({ code: 'sign_in_expired' });
  });
});

describe('access tokens', () => {
  it('needs a sign-in first, without touching the network', async () => {
    const t = setup();
    await expect(t.auth.accessToken()).rejects.toMatchObject({ code: 'sign_in_expired' });
    expect(t.fetchFn).not.toHaveBeenCalled();
  });

  it('reuses a token that is still good', async () => {
    const t = setup();
    await signedIn(t);
    t.clock.set(NOW + 3000 * 1000);
    expect(await t.auth.accessToken()).toBe('access-1');
    expect(t.fetchFn).toHaveBeenCalledTimes(1);
  });

  it('refreshes shortly before expiry, keeping a refresh token the response leaves out', async () => {
    let n = 1;
    const t = setup((form) => (form.get('grant_type') === 'refresh_token' ? json(200, tokens(`access-${++n}`)) : json(200, tokens('access-1', { refresh_token: 'refresh-1' }))));
    await signedIn(t);
    t.clock.set(NOW + 3590 * 1000);
    expect(await t.auth.accessToken()).toBe('access-2');
    const form = t.forms[1]!;
    expect(form.get('grant_type')).toBe('refresh_token');
    expect(form.get('refresh_token')).toBe('refresh-1');
    expect(form.get('client_id')).toBe('client-1');

    t.clock.set(NOW + 2 * 3590 * 1000);
    expect(await t.auth.accessToken()).toBe('access-3');
    expect(t.forms[2]!.get('refresh_token')).toBe('refresh-1');
  });

  it('uses a rotated refresh token', async () => {
    const t = setup((form) =>
      form.get('grant_type') === 'refresh_token' ? json(200, tokens('access-2', { refresh_token: 'refresh-2' })) : json(200, tokens('access-1', { refresh_token: 'refresh-1' })),
    );
    await signedIn(t);
    await t.auth.accessToken({ refresh: true });
    await t.auth.accessToken({ refresh: true });
    expect(t.forms[2]!.get('refresh_token')).toBe('refresh-2');
  });

  it('refreshes once for callers that arrive together', async () => {
    const t = setup((form) => (form.get('grant_type') === 'refresh_token' ? json(200, tokens('access-2')) : json(200, tokens('access-1', { refresh_token: 'refresh-1' }))));
    await signedIn(t);
    t.clock.set(NOW + 4000 * 1000);
    expect(await Promise.all([t.auth.accessToken(), t.auth.accessToken()])).toEqual(['access-2', 'access-2']);
    expect(t.fetchFn).toHaveBeenCalledTimes(2);
  });

  it('forgets the tokens when the refresh token is refused', async () => {
    const t = setup((form) => (form.get('grant_type') === 'refresh_token' ? json(400, { error: 'invalid_grant' }) : json(200, tokens('access-1', { refresh_token: 'refresh-1' }))));
    await signedIn(t);
    t.clock.set(NOW + 4000 * 1000);
    await expect(t.auth.accessToken()).rejects.toMatchObject({ code: 'sign_in_expired' });
    const calls = t.fetchFn.mock.calls.length;
    await expect(t.auth.accessToken()).rejects.toMatchObject({ code: 'sign_in_expired' });
    expect(t.fetchFn).toHaveBeenCalledTimes(calls);
  });

  it('keeps the tokens through a network failure or server trouble, so a later try can still refresh', async () => {
    let mode: 'down' | 'broken' | 'up' = 'down';
    const t = setup((form) => {
      if (form.get('grant_type') !== 'refresh_token') return json(200, tokens('access-1', { refresh_token: 'refresh-1' }));
      if (mode === 'down') throw new TypeError('fetch failed');
      return mode === 'broken' ? json(503, {}) : json(200, tokens('access-2'));
    });
    await signedIn(t);
    t.clock.set(NOW + 4000 * 1000);
    await expect(t.auth.accessToken()).rejects.toMatchObject({ code: 'offline' });
    mode = 'broken';
    await expect(t.auth.accessToken()).rejects.toMatchObject({ code: 'error' });
    mode = 'up';
    expect(await t.auth.accessToken()).toBe('access-2');
  });

  it('expire forgets the tokens', async () => {
    const t = setup();
    await signedIn(t);
    await t.auth.expire();
    await expect(t.auth.accessToken()).rejects.toMatchObject({ code: 'sign_in_expired' });
  });

  it("knows the account's email from the ID token, through a refresh that leaves it out, until signing out", async () => {
    const idToken = `e30.${Buffer.from(JSON.stringify({ sub: 'user-a', email: 'reader@example.com' })).toString('base64url')}.sig`;
    const t = setup((form) =>
      form.get('grant_type') === 'refresh_token' ? json(200, tokens('access-2')) : json(200, tokens('access-1', { refresh_token: 'refresh-1', id_token: idToken })),
    );
    expect(await t.auth.email()).toBeNull();
    await signedIn(t);
    expect(await t.auth.email()).toBe('reader@example.com');
    await t.auth.accessToken({ refresh: true });
    expect(await t.auth.email()).toBe('reader@example.com');
    await t.auth.signOut();
    expect(await t.auth.email()).toBeNull();
  });
});

describe('signing out', () => {
  it('forgets the tokens, revokes the refresh token, and ends the sign-in page session so the next sign-in asks again', async () => {
    const t = setup();
    await signedIn(t);
    await t.auth.signOut();
    await expect(t.auth.accessToken()).rejects.toMatchObject({ code: 'sign_in_expired' });
    expect(t.revoked.map((f) => Object.fromEntries(f))).toEqual([{ token: 'refresh-1', client_id: 'client-1' }]);
    const logout = new URL(t.opened.at(-1)!);
    expect(logout.origin + logout.pathname).toBe('https://auth.example.test/logout');
    expect(Object.fromEntries(logout.searchParams)).toEqual({ client_id: 'client-1', logout_uri: REDIRECT });
    // The browser comes back to the app with nothing, which is not a sign-in.
    expect(await t.auth.handleRedirect(REDIRECT)).toBe(false);
  });

  it('still signs out when the revoke fails or the device is offline', async () => {
    for (const fail of [() => json(503, {}), () => { throw new TypeError('fetch failed'); }]) {
      const t = setup(undefined, fail);
      await signedIn(t);
      await t.auth.signOut();
      await expect(t.auth.accessToken()).rejects.toMatchObject({ code: 'sign_in_expired' });
    }
  });
});
