import { describe, expect, it } from 'vitest';

import {
  roomCollections,
  shapeUrl,
  type ShapeName,
  type SyncConfigOptions,
} from '../src/collections/index';

/**
 * The contract between the client and the shape proxy is a URL. These assert that the client
 * asks for a *shape by name* and nothing else — no table, no where clause, no secret — because
 * that inversion is what keeps Electric's public-by-default API from being reachable.
 */
const opts: SyncConfigOptions = { baseUrl: 'https://app.example' };
const ROOM = '01a0780e-5c53-7737-9103-1fab70403106';
const CONV = '01a0780e-6c53-7737-9103-1fab70403107';

describe('collections point at the proxy, not at Electric', () => {
  it('names a shape and its parameters, and nothing else', () => {
    expect(shapeUrl(opts, 'room', { roomId: ROOM })).toBe(
      `https://app.example/shapes/room?roomId=${ROOM}`,
    );
    expect(shapeUrl(opts, 'roomMembers', { roomId: ROOM })).toBe(
      `https://app.example/shapes/roomMembers?roomId=${ROOM}`,
    );
    expect(shapeUrl(opts, 'messages', { conversationId: CONV })).toBe(
      `https://app.example/shapes/messages?conversationId=${CONV}`,
    );
    expect(shapeUrl(opts, 'actors', {})).toBe('https://app.example/shapes/actors');
  });

  it('never sends a table, where clause, columns or secret', () => {
    const every: [ShapeName, Record<string, string>][] = [
      ['room', { roomId: ROOM }],
      ['roomMembers', { roomId: ROOM }],
      ['conversations', { roomId: ROOM }],
      ['panels', { roomId: ROOM }],
      ['messages', { conversationId: CONV }],
      ['actors', {}],
    ];
    for (const [shape, params] of every) {
      const url = shapeUrl(opts, shape, params);
      for (const forbidden of ['table=', 'where=', 'columns=', 'secret=']) {
        expect(url).not.toContain(forbidden);
      }
    }
  });

  it('encodes a parameter rather than letting it add its own', () => {
    const url = shapeUrl(opts, 'room', { roomId: `${ROOM}&secret=leak` });
    expect(url).not.toContain('&secret=leak');
    expect(url).toContain('%26secret%3Dleak');
  });

  it('gives every collection a distinct id, so two rooms are two subscriptions', () => {
    const a = roomCollections(opts, ROOM);
    const b = roomCollections(opts, CONV);
    expect(a.room.id).not.toBe(b.room.id);
    expect(a.room.id).toContain(ROOM);
  });

  it('keys room members compositely, because the table has no single-column id', () => {
    const { members } = roomCollections(opts, ROOM);
    const key = members.config.getKey({
      room_id: ROOM,
      actor_id: 'actor-1',
      workspace_id: 'w',
      organization_id: 'o',
      added_by: null,
      created_at: '',
    });
    expect(key).toBe(`${ROOM}:actor-1`);
  });
});
