import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { fakeBuild, makeIdentity, trustOf } from './fake-mac-build';
import type { FakeBuild } from './fake-mac-build';
import { buildConfig, nativeSources, notarizations, parsePlist, readManifest, unpackConfig, verifyInbox, writeManifest } from './mac-inbox';
import type { Manifest } from './mac-inbox';
import { SHELL_SOURCES } from './shell-hash';

const TEAM = 'TEAMID0001';
const COMMIT = 'c0ffee'.padEnd(40, '0');
const identity = makeIdentity(TEAM);

const manifest: Manifest = {
  commit: COMMIT,
  env: 'prod',
  version: '0.1.0-c0ffee0',
  build: 1700000000,
  electron: '45.2.1',
  shell: '0123456789abcdef',
  files: { 'Multiscale.dmg': { sha256: 'a'.repeat(64), size: 100 }, 'app.asar': { sha256: 'b'.repeat(64), size: 50 } },
  notarizations: [{ id: 'a1b2c3d4-0000-4000-8000-000000000001', name: 'Multiscale.zip', status: 'Accepted' }],
};

describe('the inbox manifest', () => {
  it('reads back what was written', () => {
    expect(readManifest(writeManifest(manifest))).toEqual(manifest);
  });

  it('names what is wrong with a manifest it refuses', () => {
    const bad = (change: object) => () => readManifest(JSON.stringify({ ...manifest, ...change }));
    expect(() => readManifest('{')).toThrow('not JSON');
    expect(bad({ commit: 'c0ffee' })).toThrow("commit is not a full commit hash");
    expect(bad({ env: 'local' })).toThrow('env is not staging or prod');
    expect(bad({ shell: 'x' })).toThrow('shell is not a shell hash');
    expect(bad({ files: { 'Multiscale.dmg': manifest.files['Multiscale.dmg'] } })).toThrow("files lack app.asar's SHA-256");
    expect(bad({ notarizations: [] })).toThrow('notarizations are missing');
    expect(() => writeManifest({ ...manifest, build: 1.5 })).toThrow('build is not a whole number');
  });

  it("keeps the build's notary submissions from notarytool's history, and needs one accepted", () => {
    const history = JSON.stringify({
      history: [
        { id: 'new-dmg', name: 'Multiscale-0.1.0-arm64.dmg', status: 'Accepted', createdDate: '2026-11-09T10:05:00.000Z' },
        { id: 'new-app', name: 'Multiscale.zip', status: 'Accepted', createdDate: '2026-11-09T10:01:00.000Z' },
        { id: 'old', name: 'Multiscale.zip', status: 'Accepted', createdDate: '2026-11-08T10:00:00.000Z' },
      ],
    });
    expect(notarizations(history, new Date('2026-11-09T10:00:00Z')).map((n) => n.id)).toEqual(['new-dmg', 'new-app']);
    expect(() => notarizations(history, new Date('2026-11-10T00:00:00Z'))).toThrow('accepted nothing');
  });
});

