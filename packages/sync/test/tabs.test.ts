import { describe, expect, it } from 'vitest';

import { active, empty, transitions, type Strip, type Tab } from '../src/local/tabs';

const tab = (id: string, over: Partial<Tab> = {}): Tab => ({
  id,
  location: `/w/w1/r/${id}`,
  title: id,
  pinned: false,
  ...over,
});

/** Builds a strip from tabs, active on the last one — what a run of `open` would leave. */
const strip = (...tabs: Tab[]): Strip => ({
  tabs,
  activeId: tabs.at(-1)?.id ?? null,
});

const ids = (s: Strip) => s.tabs.map((t) => t.id);
const fallback = () => tab('home', { location: '/w/w1' });

describe('open', () => {
  it('appends and activates', () => {
    const s = transitions.open(strip(tab('a')), tab('b'));
    expect(ids(s)).toEqual(['a', 'b']);
    expect(s.activeId).toBe('b');
  });

  it('activates an existing tab rather than duplicating the location', () => {
    const s = transitions.open(strip(tab('a'), tab('b')), tab('c', { location: '/w/w1/r/a' }));
    expect(ids(s)).toEqual(['a', 'b']);
    expect(s.activeId).toBe('a');
  });

  it('lands a pinned tab inside the pinned run, not at the end', () => {
    const s = transitions.open(
      strip(tab('p', { pinned: true }), tab('a'), tab('b')),
      tab('q', { pinned: true }),
    );
    expect(ids(s)).toEqual(['p', 'q', 'a', 'b']);
  });
});

describe('close', () => {
  it('lands on the right neighbour', () => {
    const s = transitions.close(
      { ...strip(tab('a'), tab('b'), tab('c')), activeId: 'b' },
      'b',
      fallback,
    );
    expect(ids(s)).toEqual(['a', 'c']);
    expect(s.activeId).toBe('c');
  });

  it('falls back to the left when the active tab was last', () => {
    const s = transitions.close(strip(tab('a'), tab('b')), 'b', fallback);
    expect(ids(s)).toEqual(['a']);
    expect(s.activeId).toBe('a');
  });

  it('leaves the active tab alone when closing a different one', () => {
    const s = transitions.close(
      { ...strip(tab('a'), tab('b'), tab('c')), activeId: 'a' },
      'c',
      fallback,
    );
    expect(s.activeId).toBe('a');
  });

  it('never empties the strip', () => {
    const s = transitions.close(strip(tab('a')), 'a', fallback);
    expect(ids(s)).toEqual(['home']);
    expect(s.activeId).toBe('home');
  });

  it('ignores a tab that is not there', () => {
    const before = strip(tab('a'));
    expect(transitions.close(before, 'nope', fallback)).toBe(before);
  });
});

describe('navigate', () => {
  it('moves only the active tab', () => {
    const s = transitions.navigate(
      { ...strip(tab('a'), tab('b')), activeId: 'a' },
      '/settings',
      'Settings',
    );
    expect(s.tabs[0]).toMatchObject({ id: 'a', location: '/settings', title: 'Settings' });
    expect(s.tabs[1]).toMatchObject({ id: 'b', location: '/w/w1/r/b' });
  });

  it('does nothing when no tab is active', () => {
    const s = transitions.navigate(empty, '/settings', 'Settings');
    expect(s.tabs).toEqual([]);
  });
});

describe('setPinned', () => {
  it('moves a pinned tab to the end of the pinned run', () => {
    const s = transitions.setPinned(
      strip(tab('p', { pinned: true }), tab('a'), tab('b')),
      'b',
      true,
    );
    expect(ids(s)).toEqual(['p', 'b', 'a']);
  });

  it('moves an unpinned tab to the start of the unpinned run', () => {
    const s = transitions.setPinned(
      strip(tab('p', { pinned: true }), tab('q', { pinned: true }), tab('a')),
      'p',
      false,
    );
    expect(ids(s)).toEqual(['q', 'p', 'a']);
  });

  it('is a no-op when already in that state', () => {
    const before = strip(tab('a'));
    expect(transitions.setPinned(before, 'a', false)).toBe(before);
  });

  it('does not change which tab is active', () => {
    const before = { ...strip(tab('a'), tab('b')), activeId: 'a' };
    expect(transitions.setPinned(before, 'b', true).activeId).toBe('a');
  });
});

describe('reorder', () => {
  it('moves within the unpinned run', () => {
    const s = transitions.reorder(strip(tab('a'), tab('b'), tab('c')), 'c', 0);
    expect(ids(s)).toEqual(['c', 'a', 'b']);
  });

  it('will not let an unpinned tab cross into the pinned run', () => {
    const s = transitions.reorder(strip(tab('p', { pinned: true }), tab('a'), tab('b')), 'b', 0);
    expect(ids(s)).toEqual(['p', 'b', 'a']);
    expect(s.tabs[1]!.pinned).toBe(false);
  });

  it('will not let a pinned tab cross out of the pinned run', () => {
    const s = transitions.reorder(
      strip(tab('p', { pinned: true }), tab('q', { pinned: true }), tab('a')),
      'p',
      9,
    );
    expect(ids(s)).toEqual(['q', 'p', 'a']);
  });
});

describe('active', () => {
  it('resolves the active tab, and null on an empty strip', () => {
    expect(active(strip(tab('a'), tab('b')))?.id).toBe('b');
    expect(active(empty)).toBeNull();
  });
});
