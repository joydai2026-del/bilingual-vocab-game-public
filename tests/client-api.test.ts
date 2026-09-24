// What the room API client refuses to accept from the server.
//
// These are the two credentials a device stores and then proves itself with
// later: the student's `memberKey` and the teacher's `hostKey`. A reply that
// is missing one is a reply this device cannot act on, so it is a failure at
// the moment it arrives rather than a 403 in the middle of a lesson.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createTeacherRoom, joinRoom } from '../src/client/room/api';
import type { VocabSet } from '../src/shared/types';

const SET: VocabSet = {
  v: 1,
  title: 'class set',
  level: 'big',
  items: [{ id: 'id0', zh: '中', pinyin: 'zhong', en: 'middle' }],
};

/** Answers the next fetch with this JSON body and a 200. */
function serverSays(body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }))
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('joining', () => {
  it('takes a join that carries both the player id and the key', async () => {
    serverSays({ playerId: 'p1', memberKey: 'k1', version: 3 });
    const result = await joinRoom('WXYZ', 'Ana');
    expect(result.playerId).toBe('p1');
    expect(result.memberKey).toBe('k1');
  });

  it('refuses a join with no key, instead of storing an empty one', async () => {
    serverSays({ playerId: 'p1', version: 3 });
    await expect(joinRoom('WXYZ', 'Ana')).rejects.toThrow(/sign this device in/);
  });

  it('refuses a join whose key is empty', async () => {
    serverSays({ playerId: 'p1', memberKey: '', version: 3 });
    await expect(joinRoom('WXYZ', 'Ana')).rejects.toThrow(/sign this device in/);
  });

  it('refuses a join with no player id', async () => {
    serverSays({ memberKey: 'k1', version: 3 });
    await expect(joinRoom('WXYZ', 'Ana')).rejects.toThrow(/full or has already started/);
  });
});

describe('making a class room', () => {
  it('carries the room createdAt back, so the key is bound at once', async () => {
    serverSays({ code: 'WXYZ', hostKey: 'hk', createdAt: 1_700_000_000_000 });
    const room = await createTeacherRoom(SET);
    expect(room).toEqual({ code: 'WXYZ', hostKey: 'hk', createdAt: 1_700_000_000_000 });
  });

  it('treats a server too old to send createdAt as unbound, not as room 0', async () => {
    serverSays({ code: 'WXYZ', hostKey: 'hk' });
    expect((await createTeacherRoom(SET)).createdAt).toBe(0);
  });

  it('refuses a create with no host key', async () => {
    serverSays({ code: 'WXYZ' });
    await expect(createTeacherRoom(SET)).rejects.toThrow(/teacher key/);
  });
});

