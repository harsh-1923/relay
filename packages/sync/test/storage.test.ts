import { describe, expect, it, vi } from 'vitest';

import {
  bootTarget,
  createWriter,
  keyOf,
  memoryStore,
  restore,
  reviveStrip,
  type StripKey,
} from '../src/local/storage';
import type { Strip, Tab } from '../src/local/tabs';

const tab = (id: string, over: Partial<Tab> = {}): Tab => ({
  id,
  location: `/w/w1/r/${id}`,
  title: id,
  pinned: false,
  ...over,
});

const key: StripKey = { accountId: 'user_1', organizationId: 'org_1' };
const strip = (...tabs: Tab[]): Strip => ({ tabs, activeId: tabs.at(-1)?.id ?? null });
const stored = (over: Record<string, unknown>) => ({
  version: 1,
  tabs: [],
  activeId: null,
  ...over,
});

describe('keyOf', () => {
  it('separates the two halves of the scope', () => {
    expect(keyOf(key)).not.toBe(keyOf({ accountId: 'user_1', organizationId: 'org_2' }));
    expect(keyOf(key)).not.toBe(keyOf({ accountId: 'user_2', organizationId: 'org_1' }));
  });

  it('encodes ids rather than trusting them not to contain the separator', () => {
    // `.` is not escaped by encodeURIComponent, so it would have collided here.
    for (const [x, y] of [
      ['a.b', 'c'],
      ['a', 'b.c'],
      ['a:b', 'c'],
      ['a', 'b:c'],
    ] as const) {
      expect(keyOf({ accountId: x, organizationId: y })).toBe(
        keyOf({ accountId: x, organizationId: y }),
      );
    }
    const keys = new Set(
      (
        [
          ['a.b', 'c'],
          ['a', 'b.c'],
          ['a:b', 'c'],
          ['a', 'b:c'],
        ] as const
      ).map(([x, y]) => keyOf({ accountId: x, organizationId: y })),
    );
    expect(keys.size).toBe(4);
  });
});

