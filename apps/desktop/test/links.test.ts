import { describe, expect, it } from 'vitest';

import { isInAppPath } from '../main/links';

/**
 * A `relay://` URL can come from anywhere — a web page, an email, another app — so what the
 * shell agrees to forward is a trust boundary, not a formatting preference.
 */
describe('isInAppPath', () => {
  it('accepts in-app paths', () => {
    for (const path of ['/', '/settings', '/w/ws_1', '/w/ws_1/r/room_1', '/w/ws_1?at=m_1']) {
      expect(isInAppPath(path), path).toBe(true);
    }
  });

  it('rejects anything that would leave the app', () => {
    for (const path of [
      '//evil.example', // protocol-relative — a host, not a path
      '//evil.example/w/ws_1',
      '\\\\evil.example', // the same trick, spelled for Windows
      '/w\\..\\..\\etc', // backslash traversal
      'w/ws_1', // no leading slash: relative, so it would resolve against wherever we are
      'https://evil.example',
      'javascript:alert(1)',
      '',
    ]) {
      expect(isInAppPath(path), path).toBe(false);
    }
  });

  /**
   * `new URL('relay://open//evil.example')` parses with host `open` and pathname
   * `//evil.example`, which is exactly the shape the guard exists to stop — so it is worth
   * asserting against a real parse rather than only against hand-written strings.
   */
  it('rejects a protocol-relative path as it actually arrives from a URL', () => {
    const url = new URL('relay://open//evil.example/w/ws_1');
    expect(isInAppPath(`${url.pathname}${url.search}`)).toBe(false);
  });

  it('accepts a genuine link as it actually arrives from a URL', () => {
    const url = new URL('relay://open/w/ws_1/r/room_1?at=m_1');
    expect(isInAppPath(`${url.pathname}${url.search}`)).toBe(true);
    expect(`${url.pathname}${url.search}`).toBe('/w/ws_1/r/room_1?at=m_1');
  });
});
