// What a sign-in token says, read without verifying it: the server checks every token, and the device only tells one
// account's from another's.

/** A claim from a token, or undefined if it can't be read. */
export function rawClaim(token: string, name: string): unknown {
  try {
    const payload = token.split('.')[1] ?? '';
    return (JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as Record<string, unknown> | null)?.[name];
  } catch {
    return undefined;
  }
}

/** A text claim from a token, or null if it can't be read. */
export function claim(token: string, name: string): string | null {
  const value = rawClaim(token, name);
  return typeof value === 'string' && value ? value : null;
}

/** The user an access token names, from its sub claim. */
export const tokenSubject = (token: string): string | null => claim(token, 'sub');
