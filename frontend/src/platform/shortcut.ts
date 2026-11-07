// The desktop capture shortcut, as Electron's accelerator strings: made from the keys someone presses in Settings,
// written the Mac's way for labels, and checked again by the main process before it registers one.

export const DEFAULT_SHORTCUT = 'Shift+Command+Space';

/** In the order the Mac lists them. */
const MODIFIERS = [
  ['ctrlKey', 'Control', '⌃'],
  ['altKey', 'Alt', '⌥'],
  ['shiftKey', 'Shift', '⇧'],
  ['metaKey', 'Command', '⌘'],
] as const;

const NAMED: Record<string, [string, string]> = {
  Space: ['Space', 'Space'],
  Enter: ['Return', 'Return'],
  Tab: ['Tab', 'Tab'],
  Backspace: ['Backspace', '⌫'],
  ArrowUp: ['Up', '↑'],
  ArrowDown: ['Down', '↓'],
  ArrowLeft: ['Left', '←'],
  ArrowRight: ['Right', '→'],
  Minus: ['-', '-'],
  Equal: ['=', '='],
  BracketLeft: ['[', '['],
  BracketRight: [']', ']'],
  Semicolon: [';', ';'],
  Quote: ["'", "'"],
  Comma: [',', ','],
  Period: ['.', '.'],
  Slash: ['/', '/'],
  Backslash: ['\\', '\\'],
  Backquote: ['`', '`'],
};

/** A key code's accelerator name, or null for a modifier or a key a shortcut can't use. */
function keyName(code: string): string | null {
  const m = /^(?:Key([A-Z])|Digit([0-9])|(F(?:[1-9]|1[0-9]|2[0-4])))$/.exec(code);
  if (m) return m[1] ?? m[2] ?? m[3]!;
  return NAMED[code]?.[0] ?? null;
}

const isFunctionKey = (key: string) => /^F\d+$/.test(key);

/** The accelerator for the keys held down, or null until a usable one is: any key but F1 to F24 needs Command, Control or Alt. */
export function shortcutFromKeys(e: { code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }): string | null {
  const key = keyName(e.code);
  if (!key) return null;
  if (!isFunctionKey(key) && !e.metaKey && !e.ctrlKey && !e.altKey) return null;
  return [...MODIFIERS.filter(([flag]) => e[flag]).map(([, name]) => name), key].join('+');
}

export function isAccelerator(a: unknown): a is string {
  if (typeof a !== 'string') return false;
  const parts = a.split('+');
  const key = parts.pop()!;
  // Rebuilt from its own parts, so anything out of order, repeated or unknown fails.
  const e = { code: '', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };
  for (const p of parts) {
    const mod = MODIFIERS.find(([, name]) => name === p);
    if (!mod) return false;
    e[mod[0]] = true;
  }
  const code = Object.entries(NAMED).find(([, [name]]) => name === key)?.[0] ?? (/^[A-Z]$/.test(key) ? `Key${key}` : /^[0-9]$/.test(key) ? `Digit${key}` : key);
  return shortcutFromKeys({ ...e, code }) === a;
}

/** '⇧⌘Space' */
export function shortcutLabel(a: string): string {
  const parts = a.split('+');
  const key = parts.pop()!;
  const mods = MODIFIERS.filter(([, name]) => parts.includes(name)).map(([, , mark]) => mark);
  return mods.join('') + (Object.values(NAMED).find(([name]) => name === key)?.[1] ?? key);
}
