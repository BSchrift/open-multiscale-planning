import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { captureHotkey } from './hotkey';

/** Stands in for globalShortcut, with some shortcuts held by another app. */
function fakeShortcuts(taken: string[] = []) {
  const held = new Set<string>();
  return {
    held,
    register: (a: string) => !taken.includes(a) && !held.has(a) && (held.add(a), true),
    unregister: (a: string) => void held.delete(a),
    isRegistered: (a: string) => held.has(a),
  };
}

describe('the capture hotkey', () => {
  let file: string;
  beforeEach(() => {
    file = join(mkdtempSync(join(tmpdir(), 'hotkey-')), 'capture-shortcut.json');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('starts on the default, and a new one replaces it and is there after a restart', () => {
    const keys = fakeShortcuts();
    const hotkey = captureHotkey(file, keys, () => undefined);
    expect(hotkey.get()).toEqual({ accelerator: 'Shift+Command+Space', registered: true });
    expect(hotkey.set('Control+Alt+K')).toBe(true);
    expect([...keys.held]).toEqual(['Control+Alt+K']);

    const after = fakeShortcuts();
    expect(captureHotkey(file, after, () => undefined).get()).toEqual({ accelerator: 'Control+Alt+K', registered: true });
  });

  it('one another app holds is refused, and the working one stays', () => {
    const keys = fakeShortcuts(['Shift+Command+Return']);
    const hotkey = captureHotkey(file, keys, () => undefined);
    expect(hotkey.set('Shift+Command+Return')).toBe(false);
    expect(hotkey.get()).toEqual({ accelerator: 'Shift+Command+Space', registered: true });
  });

  it('says so when the saved one was taken at launch, and setting it again once free works', () => {
    writeFileSync(file, JSON.stringify({ accelerator: 'Control+Alt+K' }));
    const taken = ['Control+Alt+K'];
    const keys = fakeShortcuts(taken);
    const hotkey = captureHotkey(file, keys, () => undefined);
    expect(hotkey.get()).toEqual({ accelerator: 'Control+Alt+K', registered: false });
    taken.pop();
    expect(hotkey.set('Control+Alt+K')).toBe(true);
    expect(hotkey.get().registered).toBe(true);
  });

  it('ignores anything that is not a shortcut, from the page or the file', () => {
    writeFileSync(file, JSON.stringify({ accelerator: 'rm -rf' }));
    const hotkey = captureHotkey(file, fakeShortcuts(), () => undefined);
    expect(hotkey.get().accelerator).toBe('Shift+Command+Space');
    expect(hotkey.set('Command')).toBe(false);
    expect(hotkey.set({ accelerator: 'Command+K' })).toBe(false);
  });

  it('pressing it calls back', () => {
    let fired = 0;
    const keys = { register: vi.fn(() => true), unregister: vi.fn(), isRegistered: () => true };
    captureHotkey(file, keys, () => fired++);
    (keys.register.mock.calls[0] as unknown as [string, () => void])[1]();
    expect(fired).toBe(1);
  });
});
