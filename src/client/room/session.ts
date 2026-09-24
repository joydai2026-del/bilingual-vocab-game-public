// What this device remembers about a room it is in.
//
// Two separate things, both in localStorage and both keyed by room code:
//
//   `vocab-room:<CODE>`  a student's membership (their player id and the name
//                        they typed). It is localStorage, not sessionStorage,
//                        because Done test 7 is "close the tab mid-round,
//                        reopen `#/room/CODE`, be back on your own bean":
//                        sessionStorage dies with the tab and would hand the
//                        child a fresh join screen and a zeroed score.
//   `vocab-host:<CODE>`  the teacher's host key, which the server mints exactly
//                        once at create and never puts on the wire again. Lose
//                        it and nobody can start another round in that room.
//                        Stored WITH the `createdAt` of the room it was minted
//                        for, because a room code is handed back out after its
//                        room expires: without the stamp, an old teacher device
//                        renders somebody else's room as if it owned it until
//                        the first host action fails (Codex round 1, SHOULD 2).
//
// A second tab on the same device is therefore the SAME player rather than a
// new one. That is the trade Done test 7 asks for, and it is the right way
// round for a classroom: a child who reopens the tab wants their bean back.

const ROOM_PREFIX = 'vocab-room:';
const HOST_PREFIX = 'vocab-host:';

/**
 * Rooms live two hours on the server. Anything older than this on a device is
 * pointing at a room that cannot exist any more, so it is dropped on read
 * rather than sent to the server to be refused.
 */
const STALE_MS = 4 * 60 * 60 * 1000;

export interface Membership {
  playerId: string;
  /**
   * The private key the server mints for this player at join and never puts in
   * the room state. Public player ids are display and ranking ids that every
   * device can read, so the key is what proves a tap came from the device that
   * joined, rather than from a classmate typing somebody else's id into the
   * console (Codex round 1, MUST-FIX 2). Empty for a week-1 membership, which
   * simply gets refused and asked to join again.
   */
  memberKey: string;
  name: string;
  savedAt: number;
}

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // private mode / storage full: this device simply cannot be recovered
  }
}

function drop(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // nothing stored, nothing to clear
  }
}

// --- a student's membership --------------------------------------------------

export function readMembership(code: string): Membership | null {
  const raw = read(ROOM_PREFIX + code);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<Membership>;
    if (typeof parsed?.playerId !== 'string' || !parsed.playerId) return null;
    const savedAt = typeof parsed.savedAt === 'number' ? parsed.savedAt : 0;
    if (Date.now() - savedAt > STALE_MS) {
      forgetMembership(code);
      return null;
    }
    return {
      playerId: parsed.playerId,
      memberKey: typeof parsed.memberKey === 'string' ? parsed.memberKey : '',
      name: typeof parsed.name === 'string' ? parsed.name : '',
      savedAt,
    };
  } catch {
    return null;
  }
}

export function writeMembership(
  code: string,
  playerId: string,
  memberKey: string,
  name: string
): void {
  write(
    ROOM_PREFIX + code,
    JSON.stringify({ playerId, memberKey, name, savedAt: Date.now() })
  );
}

export function forgetMembership(code: string): void {
  drop(ROOM_PREFIX + code);
}

// --- a teacher's host key ----------------------------------------------------

export interface HostSession {
  hostKey: string;
  /**
   * The `createdAt` of the room this key belongs to: the room's identity, the
   * one field that stays put while `version` counts up. `0` means "not bound
   * yet", which is a key written at create, before the teacher screen has seen
   * the room once. It binds on the first state that arrives.
   */
  createdAt: number;
}

/**
 * The host session for a code, or null. A bare string is what week-1 devices
 * wrote, so it is still read: it becomes an unbound session and binds itself
 * to the first room this device actually sees.
 */
export function readHostSession(code: string): HostSession | null {
  const raw = read(HOST_PREFIX + code);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<HostSession> | null;
    // Valid JSON that is not our object (a week-1 key that happened to parse,
    // a digits-only one for instance) is still the key itself.
    if (typeof parsed !== 'object' || parsed === null) return { hostKey: raw, createdAt: 0 };
    if (typeof parsed.hostKey !== 'string' || !parsed.hostKey) return null;
    return {
      hostKey: parsed.hostKey,
      createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : 0,
    };
  } catch {
    // Not JSON: the week-1 shape, which was the key on its own.
    return { hostKey: raw, createdAt: 0 };
  }
}

export function readHostKey(code: string): string | null {
  return readHostSession(code)?.hostKey ?? null;
}

export function writeHostKey(code: string, hostKey: string, createdAt = 0): void {
  write(HOST_PREFIX + code, JSON.stringify({ hostKey, createdAt }));
}

/**
 * Stamps the room this key was used in, once. Called by the teacher screen the
 * first time it sees a state, so every later load can tell "my room" from "the
 * same four letters, handed out again".
 */
export function bindHostRoom(code: string, createdAt: number): void {
  const session = readHostSession(code);
  if (!session) return;
  writeHostKey(code, session.hostKey, createdAt);
}

export function forgetHostKey(code: string): void {
  drop(HOST_PREFIX + code);
}

