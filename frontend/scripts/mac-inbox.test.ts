import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { APP_VERSION, BUILD, fakeBuild, file, link, linkedMachO, makeIdentity, OUR_FUSES, signMachO, trustOf, writeApp, writeZip, zipOf } from './fake-mac-build';
import type { FakeBuild } from './fake-mac-build';
import { appRecord, appVersion, buildConfig, liveRecord, notarizations, parsePlist, readManifest, readZip, unpackConfig, verifyInbox, writeManifest } from './mac-inbox';
import type { Manifest } from './mac-inbox';

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
  appVersion: '0.1.1700000000',
  files: { 'Multiscale.dmg': { sha256: 'a'.repeat(64), size: 100 }, 'Multiscale.zip': { sha256: 'c'.repeat(64), size: 90 }, 'app.asar': { sha256: 'b'.repeat(64), size: 50 } },
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
    expect(bad({ files: { 'Multiscale.dmg': manifest.files['Multiscale.dmg'], 'app.asar': manifest.files['app.asar'] } })).toThrow("files lack Multiscale.zip's SHA-256");
    expect(bad({ appVersion: '0.1.0-c0ffee0' })).toThrow('appVersion is not a version');
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
    verifyInbox(b.inbox, { env: 'staging', commit, teamId: TEAM, identity: b.identity, ...b.build }, {
      extract: (_dmg, into) => cpSync(b.volume, into, { recursive: true, verbatimSymlinks: true }),
      hasTicket: async () => ticket,
      trust,
      electron: b.electron,
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

  describe('the zip the app updates itself from', () => {
    const MAIN = 'Contents/MacOS/Multiscale Staging';
    const LINK = 'Contents/Frameworks/Electron Framework.framework/Electron Framework';

    it('refuses a file more, less or changed than the disk image holds', async () => {
      const b = good();
      const tree = new Map(b.tree);
      tree.set('Contents/Resources/extra.txt', file('1'));
      tree.delete('Contents/Resources/en.lproj/locale.pak');
      tree.set('Contents/PkgInfo', file('APPLMSCL'));
      writeZip(b, tree);
      expect(await verify(b)).toEqual([
        "The zip's Contents/PkgInfo differs from the disk image's",
        "The zip holds Contents/Resources/extra.txt, which the disk image's app doesn't",
        "The zip lacks Contents/Resources/en.lproj/locale.pak, which the disk image's app holds",
      ]);
    });

    it('refuses a link that became a copy of what it points to, or that points out of the app', async () => {
      const copied = good();
      const tree = new Map(copied.tree);
      tree.set(LINK, file(tree.get('Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework')!.data, 0o755));
      writeZip(copied, tree);
      expect(await verify(copied)).toEqual([`The zip's ${LINK} is a file, but the disk image's is a link`]);
      const outside = good();
      outside.tree.set('Contents/Resources/escape', link('../../../../../etc/passwd'));
      writeApp(outside);
      expect(await verify(outside)).toContain('The zip\'s Contents/Resources/escape links outside the app, to ../../../../../etc/passwd');
    });

    it('refuses a file that lost its execute bit', async () => {
      const b = good();
      const tree = new Map(b.tree);
      tree.set(MAIN, { ...tree.get(MAIN)!, mode: 0o644 });
      writeZip(b, tree);
      expect(await verify(b)).toEqual([`The zip's ${MAIN} has mode 644, not 755 as Electron's has`]);
    });

    it('refuses a zip with a name twice, an absolute or .. path, or a local header unlike its central directory', async () => {
      const at = (path: string) => [path, file('x')] as [string, ReturnType<typeof file>];
      expect(() => readZip(zipOf([at('a/b'), at('a/b')]))).toThrow('The zip holds a/b twice');
      expect(() => readZip(zipOf([at('/etc/passwd')]))).toThrow('which is not a plain relative path');
      expect(() => readZip(zipOf([at('a/../../b')]))).toThrow('which is not a plain relative path');
      const zip = zipOf([at('a/b')]);
      zip[30] = 'c'.charCodeAt(0);
      expect(() => readZip(zip)).toThrow('has a local header for a/b that disagrees with its central directory');
      const b = good();
      writeFileSync(join(b.inbox, 'Multiscale.zip'), zipOf([at('Multiscale Staging.app/x'), at('Multiscale Staging.app/x')]));
      const manifestFile = JSON.parse(readFileSync(join(b.inbox, 'manifest.json'), 'utf8')) as Manifest;
      manifestFile.files['Multiscale.zip'] = { sha256: createHash('sha256').update(readFileSync(join(b.inbox, 'Multiscale.zip'))).digest('hex'), size: 0 };
      writeFileSync(join(b.inbox, 'manifest.json'), JSON.stringify(manifestFile));
      expect(await verify(b)).toContain('The zip holds Multiscale Staging.app/x twice');
    });

    it('refuses a zip that is not the one its manifest describes', async () => {
      const b = good();
      writeFileSync(join(b.inbox, 'Multiscale.zip'), 'other');
      expect(await verify(b)).toEqual(["Multiscale.zip's SHA-256 doesn't match its manifest"]);
    });
  });

  describe("the app's native code", () => {
    const FRAMEWORK = 'Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework';
    const change = (b: FakeBuild, path: string, edit: (data: Buffer) => Buffer) => {
      b.tree.set(path, { ...b.tree.get(path)!, data: edit(Buffer.from(b.tree.get(path)!.data)) });
      writeApp(b);
    };

    it("passes Electron's and better-sqlite3's own binaries signed again, with the fuses the build sets", async () => {
      expect(await verify(good())).toEqual([]);
    });

    it('refuses a binary with one byte changed, or one Electron has not got', async () => {
      const changed = good();
      change(changed, FRAMEWORK, (data) => {
        data[300]! ^= 1;
        return data;
      });
      expect(await verify(changed)).toEqual([`${FRAMEWORK} isn't Electron's own`]);
      const added = good();
      added.tree.set('Contents/Frameworks/Extra.dylib', file(signMachO(linkedMachO(Buffer.from('extra')), identity, TEAM), 0o755));
      writeApp(added);
      expect(await verify(added)).toEqual(["The app holds Contents/Frameworks/Extra.dylib, which Electron's app doesn't"]);
    });

    it('refuses a fuse set otherwise than the build sets it, though the fuse bytes are left out of the comparison', async () => {
      const b = good();
      change(b, FRAMEWORK, (data) => {
        data.write('1', data.indexOf(OUR_FUSES, 0, 'latin1'), 'latin1');
        return signMachO(data, identity, TEAM);
      });
      expect(await verify(b)).toEqual([`${FRAMEWORK} has the fuses 100011011, not 000011011 as the build sets them`]);
    });

    it("refuses better-sqlite3 binaries that aren't the installed package's", async () => {
      const b = good();
      const node = 'Contents/Resources/app.asar.unpacked/node_modules/better-sqlite3/prebuilds/darwin-x64.node';
      change(b, node, () => signMachO(linkedMachO(Buffer.from('other sqlite')), identity, TEAM));
      expect(await verify(b)).toContain(`${node} isn't better-sqlite3's own`);
    });

    it("refuses an app missing one of Electron's files", async () => {
      const b = good();
      b.tree.delete('Contents/Resources/en.lproj/locale.pak');
      writeApp(b);
      expect(await verify(b)).toEqual(["The app lacks Electron's Contents/Resources/en.lproj/locale.pak"]);
    });

    it('refuses an Info.plist with a key electron-builder does not write, or another version', async () => {
      const b = good();
      change(b, 'Contents/Frameworks/Multiscale Staging Helper (GPU).app/Contents/Info.plist', (data) => Buffer.from(data.toString().replace('<dict>', '<dict>\n<key>LSEnvironment</key>\n<string>x</string>')));
      change(b, 'Contents/Info.plist', (data) => Buffer.from(data.toString().replace(`<string>${APP_VERSION}</string>`, '<string>0.1.0</string>')));
      const problems = await verify(b);
      expect(problems).toContain(`Contents/Info.plist has CFBundleShortVersionString "0.1.0", not "${APP_VERSION}"`);
      expect(problems).toContain('Contents/Frameworks/Multiscale Staging Helper (GPU).app/Contents/Info.plist has LSEnvironment "x", not as Electron has it');
    });

    it("refuses an app whose package.json doesn't say the version 0.1.<build>", async () => {
      const b = fakeBuild(identity, TEAM, COMMIT, 'staging', (files) => {
        files['package.json'] = Buffer.from(files['package.json']!.toString().replace(APP_VERSION, '0.1.0'));
      });
      expect(await verify(b)).toContain(`package.json in app.asar says version 0.1.0, not ${APP_VERSION}`);
    });
  });

  it('names the checked app in a record: its version, build, native code, folder, zip, SHA-512 and size', () => {
    const b = good();
    const zip = readFileSync(join(b.inbox, 'Multiscale.zip'));
    const record = appRecord(b.inbox);
    expect(record).toEqual({
      version: APP_VERSION, build: BUILD, shell: '0123456789abcdef', folder: `mac/${APP_VERSION}/`, file: 'Multiscale.zip',
      sha512: createHash('sha512').update(zip).digest('base64'), size: zip.length,
    });
    // The live app's record, once a release has published one with it; none from before records.
    expect(liveRecord(JSON.stringify({ ...JSON.parse(readFileSync(join(b.inbox, 'manifest.json'), 'utf8')), record }))).toEqual(record);
    expect(liveRecord(JSON.stringify({ commit: COMMIT }))).toBeNull();
    expect(liveRecord('')).toBeNull();
  });

  it('refuses an inbox without a manifest it can read', async () => {
    const b = good();
    writeFileSync(join(b.inbox, 'manifest.json'), '{}');
    expect(await verify(b)).toEqual(["The inbox manifest's commit is not a full commit hash"]);
  });
});

