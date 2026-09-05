import { describe, expect, it } from 'vitest';

import { challengeFor, newVerifier } from '../main/pkce';

describe('pkce', () => {
  // RFC 7636 appendix B — the one vector everyone's implementation must agree on.
  it('derives the S256 challenge the RFC says it should', () => {
    expect(challengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('mints verifiers in the allowed alphabet and length', () => {
    const v = newVerifier();
    expect(v.length).toBeGreaterThanOrEqual(43);
    expect(v.length).toBeLessThanOrEqual(128);
    expect(v).toMatch(/^[A-Za-z0-9._~-]+$/);
    expect(newVerifier()).not.toBe(v);
  });
});
