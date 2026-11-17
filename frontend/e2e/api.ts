import type { BrowserContext, Page } from '@playwright/test';

/** An OpenTelemetry event as the app sent it, with its attributes' values unwrapped. */
export interface SentEvent {
  name: string;
  attributes: Record<string, string | number | boolean>;
}

type OtlpValue = { stringValue?: string; intValue?: string | number; doubleValue?: number; boolValue?: boolean };

function sentEvents(body: string | null): SentEvent[] {
  const logs = JSON.parse(body ?? '{}') as {
    resourceLogs?: { scopeLogs?: { logRecords?: { eventName?: string; attributes?: { key: string; value: OtlpValue }[] }[] }[] }[];
  };
  return (logs.resourceLogs ?? []).flatMap((resource) =>
    (resource.scopeLogs ?? []).flatMap((scope) =>
      (scope.logRecords ?? []).map((record) => ({
        name: record.eventName ?? '',
        attributes: Object.fromEntries(
          (record.attributes ?? []).map(({ key, value }) => [key, value.intValue !== undefined ? Number(value.intValue) : (value.doubleValue ?? value.boolValue ?? value.stringValue ?? '')]),
        ),
      })),
    ),
  );
}

/**
 * A stand-in for the API, on its own origin as the real one is, with nothing new for each sync. It counts the syncs and
 * keeps the telemetry the app sends.
 */
export async function standInApi(context: BrowserContext, baseURL: string) {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type' };
  const api = { syncs: 0, events: [] as SentEvent[] };
  await context.route(
    (url) => url.origin !== new URL(baseURL).origin,
    (route) => {
      const request = route.request();
      if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      if (request.url().endsWith('/v1/logs')) {
        api.events.push(...sentEvents(request.postData()));
        return route.fulfill({ headers: cors, contentType: 'application/json', body: '{}' });
      }
      if (request.url().endsWith('/sync')) api.syncs++;
      return route.fulfill({ headers: cors, contentType: 'application/json', body: JSON.stringify({ cursor: 0, more: false, changes: [] }) });
    },
  );
  return api;
}

/** Signs the browser build in as the account the token names, as a sign-in leaves it. It holds from the next load. */
export async function signIn(page: Page): Promise<void> {
  const token = ['e30', Buffer.from(JSON.stringify({ sub: 'e2e-user' })).toString('base64url'), 'signature'].join('.');
  await page.evaluate(async (accessToken) => {
    // A day from the page's own clock, which a test may have set.
    const session = JSON.stringify({ access_token: accessToken, refresh_token: null, expires_at: Date.now() + 86_400_000 });
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open('multiscale-dev', 1);
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction('files', 'readwrite');
      tx.objectStore('files').put(session, 'token:auth.session');
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }, token);
}
