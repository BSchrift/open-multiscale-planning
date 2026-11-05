// Settings > Appearance, applied before the first paint so a chosen theme never flashes the system's first. A plain
// script, since the content security policy allows no inline ones; src/ui/app/appearance.ts owns the key after this.
try {
  const theme = localStorage.getItem('multiscale.appearance');
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
} catch {
  // Storage can be blocked; the system's theme shows then.
}
