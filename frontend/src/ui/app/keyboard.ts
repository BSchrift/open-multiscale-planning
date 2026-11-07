// On a phone the keyboard covers the bottom of the page instead of shrinking it, so a sheet pinned to the bottom would
// sit under it. --keyboard is how much of the page the keyboard covers, and phone sheets rise by that much.

import { useEffect } from 'react';

export function useKeyboardInset(): void {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement.style;
    const set = () => root.setProperty('--keyboard', `${Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop))}px`);
    set();
    vv.addEventListener('resize', set);
    vv.addEventListener('scroll', set);
    return () => {
      vv.removeEventListener('resize', set);
      vv.removeEventListener('scroll', set);
      root.removeProperty('--keyboard');
    };
  }, []);
}
