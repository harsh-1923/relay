import { beforeEach, describe, expect, it, vi } from 'vitest';

import { dispatch, onDeepLink } from '../main/deep-links';

/**
 * `relay://` carries links of different trust — a single-use auth code redeemed against a
 * PKCE verifier, and a navigation that anything at all may send. Routing them through one
 * handler is how a room link gets dropped at the verifier gate, or how something that should
 * be gated stops being. These assert they stay apart.
 */
describe('dispatch', () => {
  const auth = vi.fn();
  const open = vi.fn();

  beforeEach(() => {
    auth.mockReset();
    open.mockReset();
    onDeepLink('auth', auth);
    onDeepLink('open', open);
  });

  it('sends an auth callback only to the auth handler', () => {
    dispatch('relay://auth/callback?code=abc');
    expect(auth).toHaveBeenCalledOnce();
    expect(open).not.toHaveBeenCalled();
    expect(auth.mock.calls[0]![0].pathname).toBe('/callback');
    expect(auth.mock.calls[0]![0].searchParams.get('code')).toBe('abc');
  });

  it('sends a navigation only to the open handler', () => {
    dispatch('relay://open/w/ws_1/r/room_1');
    expect(open).toHaveBeenCalledOnce();
    expect(auth).not.toHaveBeenCalled();
    expect(open.mock.calls[0]![0].pathname).toBe('/w/ws_1/r/room_1');
  });

  it('does not let a navigation reach the auth handler', () => {
    // The failure this guards: a room link routed through the auth handler is dropped at the
    // verifier gate, so the link silently does nothing.
    dispatch('relay://open/w/ws_1');
    expect(auth).not.toHaveBeenCalled();
  });

  it('drops an unknown host', () => {
    dispatch('relay://something-else/whatever');
    expect(auth).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it('drops another scheme entirely', () => {
    dispatch('https://auth/callback?code=abc');
    expect(auth).not.toHaveBeenCalled();
  });

  it('drops an unparseable URL rather than throwing', () => {
    expect(() => dispatch('not a url')).not.toThrow();
    expect(auth).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });
});
