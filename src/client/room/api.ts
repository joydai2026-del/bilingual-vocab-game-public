// Talking to the room API. Every reply carries the server's own clock
// (`serverNow`), so the client can line its question windows up with the
// server's schedule instead of trusting the device clock.

import type {
  ChestOutcome,
  PublicQuizQuestion,
  PublicRoomState,
  QuizQuestion,
  Refusal,
  RoundKind,
  VocabSet,
} from '../../shared/types';

export type { ChestOutcome, Refusal, RoundKind };

/**
 * A question as it arrives from a room. The server strips `answer` before it
 * sends the state, so a player cannot read the right choice out of the network
 * tab; the room learns it only from the reply to their own answer.
 */
export type RoomQuestion = PublicQuizQuestion;

/**
 * The room state as it arrives on the wire. `PublicRoomState` already carries
 * both shapes: the v2 fields (`round`, `history`, `phase: 'round' | 'results'`)
 * and, for a `model: 1` room only, the v1 mirrors (`startsAt`, `perQuestionMs`,
 * `slotMs`, `questionCount`, `result`, `phase: 'playing' | 'done'`). Which set
 * is populated is the room's business, not this file's.
 */
export type RoomStateWire = PublicRoomState;

export interface RoomEnvelope {
  state?: RoomStateWire;
  version?: number;
  nextPollMs?: number;
  serverNow?: number;
  unchanged?: boolean;
  /** Answer and pick replies: false when the server did not record the action. */
  accepted?: boolean;
  /** Answer replies only: whether the recorded answer was the right one. */
  correct?: boolean;
  /**
   * Answer replies only: which choice was the right one. This is the only
   * place the room ever learns it, so feedback after a tap comes from here
   * and never from the question itself. Negative means the server withheld
   * it, which is why every reader goes through `revealedChoice`.
   */
  correctChoice?: number;
  /** Why the server ignored the action, when it did. */
  refusal?: Refusal;
  /** Answer replies in a dash round: the chest window this answer opened. */
  pick?: { index: number; expiresAt: number };
  /**
   * Pick replies only: what was in the chest. ABSENT whenever `accepted` is
   * false, which is the server refusing to reveal a chest it did not open.
   */
  outcome?: ChestOutcome;
}

/**
 * Who is asking for a host action. A teacher holds a `hostKey`; the legacy
 * "Race a friend" host is a player and is known by `playerId`. The server
 * decides which one its room accepts, so both are simply forwarded.
 */
export interface HostAuth {
  hostKey?: string | null;
  playerId?: string | null;
}

/**
 * Who is answering. The public player id says WHICH bean; the `memberKey` says
 * this device is the one that joined as it. Every player id in a room is
 * public, so without the key one child could answer as another or burn their
 * chest (Codex round 1, MUST-FIX 2). The server mints the key once, at join,
 * and never puts it in the room state.
 */
export interface PlayerAuth {
  playerId: string;
  memberKey: string;
}

function hostBody(auth: HostAuth): { hostKey: string; playerId: string } {
  return { hostKey: auth.hostKey ?? '', playerId: auth.playerId ?? '' };
}

/** An error carrying the HTTP status, so callers can back off on a 429. */
export class RoomError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'RoomError';
    this.status = status;
  }
}

let clockOffset = 0; // serverNow - Date.now(), measured on every reply

/** Server time in ms, corrected for the difference with this device's clock. */
export function serverTime(): number {
  return Date.now() + clockOffset;
}

function absorb(envelope: RoomEnvelope): RoomEnvelope {
  if (typeof envelope.serverNow === 'number') {
    clockOffset = envelope.serverNow - Date.now();
  }
  return envelope;
}

/** Plain-language stand-in when the server sends no message of its own. */
function plainError(status: number): string {
  if (status === 404) return 'That room code does not exist. Check the 4 letters.';
  if (status === 409 || status === 403) return 'That room is not taking players right now.';
  if (status === 429) return 'Too many tries at once. Wait a moment and try again.';
  return 'The room did not answer. Check the connection and try again.';
}

