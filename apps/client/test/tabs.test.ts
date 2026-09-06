import { describe, expect, it } from 'vitest';

import { titleFor } from '../src/lib/tabs';
import type { SwitchTarget } from '../src/lib/session';

const workspaces: SwitchTarget[] = [
  { organizationId: 'org_acme', name: 'Acme', workspaceId: 'ws_acme', roles: ['member'] },
];

/**
 * A tab's title is cached, so it is what the strip shows for a tab it is not rendering —
 * including on a cold start, before anything has synced.
 */
describe('titleFor', () => {
  it('names a workspace from the switch targets', () => {
    expect(titleFor('/w/ws_acme', workspaces)).toBe('Acme');
  });

  it('falls back when the workspace is not one of ours', () => {
    // Reachable: a link into another organization renders before the switch is accepted.
    expect(titleFor('/w/ws_other', workspaces)).toBe('Workspace');
  });

  it('names a room, and prefers it over the workspace it sits under', () => {
    expect(titleFor('/w/ws_acme/r/general', workspaces)).toBe('general');
  });

  it('names settings', () => {
    expect(titleFor('/settings', workspaces)).toBe('Settings');
  });

  it('falls back for an address it does not recognise', () => {
    expect(titleFor('/', workspaces)).toBe('relay');
    expect(titleFor('/nonsense', workspaces)).toBe('relay');
  });

  it('is given a pathname, so a query string does not become part of the name', () => {
    // The caller passes `location.pathname`; `?at=` is a permalink into a place, not a place.
    expect(titleFor('/w/ws_acme/r/general', workspaces)).toBe('general');
  });
});
