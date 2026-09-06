import { describe, expect, it, vi } from 'vitest';

import { createRegistry } from '../src/subscriptions';

describe('subscription registry', () => {
  it('creates once and disposes when the last holder releases', () => {
    const dispose = vi.fn();
    const create = vi.fn(() => dispose);
    const r = createRegistry();

    const a = r.retain('room:1', create);
    const b = r.retain('room:1', create);
    expect(create).toHaveBeenCalledTimes(1);

    a();
    expect(dispose).not.toHaveBeenCalled(); // b still holds it
    b();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(r.has('room:1')).toBe(false);
  });

  it('ignores a double release, so one holder cannot free another holder', () => {
    const dispose = vi.fn();
    const r = createRegistry();
    const a = r.retain('room:1', () => dispose);
    const b = r.retain('room:1', () => dispose);

    a();
    a(); // StrictMode double-invoke, or a careless caller
    expect(dispose).not.toHaveBeenCalled();
    b();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('re-creates after everything released, rather than reviving a disposed entry', () => {
    const create = vi.fn(() => () => {});
    const r = createRegistry();
    r.retain('room:1', create)();
    r.retain('room:1', create);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('keeps subscriptions independent of each other', () => {
    const d1 = vi.fn();
    const d2 = vi.fn();
    const r = createRegistry();
    const a = r.retain('room:1', () => d1);
    r.retain('room:2', () => d2);

    a();
    expect(d1).toHaveBeenCalledTimes(1);
    expect(d2).not.toHaveBeenCalled();
    expect(r.keys()).toEqual(['room:2']);
  });

  it('clears everything on sign-out', () => {
    const d1 = vi.fn();
    const d2 = vi.fn();
    const r = createRegistry();
    r.retain('room:1', () => d1);
    r.retain('actors', () => d2);

    r.clear();
    expect(d1).toHaveBeenCalledTimes(1);
    expect(d2).toHaveBeenCalledTimes(1);
    expect(r.keys()).toEqual([]);
  });

  it('survives a dispose that releases during clear', () => {
    const r = createRegistry();
    const holder: { release?: () => void } = {};
    // 'a' releases 'b' as it disposes — re-entrancy during clear(), which iterating the live
    // map directly would turn into a mutation-while-iterating bug.
    r.retain('a', () => () => holder.release?.());
    holder.release = r.retain('b', () => () => {});
    expect(() => r.clear()).not.toThrow();
    expect(r.keys()).toEqual([]);
  });
});