/**
 * The one message for a 403 on an answer or a pick: this device's key is not
 * the one that joined as that player. Nothing a retry can fix, so the screen
 * that shows it also drops the stored player and asks for a name again.
 */
export const NOT_SIGNED_IN =
  'This device is not signed in as that player. Join again.';

/**
 * The server writes for a log, not for a class: `room not found`,
 * `only the host can start`. Every message a player can see is rewritten here,
 * so raw lowercase server text never lands on a screen.
 */
const SERVER_WORDING: Record<string, string> = {
  'room not found': 'That room code does not exist. Check the 4 letters.',
  'not found': 'That room code does not exist. Check the 4 letters.',
  'this room is full': 'That room is full. Ask for another code.',
  'this game already started': 'That race already started. Ask for a fresh room code.',
  // Three refusals a child can actually fix, so each one says what to do next
  // instead of the old catch-all "already started" (D1, D2).
  'that name is already in this room':
    'Someone here is already using that name. Add a letter or a number.',
  'a round is playing right now':
    'A round is playing right now. You can join the moment it ends.',
  'this lesson is finished': 'That lesson is finished. Ask your teacher for a new room code.',
  'that race is finished': 'That race is finished. Ask for a fresh room code.',
  'only the host can start': 'Only the person who made the room can start the race.',
  'hostkey or playerid is required': 'This device is not the teacher for that room.',
  'hostkey is not valid': 'This device is not the teacher for that room.',
  'kind must be race, climb, dash or tower': 'That game is not one this room can play.',
  'wait for a second player to join before you start':
    'Waiting for a second player. A race needs two people.',
  'wait for a player to join before you start':
    'Nobody has joined yet. Wait for the first player, then start.',
  'only the host can do that': 'Only the teacher\u2019s device can do that.',
  // The server says "a game is already running" for anything that is not a
  // lobby, which includes a room the teacher already finished. Neither the
  // teacher nor a child should have to work out which one they hit, so the
  // wording covers both without claiming the wrong one.
  'a game is already running':
    'This room is not waiting in the lobby, so a new game cannot start. If the class is finished, make a new room.',
  'the round is not finished yet':
    'This room cannot go back to the games list right now. Wait for the round to finish.',
  'could not start that game': 'That game could not start. Try again.',
  'there is no game running to end':
    'There is no round running, so there is nothing to end.',
  'questionsperround must be a whole number between 6 and 30':
    'Pick a round length between 6 and 30 questions.',
  'this device is not signed in to this game, please join again with the room code':
    NOT_SIGNED_IN,
  'code taken': 'That room code is already in use. Try again.',
  'could not create the room': 'The room could not be made. Try again.',
  'could not find a free room code, please try again':
    'Every room code is busy right now. Try again in a moment.',
  'unknown room action': 'The room did not understand that. Go back and try again.',
  'body must be JSON': 'The room did not understand that. Go back and try again.',
};

/** Longer than this is a stack trace or a dump, not a sentence for a player. */
const MAX_SERVER_MESSAGE = 120;

/** Turns whatever the server said into one plain sentence in the app's voice. */
export function inOurVoice(raw: string | null | undefined, status: number): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed || trimmed.length > MAX_SERVER_MESSAGE) return plainError(status);
  const known = SERVER_WORDING[trimmed.toLowerCase()];
  if (known) return known;
  const sentence = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const text = await response.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!response.ok) {
    // A rate-limit reply always gets our own wording: whatever the server says
    // about buckets and windows is not something a class needs to read.
    const fromServer =
      response.status === 429 ? null : (data as { error?: string } | null)?.error;
    throw new RoomError(inOurVoice(fromServer, response.status), response.status);
  }
  return data as T;
}

