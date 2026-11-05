import { describe, expect, it, vi } from 'vitest';
import { relaySignIn } from './web';

const REDIRECT = 'http://localhost:5173/auth/callback';

describe('relaySignIn', () => {
  it('hands the callback from the tab sign-in returned to, to the tab that started it, and closes', async () => {
    const received: string[] = [];
    const app = { url: 'http://localhost:5173/', closeTab: vi.fn(), onLink: (url: string) => received.push(url) };
    const callback = { url: `${REDIRECT}?code=c&state=s`, closeTab: vi.fn(), onLink: vi.fn() };

    expect(relaySignIn({ redirectUri: REDIRECT, ...app })).toBe(false);
    expect(relaySignIn({ redirectUri: REDIRECT, ...callback })).toBe(true);

    await vi.waitFor(() => expect(received).toEqual([`${REDIRECT}?code=c&state=s`]));
    expect(callback.closeTab).toHaveBeenCalled();
    expect(app.closeTab).not.toHaveBeenCalled();
  });
});
