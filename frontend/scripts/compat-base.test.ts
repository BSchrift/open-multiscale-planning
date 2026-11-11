import { describe, expect, it } from 'vitest';
import { oldestLive } from './compat-base';

const WEB = 'https://app.example.test';
const RELEASE = 'https://release.example.test';
const page = (version: string, build: number) => JSON.stringify({ version, build, shell: {} });
const feed = (version: string, build: number) => JSON.stringify({ manifest: JSON.stringify({ version, build, shell: {}, files: [] }), signature: 'x' });

function host(bodies: Record<string, string>) {
  const asked: string[] = [];
  const fetch = (async (url: string | URL | Request) => {
    asked.push(String(url));
    const body = bodies[String(url)];
    return new Response(body ?? 'missing', { status: body === undefined ? 403 : 200 });
  }) as typeof globalThis.fetch;
  return { fetch, asked };
}

describe('oldestLive', () => {
  it('picks the oldest version any surface serves, by build', async () => {
    const { fetch, asked } = host({
      [`${WEB}/version.json`]: page('0.1.0-ccccccc', 300),
      [`${RELEASE}/desktop/release.json`]: feed('0.1.0-bbbbbbb', 200),
      [`${RELEASE}/iphone/release.json`]: feed('0.1.0-aaaaaaa', 100),
      [`${RELEASE}/release.json`]: feed('0.1.0-bbbbbbb', 200),
    });
    expect(await oldestLive({ WebUrl: WEB, ReleaseUrl: RELEASE }, fetch)).toEqual({ version: '0.1.0-aaaaaaa', build: 100, surface: 'iphone' });
    expect(asked).toEqual([`${WEB}/version.json`, `${RELEASE}/desktop/release.json`, `${RELEASE}/iphone/release.json`, `${RELEASE}/release.json`]);
  });

  it('leaves out a feed that is missing, and an environment with no release host', async () => {
    const { fetch } = host({ [`${WEB}/version.json`]: page('0.1.0-ccccccc', 300), [`${RELEASE}/release.json`]: feed('0.1.0-bbbbbbb', 200) });
    expect(await oldestLive({ WebUrl: WEB, ReleaseUrl: RELEASE }, fetch)).toMatchObject({ version: '0.1.0-bbbbbbb', surface: 'shared' });
    expect(await oldestLive({ WebUrl: WEB }, fetch)).toMatchObject({ version: '0.1.0-ccccccc', surface: 'web' });
  });

  it("fails when web's version can't be read, as the one surface every release has", async () => {
    const { fetch } = host({ [`${RELEASE}/release.json`]: feed('0.1.0-bbbbbbb', 200) });
    await expect(oldestLive({ WebUrl: WEB, ReleaseUrl: RELEASE }, fetch)).rejects.toThrow(/version\.json/);
    await expect(oldestLive({}, fetch)).rejects.toThrow(/WebUrl/);
  });
});
