// Sign-in: the authorization code flow with PKCE, so no client secret ships in the app. The system browser does the
// sign-in and comes back through a deep link. Everything the device provides is passed in, and tokens only ever live
// in the token store it supplies. The sign-in in progress is stored there too, because the OS may end the app while
// the browser is in front.

import type { Clock } from './clock';
import { SyncError } from './sync';
import type { FetchFn } from './sync';

const SESSION_KEY = 'auth.session';
const PENDING_KEY = 'auth.pending';
/** A token this close to expiring could lapse on its way to the server. */
const EXPIRY_MARGIN_MS = 60_000;
const REQUEST_TIMEOUT_MS = 30_000;

interface Session {
  access_token: string;
  refresh_token: string | null;
  expires_at: number;
  /** From the ID token, to tell the person which account they signed in as. */
  email?: string | null;
}

export interface AuthDeps {
  /** The identity provider's base URL. */
  authUrl: string;
  clientId: string;
  redirectUri: string;
  clock: Clock;
  tokens: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
    remove(key: string): Promise<void>;
  };
  openExternal(url: string): Promise<void>;
  fetch: FetchFn;
}

const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const randomString = () => base64url(crypto.getRandomValues(new Uint8Array(32)));

/** A text claim from a token, or null if it can't be read. Not verified: the server checks every token. */
function claim(token: string, name: string): string | null {
  try {
    const payload = token.split('.')[1] ?? '';
    const value = (JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as Record<string, unknown> | null)?.[name];
    return typeof value === 'string' && value ? value : null;
  } catch {
    return null;
  }
}

/** The user an access token names, from its sub claim. This only tells one account's sign-in from another's on this device. */
export const tokenSubject = (token: string): string | null => claim(token, 'sub');

export function createAuth(deps: AuthDeps) {
  const { tokens, clock } = deps;
  let refreshing: Promise<string> | null = null;

  const readSession = async () => {
    const stored = await tokens.get(SESSION_KEY);
    return stored ? (JSON.parse(stored) as Session) : null;
  };

  const expire = () => tokens.remove(SESSION_KEY);

  /** Stores what the token endpoint returned, or throws with the response's status for the caller to judge. */
  async function requestTokens(form: Record<string, string>, previous: Session | null): Promise<string> {
    let res: Response;
    try {
      res = await deps.fetch(`${deps.authUrl}/oauth2/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: deps.clientId, ...form }).toString(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new SyncError('offline');
    }
    if (res.status === 400 || res.status === 401) throw new SyncError('sign_in_expired');
    if (!res.ok) throw new SyncError('error');
    const body = (await res.json().catch(() => null)) as { access_token?: unknown; refresh_token?: unknown; id_token?: unknown; expires_in?: unknown } | null;
    if (typeof body?.access_token !== 'string' || !body.access_token || typeof body.expires_in !== 'number') throw new SyncError('error');
    const session: Session = {
      access_token: body.access_token,
      // The refresh grant usually leaves these out, and the existing ones stay good.
      refresh_token: typeof body.refresh_token === 'string' ? body.refresh_token : (previous?.refresh_token ?? null),
      expires_at: clock.now() + body.expires_in * 1000,
      email: (typeof body.id_token === 'string' ? claim(body.id_token, 'email') : null) ?? previous?.email ?? null,
    };
    await tokens.set(SESSION_KEY, JSON.stringify(session));
    return session.access_token;
  }

  async function refresh(session: Session): Promise<string> {
    if (!session.refresh_token) {
      await expire();
      throw new SyncError('sign_in_expired');
    }
    try {
      return await requestTokens({ grant_type: 'refresh_token', refresh_token: session.refresh_token }, session);
    } catch (err) {
      // Only a refused token ends the session: being offline must not sign anyone out.
      if (err instanceof SyncError && err.code === 'sign_in_expired') await expire();
      throw err;
    }
  }

  return {
    /** Sends the user to the browser. The result arrives later through handleRedirect. */
    async signIn(): Promise<void> {
      const verifier = randomString();
      const state = randomString();
      await tokens.set(PENDING_KEY, JSON.stringify({ verifier, state }));
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
      const query = new URLSearchParams({
        response_type: 'code',
        client_id: deps.clientId,
        redirect_uri: deps.redirectUri,
        scope: 'openid',
        state,
        code_challenge: base64url(new Uint8Array(digest)),
        code_challenge_method: 'S256',
      });
      await deps.openExternal(`${deps.authUrl}/oauth2/authorize?${query}`);
    },

    /** Finishes a sign-in from a deep link. False if the link is something else; throws if the sign-in failed. */
    async handleRedirect(url: string): Promise<boolean> {
      const [target, queryString] = url.split('?', 2);
      // With nothing on it, it's the browser coming back from signOut.
      if (target !== deps.redirectUri || !queryString) return false;
      const query = new URLSearchParams(queryString?.split('#')[0]);
      const stored = await tokens.get(PENDING_KEY);
      const pending = stored ? (JSON.parse(stored) as { verifier: string; state: string }) : null;
      // The state proves this callback answers the sign-in started here, not one forged by another app or page.
      if (!pending || query.get('state') !== pending.state) throw new Error('Sign-in callback does not match a sign-in in progress');
      await tokens.remove(PENDING_KEY);
      const code = query.get('code');
      if (!code) throw new Error('Sign-in was not completed');
      await requestTokens({ grant_type: 'authorization_code', code, code_verifier: pending.verifier, redirect_uri: deps.redirectUri }, null);
      return true;
    },

    /** A usable access token, refreshed if needed. Throws SyncError: sign_in_expired, offline or error. */
    async accessToken(options: { refresh?: boolean } = {}): Promise<string> {
      const session = await readSession();
      if (!session) throw new SyncError('sign_in_expired');
      if (!options.refresh && session.expires_at - EXPIRY_MARGIN_MS > clock.now()) return session.access_token;
      refreshing ??= refresh(session).finally(() => {
        refreshing = null;
      });
      return refreshing;
    },

    /** The signed-in account's email, or null when signed out or the identity provider didn't say. */
    email: async () => (await readSession())?.email ?? null,

    /** Forgets the tokens. Local data stays. */
    expire,

    /**
     * Forgets the tokens, ends the sign-in page's own session in the browser so the next sign-in asks again, possibly
     * for another account, and revokes the refresh token so no copy of it still works. Local data stays.
     * shortcut: offline, the revoke is skipped and the refresh token stays good until it lapses; queue it for the next
     * time online if that matters.
     */
    async signOut(): Promise<void> {
      const session = await readSession();
      await expire();
      const logout = new URLSearchParams({ client_id: deps.clientId, logout_uri: deps.redirectUri });
      await deps.openExternal(`${deps.authUrl}/logout?${logout}`).catch(() => undefined);
      if (!session?.refresh_token) return;
      await deps
        .fetch(`${deps.authUrl}/oauth2/revoke`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token: session.refresh_token, client_id: deps.clientId }).toString(),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
        .catch(() => undefined);
    },
  };
}
