import { describe, expect, it } from 'vitest';
import { appLinkUrl, parseAppLink } from './appLinks';

describe("the app's own links", () => {
  it('open Today, Today at a block, the Inbox, Week and Plan', () => {
    expect(parseAppLink('multiscale://today')).toEqual({ screen: 'today' });
    expect(parseAppLink('multiscale://today/')).toEqual({ screen: 'today' });
    expect(parseAppLink('multiscale://today?block=blk_8f2c-1')).toEqual({ screen: 'today', block: 'blk_8f2c-1' });
    expect(parseAppLink('multiscale://inbox')).toEqual({ screen: 'inbox' });
    expect(parseAppLink('multiscale://week')).toEqual({ screen: 'week' });
    expect(parseAppLink('multiscale://plan')).toEqual({ screen: 'plan' });
  });

  it('leave Capture and the sign-in callback to their own handlers, and ignore anything else', () => {
    for (const url of ['multiscale://capture', 'multiscale://auth/callback?code=abc&state=def', 'multiscale://settings', 'https://example.com/today', 'multiscale:today', '']) {
      expect(parseAppLink(url)).toBeNull();
    }
  });

  it('open Today without a block when the id is not one', () => {
    expect(parseAppLink('multiscale://today?block=')).toEqual({ screen: 'today' });
    expect(parseAppLink('multiscale://today?block=%22%3E%3Cscript%3E')).toEqual({ screen: 'today' });
    expect(parseAppLink(`multiscale://today?block=${'a'.repeat(201)}`)).toEqual({ screen: 'today' });
  });

  it('round-trip, with ids and never titles', () => {
    for (const link of [{ screen: 'today' as const }, { screen: 'today' as const, block: 'spec' }, { screen: 'inbox' as const }, { screen: 'week' as const }, { screen: 'plan' as const }]) {
      expect(parseAppLink(appLinkUrl(link))).toEqual(link);
    }
    expect(appLinkUrl({ screen: 'today', block: 'spec' })).toBe('multiscale://today?block=spec');
  });
});
