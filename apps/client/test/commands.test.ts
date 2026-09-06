import { describe, expect, it } from 'vitest';

import { slotIndex, stepIndex } from '../src/lib/app-commands';

describe('slotIndex', () => {
  it('is positional for 1 through 8', () => {
    expect(slotIndex(5, 1)).toBe(0);
    expect(slotIndex(5, 3)).toBe(2);
  });

  it('sends 9 to the last tab however many there are', () => {
    expect(slotIndex(3, 9)).toBe(2);
    expect(slotIndex(12, 9)).toBe(11);
  });

  it('is null for a slot the strip is too short to have', () => {
    expect(slotIndex(2, 5)).toBeNull();
  });

  it('is null on an empty strip, including for 9', () => {
    expect(slotIndex(0, 1)).toBeNull();
    expect(slotIndex(0, 9)).toBeNull();
  });
});

describe('stepIndex', () => {
  it('moves one along', () => {
    expect(stepIndex(3, 0, 1)).toBe(1);
    expect(stepIndex(3, 2, -1)).toBe(1);
  });

  it('wraps at both ends', () => {
    expect(stepIndex(3, 2, 1)).toBe(0);
    expect(stepIndex(3, 0, -1)).toBe(2);
  });

  it('starts at an end when nothing is active', () => {
    // A workspace root leaves tabs docked with none active, which the strip allows.
    expect(stepIndex(3, -1, 1)).toBe(0);
    expect(stepIndex(3, -1, -1)).toBe(2);
  });

  it('is null on an empty strip rather than dividing by zero', () => {
    expect(stepIndex(0, -1, 1)).toBeNull();
  });

  it('stays in range for a single tab', () => {
    expect(stepIndex(1, 0, 1)).toBe(0);
    expect(stepIndex(1, 0, -1)).toBe(0);
  });
});
