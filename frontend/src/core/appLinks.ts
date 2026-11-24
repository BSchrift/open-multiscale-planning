// The app's own links, which the iPhone widgets open: a screen, and for Today a block to show. plan is Plan your week.
// They carry ids, never titles. Capture and the sign-in callback have their own paths (platform/capacitor.ts, auth.ts).

export type AppLink = { screen: 'today'; block?: string } | { screen: 'inbox' } | { screen: 'week' } | { screen: 'plan' };

const ID = /^[A-Za-z0-9_:.-]{1,200}$/;

/** What a multiscale:// link opens, or null for anything else, which is left to whoever else listens. */
export function parseAppLink(url: string): AppLink | null {
  const match = /^multiscale:\/\/([a-z]+)\/?(?:\?(.*))?$/.exec(url);
  if (!match) return null;
  const [, screen, query] = match;
  if (screen === 'today') {
    const block = new URLSearchParams(query ?? '').get('block');
    return block && ID.test(block) ? { screen, block } : { screen };
  }
  if (screen === 'inbox' || screen === 'week' || screen === 'plan') return { screen };
  return null;
}

export function appLinkUrl(link: AppLink): string {
  return link.screen === 'today' && link.block ? `multiscale://today?block=${encodeURIComponent(link.block)}` : `multiscale://${link.screen}`;
}
