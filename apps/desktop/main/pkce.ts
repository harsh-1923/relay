import { createHash, randomBytes } from 'node:crypto';

/**
 * RFC 7636. The verifier never leaves this process until the exchange; only its S256
 * challenge goes out with the authorize request. So the code WorkOS hands back can be
 * redeemed by nothing but the shell that started the sign-in — a hijacked deep link
 * gets a code it cannot use.
 */
export const newVerifier = () => randomBytes(32).toString('base64url'); // 43 chars

export const challengeFor = (verifier: string) =>
  createHash('sha256').update(verifier).digest('base64url');
