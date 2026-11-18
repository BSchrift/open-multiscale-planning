import { describe, expect, it } from 'vitest';
import { appFilePath, cleanCapture, contentSecurityPolicy, isDeepLink, isExternalUrl, isOwnDbSql, isSqlValues, isWebUrl, menuItems } from './security';

describe('appFilePath', () => {
  it('maps paths inside the root, with / as the page', () => {
    expect(appFilePath('/app/dist', '/')).toBe('/app/dist/index.html');
    expect(appFilePath('/app/dist', '/assets/a%20b.js')).toBe('/app/dist/assets/a b.js');
  });

  it('refuses to leave the root', () => {
    expect(appFilePath('/app/dist', '/../secret')).toBeNull();
    expect(appFilePath('/app/dist', '/%2e%2e/secret')).toBeNull();
    expect(appFilePath('/app/dist', '/..%2fsecret')).toBeNull();
    expect(appFilePath('/app/dist', '/assets/%zz')).toBeNull();
  });
});

describe('isWebUrl', () => {
  it('only lets web links out to the browser', () => {
    expect(isWebUrl('https://example.com/a')).toBe(true);
    expect(isWebUrl('http://localhost:8787/cognito')).toBe(true);
    for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'smb://host/share', 'not a url', 42, null]) {
      expect(isWebUrl(bad)).toBe(false);
    }
  });
});

describe('isExternalUrl', () => {
  it('lets web links out, and mail links from a description, and nothing else', () => {
    for (const url of ['https://example.com/', 'http://example.com/', 'mailto:sam@example.com']) expect(isExternalUrl(url)).toBe(true);
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'multiscale://capture', 'smb://share', 'nonsense', 42, null]) expect(isExternalUrl(url)).toBe(false);
  });
});

describe('isDeepLink', () => {
  it('accepts only this build’s scheme', () => {
    expect(isDeepLink('multiscale-staging://auth/callback?code=c', 'multiscale-staging')).toBe(true);
    expect(isDeepLink('multiscale://auth/callback', 'multiscale-staging')).toBe(false);
    expect(isDeepLink('https://example.com', 'multiscale')).toBe(false);
    expect(isDeepLink('garbage', 'multiscale')).toBe(false);
  });
});

describe('cleanCapture', () => {
  it('makes a title the way every capture does', () => {
    expect(cleanCapture('  Paint the fence \n')).toBe('Paint the fence');
    expect(cleanCapture('Paint\nthe\tfence')).toBe('Paint the fence');
    expect(cleanCapture('x'.repeat(2001))).toBe('x'.repeat(2000));
  });

  it('rejects what is not a usable title', () => {
    for (const bad of ['', '   ', 42, null, undefined, {}]) expect(cleanCapture(bad)).toBeNull();
  });
});

describe('isOwnDbSql', () => {
  it('lets through the SQL the app runs', () => {
    expect(isOwnDbSql('SELECT * FROM records WHERE kind = ?')).toBe(true);
    expect(isOwnDbSql('BEGIN IMMEDIATE')).toBe(true);
    expect(isOwnDbSql("UPDATE records SET body = json_set(body, '$.attachments', ?)")).toBe(true);
  });

  it('refuses SQL that reaches another file, however it is written', () => {
    for (const bad of [
      "ATTACH DATABASE '/Users/someone/other.sqlite' AS other",
      "attach '/tmp/x' as x",
      'SELECT 1; DETACH other',
      "VACUUM INTO '/tmp/copy.sqlite'",
      "vacuum main into '/tmp/copy.sqlite'",
      "VACUUM/**/INTO '/tmp/copy.sqlite'",
      42,
      null,
    ]) {
      expect(isOwnDbSql(bad)).toBe(false);
    }
  });
});

describe('isSqlValues', () => {
  it('accepts only values SQLite can bind', () => {
    expect(isSqlValues(['a', 1, null])).toBe(true);
    expect(isSqlValues([])).toBe(true);
    expect(isSqlValues('a')).toBe(false);
    expect(isSqlValues([{}])).toBe(false);
    expect(isSqlValues([undefined])).toBe(false);
  });
});

describe('menuItems', () => {
  it('accepts a list of named choices, separators and one level of submenu', () => {
    const items = [{ id: 'done', label: 'Done' }, { type: 'separator' }, { id: 'move', label: 'Move to', submenu: [{ id: 'move:next', label: 'Next free time, 5pm' }] }];
    expect(menuItems(items)).toEqual(items);
  });

  it('refuses anything else the page could send', () => {
    expect(menuItems('Done')).toBeNull();
    expect(menuItems([])).toBeNull();
    expect(menuItems([{ id: 'done' }])).toBeNull();
    expect(menuItems([{ id: '', label: 'Done' }])).toBeNull();
    expect(menuItems([{ id: 'done', label: 'Done', click: 'x' }])).toBeNull();
    expect(menuItems([{ id: 'done', label: 'Done', role: 'quit' }])).toBeNull();
    expect(menuItems([{ type: 'checkbox', id: 'done', label: 'Done' }])).toBeNull();
    expect(menuItems([{ id: 'done', label: 'x'.repeat(201) }])).toBeNull();
    expect(menuItems(Array.from({ length: 41 }, (_, i) => ({ id: `i${i}`, label: 'Item' })))).toBeNull();
    // A submenu inside a submenu.
    expect(menuItems([{ id: 'a', label: 'A', submenu: [{ id: 'b', label: 'B', submenu: [{ id: 'c', label: 'C' }] }] }])).toBeNull();
  });
});

describe('contentSecurityPolicy', () => {
  const csp = contentSecurityPolicy(['https://api.example.com']);

  it('lets scripts come only from the app, and connections only to its backend', () => {
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe/);
    expect(csp).toContain("connect-src 'self' https://api.example.com");
  });

  it("shows photos from the device's own copies, and loads no image from elsewhere", () => {
    expect(csp).toContain("img-src 'self' data: blob:");
  });
});
