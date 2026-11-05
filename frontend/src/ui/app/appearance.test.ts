import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setAppearance, useAppearance } from './appearance';

const root = document.documentElement;
const frontend = join(import.meta.dirname, '../../..');

afterEach(() => {
  vi.restoreAllMocks();
  act(() => setAppearance('system'));
});

describe('appearance', () => {
  it('is System by default, leaving light or dark to the system', () => {
    expect(renderHook(() => useAppearance()).result.current).toBe('system');
    expect(root).not.toHaveAttribute('data-theme');
  });

  it('a choice marks the root, which wins over the system, and is kept on this device; System clears it', () => {
    const { result } = renderHook(() => useAppearance());
    act(() => setAppearance('dark'));
    expect(result.current).toBe('dark');
    expect(root).toHaveAttribute('data-theme', 'dark');
    expect(localStorage.getItem('multiscale.appearance')).toBe('dark');

    act(() => setAppearance('light'));
    expect(result.current).toBe('light');
    expect(root).toHaveAttribute('data-theme', 'light');

    act(() => setAppearance('system'));
    expect(result.current).toBe('system');
    expect(root).not.toHaveAttribute('data-theme');
    expect(localStorage.getItem('multiscale.appearance')).toBeNull();
  });

  it('reads back what this device kept, and takes anything else as System', () => {
    localStorage.setItem('multiscale.appearance', 'light');
    expect(renderHook(() => useAppearance()).result.current).toBe('light');
    localStorage.setItem('multiscale.appearance', 'sepia');
    expect(renderHook(() => useAppearance()).result.current).toBe('system');
  });

  it('holds a choice for this session when storage is blocked', () => {
    vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const { result } = renderHook(() => useAppearance());
    act(() => setAppearance('dark'));
    expect(result.current).toBe('dark');
    expect(root).toHaveAttribute('data-theme', 'dark');
  });

  // The app's own code loads after the first paint, which would flash the system's theme before a chosen one.
  it('is applied before the first paint, by a plain script at the top of the page', () => {
    const html = readFileSync(join(frontend, 'index.html'), 'utf8');
    const head = html.slice(html.indexOf('<head>'), html.indexOf('</head>'));
    expect(head).toContain('<script src="/appearance.js"></script>');
    expect(html.indexOf('appearance.js')).toBeLessThan(html.indexOf('type="module"'));

    const script = readFileSync(join(frontend, 'public/appearance.js'), 'utf8');
    localStorage.setItem('multiscale.appearance', 'dark');
    new Function(script)();
    expect(root).toHaveAttribute('data-theme', 'dark');
    localStorage.setItem('multiscale.appearance', 'nonsense');
    root.removeAttribute('data-theme');
    new Function(script)();
    expect(root).not.toHaveAttribute('data-theme');
  });
});