describe('verifyInbox', () => {
  const verify = (b: FakeBuild, { commit = COMMIT, ticket = true, trust = trustOf(identity) } = {}) =>
    verifyInbox(b.inbox, { env: 'staging', commit, teamId: TEAM, ...b.build }, {
      extract: (_dmg, into) => cpSync(b.volume, into, { recursive: true }),
      hasTicket: async () => ticket,
      trust,
    });
  const good = () => fakeBuild(identity, TEAM, COMMIT, 'staging');

  it('passes a build signed by the team, notarized, and holding the pipeline\'s own build of the commit', async () => {
    expect(await verify(good())).toEqual([]);
  });

  it('refuses a build of another commit before reading anything else', async () => {
    expect(await verify(good(), { commit: 'd'.repeat(40) })).toEqual([`The inbox build is of commit ${COMMIT}, but this run releases ${'d'.repeat(40)}`]);
  });

  it('refuses a disk image that is not the one its manifest describes', async () => {
    const b = good();
    writeFileSync(join(b.inbox, 'Multiscale.dmg'), 'other');
    expect(await verify(b)).toEqual(["Multiscale.dmg's SHA-256 doesn't match its manifest"]);
  });

  it('refuses an app whose JavaScript differs from the pipeline\'s build, or adds to it', async () => {
    const tampered = fakeBuild(identity, TEAM, COMMIT, 'staging', (files) => {
      files['dist-electron/main.cjs'] = Buffer.from('require("child_process")');
      files['dist/extra.js'] = Buffer.from('1');
    });
    expect(await verify(tampered)).toEqual([
      "app.asar holds dist/extra.js, which the pipeline's build doesn't",
      "dist-electron/main.cjs differs from the pipeline's build",
      "The build's settings differ: MAC_BUILD_CONFIG may be out of date. See docs/releasing.md.",
    ]);
  });

  it('refuses an app missing a file, or with an unpacked file app.asar doesn\'t list', async () => {
    const b = fakeBuild(identity, TEAM, COMMIT, 'staging', (files) => delete files['dist/index.html']);
    writeFileSync(join(b.app, 'Contents/Resources/app.asar.unpacked/extra.js'), '1');
    const problems = await verify(b);
    expect(problems).toContain('app.asar lacks dist/index.html');
    expect(problems).toContain("app.asar.unpacked holds extra.js, which app.asar doesn't list");
    expect(problems).toContain("The app's code signature doesn't seal Resources/app.asar.unpacked/extra.js as it is");
  });

  it("refuses a package.json that loads differently from the pipeline's, though electron-builder may trim one", async () => {
    const b = fakeBuild(identity, TEAM, COMMIT, 'staging', (files) => {
      files['package.json'] = Buffer.from(JSON.stringify({ name: 'multiscale', main: 'dist/assets/index-abc.js' }));
    });
    writeFileSync(join(b.app, 'Contents/Resources/app.asar.unpacked/node_modules/better-sqlite3/package.json'), '{"name":"better-sqlite3","main":"lib/other.js"}');
    const problems = await verify(b);
    expect(problems).toContain("package.json in app.asar differs from the pipeline's in main");
    expect(problems).toContain("package.json in app.asar differs from the pipeline's in type");
    expect(problems).toContain("node_modules/better-sqlite3/package.json in app.asar differs from the pipeline's in main");
  });

  it('refuses an app changed after it was signed', async () => {
    const b = good();
    const asar = join(b.app, 'Contents/Resources/app.asar');
    const data = readFileSync(asar);
    data[data.length - 1]! ^= 1;
    writeFileSync(asar, data);
    const problems = await verify(b);
    expect(problems).toContain("The app's code signature doesn't seal Resources/app.asar as it is");
  });

  it('refuses a signature from outside the trusted Developer ID chain, or for another team', async () => {
    const stranger = makeIdentity(TEAM);
    const b = fakeBuild(stranger, TEAM, COMMIT, 'staging');
    expect(await verify(b)).toEqual([
      "The disk image: The signing certificate isn't issued by Apple's Developer ID CA",
      "The app: The signing certificate isn't issued by Apple's Developer ID CA",
    ]);
    const otherTeam = fakeBuild(identity, 'OTHERTEAM1', COMMIT, 'staging');
    expect(await verify(otherTeam)).toContain('The app is signed for team OTHERTEAM1, not the configured team');
  });

  it('refuses a build Apple has no notarization ticket for', async () => {
    const problems = await verify(good(), { ticket: false });
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/^The disk image has no notarization ticket from Apple for its cdhash, [0-9a-f]{40}$/);
    expect(problems[1]).toMatch(/^The app has no notarization ticket from Apple for its cdhash, [0-9a-f]{40}$/);
  });

  it('refuses an inbox without a manifest it can read', async () => {
    const b = good();
    writeFileSync(join(b.inbox, 'manifest.json'), '{}');
    expect(await verify(b)).toEqual(["The inbox manifest's commit is not a full commit hash"]);
  });
});

describe('parsePlist', () => {
  it('reads the values Info.plist and CodeResources hold', () => {
    const plist = parsePlist(`<?xml version="1.0"?>\n<!DOCTYPE plist>\n<plist version="1.0"><dict>
      <key>a &amp; b</key><string>x &lt; y</string><key>n</key><integer>3</integer><key>t</key><true/>
      <key>d</key><data>aGk=</data><key>l</key><array><string>1</string><dict/></array><key>e</key><string/>
    </dict></plist>`);
    expect(plist).toEqual({ 'a & b': 'x < y', n: 3, t: true, d: Buffer.from('hi'), l: ['1', {}], e: '' });
    expect(() => parsePlist('bplist00')).toThrow('binary property list');
  });
});

