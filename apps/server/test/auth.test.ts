import { describe, expect, it } from 'vitest';

import {
  clearOAuthCookie,
  randomState,
  readOAuthCookie,
  setOAuthCookie,
} from '../src/auth/session';

const withCookie = (cookie: string) =>
  new Request('http://localhost/auth/callback', {
    headers: { Cookie: cookie.split(';')[0]! },
  });

describe('oauth state', () => {
  it('is random and unguessable in size', () => {
    const a = randomState();
    const b = randomState();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(43); // 32 bytes, base64url
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('round-trips through the cookie for both surfaces', () => {
    for (const surface of ['browser', 'desktop'] as const) {
      const state = randomState();
      const cookie = setOAuthCookie({ state, surface }, false);
      expect(readOAuthCookie(withCookie(cookie))).toEqual({ state, surface });
    }
  });

  it('is scoped to /auth, short-lived, and HttpOnly', () => {
    const cookie = setOAuthCookie({ state: 'x', surface: 'browser' }, true);
    expect(cookie).toContain('Path=/auth');
    expect(cookie).toContain('Max-Age=600');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
  });

  it('rejects a tampered or malformed cookie rather than trusting it', () => {
    expect(readOAuthCookie(withCookie('relay_oauth=garbage'))).toBeNull();
    expect(
      readOAuthCookie(withCookie(`relay_oauth=${encodeURIComponent('{"state":1}')}`)),
    ).toBeNull();
    expect(
      readOAuthCookie(
        withCookie(`relay_oauth=${encodeURIComponent('{"state":"s","surface":"tv"}')}`),
      ),
    ).toBeNull();
    expect(readOAuthCookie(new Request('http://localhost/auth/callback'))).toBeNull();
  });

  it('clears with a zero max-age on the same path', () => {
    expect(clearOAuthCookie()).toContain('Max-Age=0');
    expect(clearOAuthCookie()).toContain('Path=/auth');
  });
});
