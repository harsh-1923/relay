import { describe, expect, it } from 'vitest';

import { resolveWorkspace } from '../src/lib/navigation';
import type { SwitchTarget } from '../src/lib/session';

const target = (over: Partial<SwitchTarget> = {}): SwitchTarget => ({
  organizationId: 'org_acme',
  name: 'Acme',
  workspaceId: 'ws_acme',
  roles: ['member'],
  ...over,
});

describe('resolveWorkspace', () => {
  it('is here when the workspace is in the session organization', () => {
    expect(resolveWorkspace('ws_acme', [target()], 'org_acme', false)).toEqual({ status: 'here' });
  });

  it('is elsewhere when reachable through another organization', () => {
    expect(resolveWorkspace('ws_acme', [target()], 'org_other', false)).toEqual({
      status: 'elsewhere',
      organizationId: 'org_acme',
      name: 'Acme',
    });
  });

  it('is unknown when no organization this account holds can reach it', () => {
    expect(resolveWorkspace('ws_nope', [target()], 'org_acme', false)).toEqual({
      status: 'unknown',
    });
  });

  it('is pending rather than unknown while the list is still loading', () => {
    expect(resolveWorkspace('ws_nope', [], null, true)).toEqual({ status: 'pending' });
  });

  it('answers from the list even while it is still loading', () => {
    // A partial list that already contains the answer should not stall behind the rest.
    expect(resolveWorkspace('ws_acme', [target()], 'org_acme', true)).toEqual({ status: 'here' });
  });

  it('treats a session with no organization as needing a switch, not as access', () => {
    expect(resolveWorkspace('ws_acme', [target()], null, false)).toMatchObject({
      status: 'elsewhere',
    });
  });

  it('picks the matching workspace out of several organizations', () => {
    const list = [
      target(),
      target({ organizationId: 'org_globex', name: 'Globex', workspaceId: 'ws_globex' }),
    ];
    expect(resolveWorkspace('ws_globex', list, 'org_acme', false)).toEqual({
      status: 'elsewhere',
      organizationId: 'org_globex',
      name: 'Globex',
    });
  });
});