describe('the build config for GitHub Actions', () => {
  it("takes from the config folder only what the Mac build reads, and hides its addresses from the run's log", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mac-config-'));
    for (const env of ['staging', 'prod']) {
      writeFileSync(join(dir, `${env}.outputs.json`), JSON.stringify({ ApiUrl: `https://api.${env}.example.net`, CognitoDomain: `https://auth.${env}.example.net`, AppClientId: 'client', ReleaseBucket: 'private-bucket' }));
      writeFileSync(join(dir, `${env}.yaml`), `aws:\n  account: "123456789012"\napp:\n  bundleId: net.example.multiscale\n`);
      writeFileSync(join(dir, `${env}.release-key.pub`), 'cHVibGlj');
    }
    const files = await buildConfig(dir);
    expect(JSON.stringify(files)).not.toMatch(/123456789012|private-bucket/);
    const out = mkdtempSync(join(tmpdir(), 'mac-unpacked-'));
    const hidden = unpackConfig(Buffer.from(JSON.stringify({ ...files, 'control.yaml': 'not written' })).toString('base64'), out);
    expect(JSON.parse(readFileSync(join(out, 'prod.outputs.json'), 'utf8'))).toEqual({ ApiUrl: 'https://api.prod.example.net', CognitoDomain: 'https://auth.prod.example.net', AppClientId: 'client' });
    expect(parse(readFileSync(join(out, 'staging.yaml'), 'utf8'))).toEqual({ app: { bundleId: 'net.example.multiscale' } });
    expect(readFileSync(join(out, 'staging.release-key.pub'), 'utf8')).toBe('cHVibGlj');
    expect(() => readFileSync(join(out, 'control.yaml'))).toThrow();
    expect(hidden).toEqual(expect.arrayContaining(['https://api.prod.example.net', 'api.prod.example.net', 'client', 'net.example.multiscale']));
    expect(() => unpackConfig(Buffer.from('{}').toString('base64'), out)).toThrow('MAC_BUILD_CONFIG lacks staging.outputs.json');
  });
});

describe('nativeSources', () => {
  it("changes with the files the Mac app's shell hash covers and its native packages, and nothing else", () => {
    const repo = mkdtempSync(join(tmpdir(), 'native-'));
    const frontend = join(repo, 'frontend');
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
    git('init', '-q');
    const commit = (files: Record<string, string>) => {
      for (const [path, text] of Object.entries(files)) {
        mkdirSync(join(repo, path, '..'), { recursive: true });
        writeFileSync(join(repo, path), text);
      }
      git('add', '-A');
      git('-c', 'user.email=t@example.net', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'c');
      return nativeSources(git('rev-parse', 'HEAD'), frontend);
    };
    const lock = (electron: string, react: string) => JSON.stringify({ packages: { 'node_modules/electron': { version: electron }, 'node_modules/react': { version: react } } });
    const first = commit({ 'frontend/electron/main.ts': '1', 'frontend/src/ui/App.tsx': '1', 'frontend/package-lock.json': lock('45.0.0', '19.0.0') });
    expect(commit({ 'frontend/src/ui/App.tsx': '2', 'frontend/electron/main.test.ts': '2', 'frontend/package-lock.json': lock('45.0.0', '19.1.0') })).toBe(first);
    expect(commit({ 'frontend/package-lock.json': lock('45.1.0', '19.1.0') })).not.toBe(first);
    const second = commit({ 'frontend/src/core/captureTitle.ts': '1' });
    expect(commit({ 'frontend/electron/main.ts': '2' })).not.toBe(second);
  }, 30_000);
});

describe('the Mac release workflow', () => {
  const workflow = parse(readFileSync(join(import.meta.dirname, '../../.github/workflows/mac-release.yml'), 'utf8')) as {
    on: Record<string, { paths?: string[] }>;
    permissions: object;
    jobs: Record<string, { environment?: string; steps: { uses?: string }[] }>;
  };

  it("starts for pushes that change what the Mac app's shell hash covers, and never for pull requests", () => {
    expect(workflow.on.push!.paths!.sort()).toEqual([...SHELL_SOURCES.electron.paths.map((p) => (p.includes('.') ? `frontend/${p}` : `frontend/${p}/**`)), 'frontend/package-lock.json'].sort());
    expect(Object.keys(workflow.on).sort()).toEqual(['push', 'workflow_dispatch']);
    expect(workflow.permissions).toEqual({});
  });

  it('signs only in the release environment, with official actions pinned by commit', () => {
    expect(Object.values(workflow.jobs).filter((job) => job.environment).map((job) => job.environment)).toEqual(['release']);
    for (const step of Object.values(workflow.jobs).flatMap((job) => job.steps)) {
      if (step.uses) expect(step.uses).toMatch(/^(actions|aws-actions)\/[\w-]+@[0-9a-f]{40}$/);
    }
  });
});
