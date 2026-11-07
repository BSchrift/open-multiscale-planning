import { describe, expect, it } from 'vitest';
import { DEFAULT_SHORTCUT, isAccelerator, shortcutFromKeys, shortcutLabel } from './shortcut';

const keys = (code: string, mods: Partial<Record<'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey', boolean>> = {}) => ({
  code,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe('the capture shortcut', () => {
  it('turns keys pressed into an accelerator, modifiers in a fixed order', () => {
    expect(shortcutFromKeys(keys('Space', { metaKey: true, shiftKey: true }))).toBe(DEFAULT_SHORTCUT);
    expect(shortcutFromKeys(keys('KeyK', { ctrlKey: true, altKey: true }))).toBe('Control+Alt+K');
    expect(shortcutFromKeys(keys('Digit1', { metaKey: true }))).toBe('Command+1');
    expect(shortcutFromKeys(keys('Enter', { metaKey: true, shiftKey: true }))).toBe('Shift+Command+Return');
    expect(shortcutFromKeys(keys('ArrowUp', { altKey: true }))).toBe('Alt+Up');
    expect(shortcutFromKeys(keys('Period', { metaKey: true }))).toBe('Command+.');
    expect(shortcutFromKeys(keys('F5'))).toBe('F5');
  });

  it('waits for a key besides the modifiers, and needs Command, Control or Alt with any other key', () => {
    expect(shortcutFromKeys(keys('ShiftLeft', { shiftKey: true, metaKey: true }))).toBeNull();
    expect(shortcutFromKeys(keys('MetaLeft', { metaKey: true }))).toBeNull();
    expect(shortcutFromKeys(keys('KeyA'))).toBeNull();
    expect(shortcutFromKeys(keys('KeyA', { shiftKey: true }))).toBeNull();
    expect(shortcutFromKeys(keys('IntlYen', { metaKey: true }))).toBeNull();
  });

  it('reads as the Mac writes it', () => {
    expect(shortcutLabel(DEFAULT_SHORTCUT)).toBe('⇧⌘Space');
    expect(shortcutLabel('Control+Alt+K')).toBe('⌃⌥K');
    expect(shortcutLabel('Shift+Command+Return')).toBe('⇧⌘Return');
    expect(shortcutLabel('Alt+Up')).toBe('⌥↑');
  });

  it('accepts only what it makes, since the main process takes it from the page', () => {
    for (const a of [DEFAULT_SHORTCUT, 'Control+Alt+K', 'Command+.', 'F5', 'Alt+Up']) expect(isAccelerator(a)).toBe(true);
    for (const a of ['', 'Command', 'K', 'Shift+K', 'Command+Command+K', 'Command+Nope', 'Command+K+J', 42, null]) expect(isAccelerator(a)).toBe(false);
  });
});