describe('reviveStrip', () => {
  it('round-trips a strip', () => {
    const before = strip(tab('a'), tab('b'));
    const store = memoryStore();
    store.save(key, before);
    expect(store.load(key)).toEqual(before);
  });

  it('returns null for nothing stored', () => {
    expect(memoryStore().load(key)).toBeNull();
  });

  it('discards an unrecognised version rather than guessing at the shape', () => {
    expect(reviveStrip(stored({ version: 99, tabs: [tab('a')] }))).toBeNull();
  });

  it('drops a malformed tab but keeps the rest', () => {
    const revived = reviveStrip(stored({ tabs: [tab('a'), { id: 'b' }, tab('c')], activeId: 'a' }));
    expect(revived?.tabs.map((t) => t.id)).toEqual(['a', 'c']);
  });

  it('drops a tab whose location could leave the app', () => {
    // A persisted path is followed on the next launch without anyone asking for it.
    const revived = reviveStrip(
      stored({ tabs: [tab('a'), tab('bad', { location: '//evil.example' })], activeId: 'a' }),
    );
    expect(revived?.tabs.map((t) => t.id)).toEqual(['a']);
  });

  it('drops duplicate ids', () => {
    const revived = reviveStrip(stored({ tabs: [tab('a'), tab('a'), tab('b')], activeId: 'a' }));
    expect(revived?.tabs.map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('restores pinned-first ordering that storage did not preserve', () => {
    const revived = reviveStrip(
      stored({ tabs: [tab('a'), tab('p', { pinned: true }), tab('b')], activeId: 'a' }),
    );
    expect(revived?.tabs.map((t) => t.id)).toEqual(['p', 'a', 'b']);
  });

  it('repoints activeId when it names a tab that did not survive', () => {
    const revived = reviveStrip(stored({ tabs: [tab('a')], activeId: 'gone' }));
    expect(revived?.activeId).toBe('a');
  });

  it('returns null when nothing usable is left', () => {
    expect(reviveStrip(stored({ tabs: [{ nope: true }] }))).toBeNull();
    expect(reviveStrip(stored({ tabs: 'not an array' }))).toBeNull();
    expect(reviveStrip(null)).toBeNull();
    expect(reviveStrip('garbage')).toBeNull();
  });
});

describe('createWriter', () => {
  it('coalesces the writes navigation causes', () => {
    vi.useFakeTimers();
    const store = memoryStore();
    const save = vi.spyOn(store, 'save');
    const writer = createWriter(store, 300);

    writer.write(key, strip(tab('a')));
    writer.write(key, strip(tab('b')));
    writer.write(key, strip(tab('c')));
    expect(save).not.toHaveBeenCalled();

    vi.advanceTimersByTime(300);
    expect(save).toHaveBeenCalledOnce();
    expect(store.load(key)?.tabs[0]!.id).toBe('c');
    vi.useRealTimers();
  });

  it('writes a deliberate act straight through', () => {
    const store = memoryStore();
    writerFor(store).writeNow(key, strip(tab('a')));
    expect(store.load(key)?.tabs[0]!.id).toBe('a');
  });

  it('supersedes a coalesced write rather than letting it land afterwards', () => {
    vi.useFakeTimers();
    const store = memoryStore();
    const writer = createWriter(store, 300);

    writer.write(key, strip(tab('stale')));
    writer.writeNow(key, strip(tab('fresh')));
    vi.advanceTimersByTime(1000);

    expect(store.load(key)?.tabs[0]!.id).toBe('fresh');
    vi.useRealTimers();
  });

  it('flush commits what is still pending — a quit is otherwise a lost navigation', () => {
    vi.useFakeTimers();
    const store = memoryStore();
    const writer = createWriter(store, 300);

    writer.write(key, strip(tab('a')));
    writer.flush();
    expect(store.load(key)?.tabs[0]!.id).toBe('a');
    vi.useRealTimers();
  });

  it('flush is safe with nothing pending', () => {
    expect(() => writerFor(memoryStore()).flush()).not.toThrow();
  });
});

const writerFor = (store: ReturnType<typeof memoryStore>) => createWriter(store, 300);

describe('restore', () => {
  const fallback = () => tab('home', { location: '/w/w1' });

  it('opens the fallback when nothing was stored', () => {
    const s = restore(null, '/', fallback);
    expect(s.tabs.map((t) => t.id)).toEqual(['home']);
    expect(s.activeId).toBe('home');
  });

  it('keeps the stored active tab on a cold launch at the root', () => {
    const s = restore({ ...strip(tab('a'), tab('b')), activeId: 'a' }, '/', fallback);
    expect(s.activeId).toBe('a');
    expect(s.tabs).toHaveLength(2);
  });

  it('activates the tab already at the address rather than duplicating it', () => {
    const s = restore({ ...strip(tab('a'), tab('b')), activeId: 'a' }, '/w/w1/r/b', fallback);
    expect(s.activeId).toBe('b');
    expect(s.tabs).toHaveLength(2);
  });

  it('opens a tab for an address the strip does not hold — a pasted link must land', () => {
    const s = restore(strip(tab('a')), '/settings', fallback);
    expect(s.tabs).toHaveLength(2);
    expect(s.tabs.at(-1)?.location).toBe('/settings');
    expect(s.activeId).toBe(s.tabs.at(-1)?.id);
  });
});

describe('bootTarget', () => {
  const at = (location: string) => ({ ...tab('a', { location }), id: 'a' });

  it('sends you back to where you were when launching at the root', () => {
    expect(bootTarget({ tabs: [at('/w/w1/r/design')], activeId: 'a' }, '/')).toBe('/w/w1/r/design');
  });

  it('stays put when the address already names a place', () => {
    // A deep link, or a refresh mid-room: the URL wins, so there is nowhere to send anyone.
    expect(bootTarget({ tabs: [at('/w/w1/r/design')], activeId: 'a' }, '/w/w1/r/other')).toBeNull();
  });

  it('has nowhere to send you when the stored tab is itself the root', () => {
    expect(bootTarget({ tabs: [at('/')], activeId: 'a' }, '/')).toBeNull();
  });

  it('has nowhere to send you when no tab is active', () => {
    expect(bootTarget({ tabs: [at('/w/w1')], activeId: null }, '/')).toBeNull();
    expect(bootTarget({ tabs: [], activeId: null }, '/')).toBeNull();
  });
});