describe('appVersion', () => {
  it("is the package's major and minor, then the build", () => {
    expect(appVersion('0.1.0', 1794000000)).toBe('0.1.1794000000');
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

  // Otherwise the Mac app GitHub Actions builds differs from the pipeline's, as it did once attachments added FilesUrl.
  it('loads to the same app config as the folder it was made from, with every output the build reads', async () => {
    const { loadAppConfig } = await import('../src/core/appConfig');
    const dir = mkdtempSync(join(tmpdir(), 'mac-config-'));
    for (const env of ['staging', 'prod']) {
      writeFileSync(join(dir, `${env}.outputs.json`), JSON.stringify({
        ApiUrl: `https://api.${env}.example.net`, CognitoDomain: `https://auth.${env}.example.net`, AppClientId: 'client',
        ReleaseUrl: `https://release.${env}.example.net`, DownloadsUrl: `https://downloads.${env}.example.net`,
        FilesUrl: `https://files.${env}.example.net`, FilesUploadUrl: `https://upload.${env}.example.net`, ReleaseBucket: 'private-bucket',
      }));
      writeFileSync(join(dir, `${env}.yaml`), `aws:\n  account: "123456789012"\napp:\n  bundleId: net.example.multiscale\n`);
      writeFileSync(join(dir, `${env}.release-key.pub`), 'cHVibGlj');
    }
    const out = mkdtempSync(join(tmpdir(), 'mac-unpacked-'));
    unpackConfig(Buffer.from(JSON.stringify(await buildConfig(dir))).toString('base64'), out);
    const read = (path: string) => { try { return readFileSync(path, 'utf8'); } catch { return null; } };
    for (const env of ['staging', 'prod']) expect(loadAppConfig(env, read, out)).toEqual(loadAppConfig(env, read, dir));
  });
});

describe('the Mac release workflow', () => {
  const workflow = parse(readFileSync(join(import.meta.dirname, '../../.github/workflows/mac-release.yml'), 'utf8')) as {
    on: Record<string, object>;
    permissions: object;
    jobs: Record<string, { environment?: string; steps: { uses?: string }[] }>;
  };

  // Every push, so the app is in the inbox whenever the pipeline needs one, as when the downloads host serves none it checked.
  it('starts for every push to main, and never for pull requests', () => {
    expect(workflow.on.push).toEqual({ branches: ['main'] });
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
