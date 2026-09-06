import { describe, expect, it } from 'vitest';

import { EMPTY, transitions, type Store } from '../main/accounts';

/**
 * One email is one account: WorkOS keys identity on email, and the two are never linked
 * server-side — linking would be a path around an enterprise's SSO enforcement. Holding
 * several at once is therefore the shell's job, and these are the transitions that do it.
 */
const gmail = { userId: 'user_gmail', email: 'a@gmail.com', sealed: 'seal-1' };
const work = { userId: 'user_work', email: 'a@work.com', sealed: 'seal-2' };

const withBoth = (): Store => transitions.upsert(transitions.upsert(EMPTY, gmail), work);

describe('accounts', () => {
  it('signing in adds an account and makes it active', () => {
    const s = transitions.upsert(EMPTY, gmail);
    expect(s.active).toBe('user_gmail');
    expect(Object.keys(s.accounts)).toEqual(['user_gmail']);
  });

  it('a second sign-in adds rather than replaces', () => {
    // The whole point: signing in as a second email must not sign out the first.
    const s = withBoth();
    expect(Object.keys(s.accounts).sort()).toEqual(['user_gmail', 'user_work']);
    expect(s.active).toBe('user_work');
  });

  it('signing in again as an existing account replaces its seal, not the list', () => {
    const s = transitions.upsert(withBoth(), { ...gmail, sealed: 'seal-fresh' });
    expect(Object.keys(s.accounts)).toHaveLength(2);
    expect(s.accounts.user_gmail?.sealed).toBe('seal-fresh');
    expect(s.active).toBe('user_gmail');
  });

  it('a rotated seal lands on the active account only', () => {
    const s = transitions.updateActiveSeal(withBoth(), 'rotated');
    expect(s.accounts.user_work?.sealed).toBe('rotated');
    expect(s.accounts.user_gmail?.sealed).toBe('seal-1');
  });

  it('ignores a rotated seal when nothing is active', () => {
    expect(transitions.updateActiveSeal(EMPTY, 'rotated')).toEqual(EMPTY);
  });

  it('switches only to an account it holds', () => {
    const s = withBoth();
    expect(transitions.setActive(s, 'user_gmail').active).toBe('user_gmail');
    // A stale userId from the renderer must not leave the shell pointing at nothing.
    expect(transitions.setActive(s, 'user_nobody').active).toBe('user_work');
  });

  it('signing out the active account promotes another', () => {
    // Otherwise the app shows a sign-in screen while still holding a valid session.
    const s = transitions.remove(withBoth(), 'user_work');
    expect(s.active).toBe('user_gmail');
    expect(Object.keys(s.accounts)).toEqual(['user_gmail']);
  });

  it('signing out a background account leaves the active one alone', () => {
    const s = transitions.remove(withBoth(), 'user_gmail');
    expect(s.active).toBe('user_work');
  });

  it('signing out the last account leaves nothing active', () => {
    const s = transitions.remove(transitions.upsert(EMPTY, gmail), 'user_gmail');
    expect(s).toEqual(EMPTY);
  });
});