function postJson(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

/**
 * The legacy "Race a friend" room: the creator uploads the questions and the
 * first person to join becomes the host. Unchanged from week 1.
 */
export async function createRoom(input: {
  set: VocabSet;
  questions: QuizQuestion[];
  perQuestionMs: number;
}): Promise<string> {
  const data = await call<{ code?: string }>('/api/rooms', postJson(input));
  if (!data?.code) throw new Error('The server did not give us a room code.');
  return data.code;
}

/**
 * A class room. No questions are uploaded: the server builds a fresh list from
 * the set at every round start, so the answer key never leaves it.
 *
 * The `hostKey` comes back exactly once, here. It is what lets this device (and
 * only this device) start a round, return to the lobby, or finish the lesson,
 * and it is never part of the room state, so it cannot leak through a poll.
 */
export async function createTeacherRoom(set: VocabSet): Promise<{
  code: string;
  hostKey: string;
  createdAt: number;
}> {
  const data = await call<{ code?: string; hostKey?: string; createdAt?: number }>(
    '/api/rooms',
    postJson({ set, teacher: true })
  );
  if (!data?.code) throw new Error('The server did not give us a room code.');
  if (!data.hostKey) throw new Error('The server did not give us the teacher key.');
  // The room's identity, stored WITH the key so the device is bound from the
  // first millisecond rather than from the first state it happens to see
  // (Codex round 2, SHOULD 1). A server too old to send it leaves the key
  // unbound, which is the previous behaviour and no worse.
  const createdAt = typeof data.createdAt === 'number' ? data.createdAt : 0;
  return { code: data.code, hostKey: data.hostKey, createdAt };
}

export async function joinRoom(
  code: string,
  name: string
): Promise<{ playerId: string; memberKey: string; envelope: RoomEnvelope }> {
  const data = await call<RoomEnvelope & { playerId?: string; memberKey?: string }>(
    `/api/rooms/${code}/join`,
    postJson({ name })
  );
  absorb(data);
  if (!data.playerId) throw new Error('That room is full or has already started.');
  // A join without a key is not a join. Storing an empty one used to look like
  // success and then failed 403 on this child's first answer, which is the
  // worst moment to find out (Codex round 2, SHOULD 2).
  if (!data.memberKey) throw new Error('That room could not sign this device in. Try joining again.');
  return { playerId: data.playerId, memberKey: data.memberKey, envelope: data };
}

/**
 * What was the right answer to question `index`? The projector's question, and
 * only the projector's: the server checks the host key AND that the question is
 * shut before it says (D3). Returns null while it is withholding.
 */
export async function revealAnswer(
  code: string,
  index: number,
  auth: HostAuth
): Promise<number | null> {
  const data = await call<{ index?: number; answer?: number }>(
    `/api/rooms/${code}/reveal`,
    postJson({ ...hostBody(auth), index })
  );
  const answer = data.answer;
  if (typeof answer !== 'number' || !Number.isInteger(answer) || answer < 0) return null;
  return answer;
}

/** The v1 alias: starts a `race` round in a legacy room. Host-only, server-side. */
export async function startRoom(code: string, playerId: string): Promise<RoomEnvelope> {
  return absorb(
    await call<RoomEnvelope>(`/api/rooms/${code}/start`, postJson({ playerId }))
  );
}

/** How the teacher set this round up. */
export interface RoundSetup {
  kind: RoundKind;
  /**
   * How many questions to ask. The server clamps it to 6..30 and defaults to
   * 12, so a 30-word set is a five-minute round rather than a 13-minute one
   * (Codex round 1, MUST-FIX 5). Omitted means "whatever the server defaults
   * to", which is the same 12.
   */
  questionsPerRound?: number;
  perQuestionMs?: number;
}

/** Starts a round. Lobby-only and host-only, both enforced server-side. */
export async function startRound(
  code: string,
  auth: HostAuth,
  setup: RoundSetup
): Promise<RoomEnvelope> {
  return absorb(
    await call<RoomEnvelope>(
      `/api/rooms/${code}/round`,
      postJson({
        ...hostBody(auth),
        kind: setup.kind,
        questionsPerRound: setup.questionsPerRound,
        perQuestionMs: setup.perQuestionMs,
      })
    )
  );
}

/**
 * "End round now": stops the round that is running, keeps every score exactly
 * as it stands, writes the history row and moves the room to `results`.
 *
 * NOT the same button as Finish. `/close` is the end of the lesson and cannot
 * be undone; this one leaves the roster, the totals and the next game intact,
 * which is what a teacher who started the wrong game actually wants (Codex
 * round 1, MUST-FIX 5).
 */
export async function endRound(code: string, auth: HostAuth): Promise<RoomEnvelope> {
  return absorb(
    await call<RoomEnvelope>(`/api/rooms/${code}/end`, postJson(hostBody(auth)))
  );
}

/** "Pick another game": back to the lobby, roster intact. Results-only. */
export async function backToLobby(code: string, auth: HostAuth): Promise<RoomEnvelope> {
  return absorb(
    await call<RoomEnvelope>(`/api/rooms/${code}/lobby`, postJson(hostBody(auth)))
  );
}

/** "Finish": every device stops polling. The end of the lesson. */
export async function closeRoom(code: string, auth: HostAuth): Promise<RoomEnvelope> {
  return absorb(
    await call<RoomEnvelope>(`/api/rooms/${code}/close`, postJson(hostBody(auth)))
  );
}

/**
 * Opens one of the three chests in a Treasure Dash round.
 *
 * The outcome is decided by the round's secret seed before anybody picks, so
 * this cannot be re-rolled by retrying, and a refused pick comes back with no
 * `outcome` at all rather than an empty one.
 */
export async function sendPick(
  code: string,
  who: PlayerAuth,
  index: number,
  chest: number
): Promise<RoomEnvelope> {
  return absorb(
    await call<RoomEnvelope>(
      `/api/rooms/${code}/pick`,
      postJson({ playerId: who.playerId, memberKey: who.memberKey, index, chest })
    )
  );
}

/** The server times the answer from its own clock; we send no timing at all. */
export async function sendAnswer(
  code: string,
  who: PlayerAuth,
  index: number,
  choice: number
): Promise<RoomEnvelope> {
  return absorb(
    await call<RoomEnvelope>(
      `/api/rooms/${code}/answer`,
      postJson({ playerId: who.playerId, memberKey: who.memberKey, index, choice })
    )
  );
}

/**
 * True when the server refused on identity grounds: a student whose
 * `memberKey` is not the room's, or a teacher whose `hostKey` is not. Both are
 * the same 403, and both mean this device is not who it thinks it is here.
 */
export function isNotSignedIn(error: unknown): boolean {
  return error instanceof RoomError && error.status === 403;
}

/**
 * Who this device is, on a plain state read.
 *
 * A GET has no body, so the credentials ride as headers. It matters for
 * exactly one game: in a Sky Tower round the server sends a child her own
 * block count and zeroes everybody else's, and it cannot do that for a caller
 * it cannot identify. Every other round puts the same bytes on every wire, so
 * sending nothing here is always safe and never wrong.
 */
export interface PollAuth {
  hostKey?: string | null;
  playerId?: string | null;
  memberKey?: string | null;
}

function pollHeaders(auth?: PollAuth): Record<string, string> | undefined {
  if (!auth) return undefined;
  const headers: Record<string, string> = {};
  if (auth.hostKey) headers['x-host-key'] = auth.hostKey;
  if (auth.playerId) headers['x-player-id'] = auth.playerId;
  if (auth.memberKey) headers['x-member-key'] = auth.memberKey;
  return Object.keys(headers).length > 0 ? headers : undefined;
}

export async function fetchRoom(
  code: string,
  version?: number,
  auth?: PollAuth
): Promise<RoomEnvelope> {
  const query = typeof version === 'number' ? `?v=${version}` : '';
  const headers = pollHeaders(auth);
  return absorb(
    await call<RoomEnvelope>(`/api/rooms/${code}${query}`, headers ? { headers } : undefined)
  );
}

/**
 * The choice to paint green, or null when the server did not say. `-1` (and
 * anything else out of range) is the server withholding the answer key, so it
 * must never be treated as "choice minus one was right".
 */
export function revealedChoice(
  envelope: RoomEnvelope,
  choiceCount: number
): number | null {
  const value = envelope.correctChoice;
  if (typeof value !== 'number' || !Number.isInteger(value)) return null;
  return value >= 0 && value < choiceCount ? value : null;
}

