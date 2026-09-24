// RoomDO: one Durable Object per room code. It is a thin shell around the pure
// reducer in src/shared/room.ts - persistence, HTTP, alarms, nothing else. All
// game rules (windows, scoring, chest outcomes, finish conditions, ranking) live
// in the reducer.
//
// Persistence: state is written to ctx.storage after EVERY mutation and reloaded
// in the constructor under blockConcurrencyWhile, so a room survives the DO being
// evicted and re-instantiated mid-round. A round START writes meta and questions
// together (saveRoundStart), because two separate puts leave a window where an
// evicted DO reloads the new round against the old question list.
//
// ATOMICITY RULE (the one thing to get right in this file): a Durable Object's
// input gate does NOT span a non-storage await. So every handler reads
// `request.json()` FIRST, and only then computes and saves, with no non-storage
// await in between. Two picks arriving in the same tick therefore apply in
// arrival order, each against the state as it stands when it is applied, and a
// swap can never read a score another swap is halfway through changing.
//
// Storage size is bounded at the front door, not by the key split: the router
// caps the request body AND the serialized {set, questions} payload at the policy
// limit (256 KB by default) before a room is ever created.

import type {
  AnswerEnvelope,
  JoinEnvelope,
  PickEnvelope,
  QuizQuestion,
  RoomEnvelope,
  RoomState,
  RoundKind,
  VocabSet,
} from '../shared/types';
import {
  MIN_PLAYERS,
  answer,
  close,
  createRoom,
  endNow,
  join,
  minPlayersFor,
  nextDeadline,
  nextPollMsFor,
  pick,
  pickWindowFor,
  publicState,
  type RoomViewer,
  revealedAnswerFor,
  revealedChoice,
  settle,
  start,
  startRound,
  toLobby,
} from '../shared/room';
import {
  KEY_DELETE_AT,
  loadHostKey,
  loadMembers,
  loadRoom,
  saveHostKey,
  saveJoin,
  saveNewRoom,
  saveRoomMeta,
  saveRoundStart,
  type RoomStorage,
} from './persist';
import { NOT_A_MEMBER, isHostAuthorized, isMemberAuthorized, isRevealAuthorized } from './pure';
import type { Env } from './index';

/** Rooms self-destruct 2h after creation (plan: "Room deleted 2h after creation"). */
export const ROOM_TTL_MS = 2 * 60 * 60 * 1000;

const ROUND_KINDS: RoundKind[] = ['race', 'climb', 'dash', 'tower'];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

interface HostBody {
  hostKey?: unknown;
  playerId?: unknown;
}

interface MemberBody {
  playerId?: unknown;
  memberKey?: unknown;
}

export class RoomDO implements DurableObject {
  private room: RoomState | null = null;

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env
  ) {
    // Reload before any request is served. blockConcurrencyWhile guarantees no
    // fetch() runs against a half-loaded object.
    this.ctx.blockConcurrencyWhile(async () => {
      this.room = await loadRoom(this.storage());
    });
  }

  // --- persistence -------------------------------------------------------

  private storage(): RoomStorage {
    return this.ctx.storage as unknown as RoomStorage;
  }

  private async saveMeta(): Promise<void> {
    if (!this.room) return;
    await saveRoomMeta(this.storage(), this.room);
  }

  /**
   * Points the single DO alarm at whichever deadline comes first:
   *   - the end of the round schedule (so a round finishes even if everyone
   *     closes their tab),
   *   - 60s of inactivity during a round,
   *   - 15 minutes idle on the results screen, which closes the room,
   *   - 30 minutes idle in the lobby, which also closes it,
   *   - the 2h delete.
   *
   * The first three move on every accepted mutation, so this is re-armed after
   * EVERY mutation, not only after a start.
   */
  private async rescheduleAlarm(now: number): Promise<void> {
    const deleteAt = await this.ctx.storage.get<number>(KEY_DELETE_AT);
    const candidates: number[] = [];
    if (deleteAt !== undefined) candidates.push(deleteAt);
    if (this.room) {
      const due = nextDeadline(this.room);
      if (due !== undefined) candidates.push(due);
    }
    const future = candidates.filter((t) => t > now);
    if (future.length === 0) return;
    await this.ctx.storage.setAlarm(Math.min(...future));
  }

  async alarm(): Promise<void> {
    const now = Date.now();

    const deleteAt = await this.ctx.storage.get<number>(KEY_DELETE_AT);
    if (deleteAt !== undefined && now >= deleteAt) {
      await this.ctx.storage.deleteAll();
      this.room = null;
      return;
    }

    await this.settleNow(now);
    await this.rescheduleAlarm(now);
  }

  // --- responses ---------------------------------------------------------

  /**
   * Every response goes through here, and every response is built from
   * `publicState`, so there is exactly one place the answer key or the round
   * seed could leak and it does not.
   */
  private envelope(
    extra: Record<string, unknown> = {},
    viewer: RoomViewer = { role: 'anon' }
  ): Response {
    const room = this.room!;
    const base: RoomEnvelope = {
      state: publicState(room, viewer),
      version: room.version,
      nextPollMs: nextPollMsFor(room.phase, room.model),
      serverNow: Date.now(),
    };
    return json({ ...base, ...extra });
  }

  /**
   * Lets the clock-driven transitions (schedule over, 60s inactivity, 15 min
   * idle on results, 30 min idle in the lobby) take effect on a plain read, so a room converges without
   * waiting for the alarm. Returns true when the state changed.
   */
  private async settleNow(now: number): Promise<boolean> {
    if (!this.room) return false;
    const next = settle(this.room, now);
    if (next === this.room) return false;
    this.room = next;
    await this.saveMeta();
    return true;
  }

  /**
   * Host authorization: the teacher's host key, or the legacy player-host of a
   * "Race a friend" room. Never both, and an empty hostId never matches.
   *
   * The key is checked against THIS room's own storage slot, which is why a host
   * key from a room that was deleted and whose code was later reused does not
   * work: the reused code addresses a fresh Durable Object, whose storage was
   * wiped, so the stored key is the new room's and the old one matches nothing.
   */
  private async isHost(body: HostBody): Promise<boolean> {
    // A storage read does not break the DO input gate, so this stays inside the
    // atomic section of the handler that called it.
    const storedHostKey = await loadHostKey(this.storage());
    return isHostAuthorized({
      hostKey: body.hostKey,
      playerId: body.playerId,
      storedHostKey,
      hostId: this.room!.hostId,
    });
  }

  /**
   * Player authorization: the memberKey `join` handed this device, checked
   * against the room's own `members` slot. A model 1 room takes the player id
   * alone (see isMemberAuthorized). Storage read only, so the caller stays
   * inside its atomic section.
   */
  private async isMember(body: MemberBody): Promise<boolean> {
    const playerId = typeof body.playerId === 'string' ? body.playerId : '';
    const members = await loadMembers(this.storage());
    return isMemberAuthorized({
      model: this.room!.model,
      playerId,
      memberKey: body.memberKey,
      storedMemberKey: members[playerId],
    });
  }

  // --- HTTP --------------------------------------------------------------

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const action = url.pathname.replace(/^\/+/, '');
    const now = Date.now();

    if (action === 'create') return this.handleCreate(request, now);

    if (!this.room) return json({ error: 'room not found' }, 404);

    switch (action) {
      case 'join':
        return this.handleJoin(request, now);
      case 'start':
        return this.handleStart(request, now);
      case 'round':
        return this.handleRound(request, now);
      case 'end':
        return this.handleEnd(request, now);
      case 'answer':
        return this.handleAnswer(request, now);
      case 'pick':
        return this.handlePick(request, now);
      case 'lobby':
        return this.handleLobby(request, now);
      case 'close':
        return this.handleClose(request, now);
      case 'reveal':
        return this.handleReveal(request, now);
      case 'state':
        return this.handleState(request, url, now);
      default:
        return json({ error: 'unknown room action' }, 404);
    }
  }

  private async handleCreate(request: Request, now: number): Promise<Response> {
    // Read the body BEFORE the collision guard. A Durable Object's input gate
    // does not span a non-storage await, so checking `this.room` first and then
    // awaiting request.json() let two racing creates both pass the guard, and
    // the second silently overwrote the first.
    let body: {
      code: string;
      set: VocabSet;
      questions?: QuizQuestion[];
      perQuestionMs: number;
      teacher?: boolean;
      /** The configured class size (policy.roomMaxPlayersTeacher). Teacher rooms only. */
      maxPlayers?: number;
    };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return json({ error: 'body must be JSON' }, 400);
    }

    if (this.room) {
      // The generated code collided with a live room; the worker retries.
      return json({ error: 'code taken' }, 409);
    }

    const teacher = body.teacher === true;
    const room = createRoom(
      body.code,
      body.set,
      teacher ? [] : (body.questions ?? []),
      body.perQuestionMs,
      now,
      { teacher, maxPlayers: typeof body.maxPlayers === 'number' ? body.maxPlayers : undefined }
    );
    // Generated here, not in the router: the key travels exactly once, in this
    // response, and otherwise never leaves its own storage slot.
    const hostKey = teacher ? crypto.randomUUID() : undefined;

    try {
      await this.ctx.storage.put(KEY_DELETE_AT, now + ROOM_TTL_MS);
      if (hostKey) await saveHostKey(this.storage(), hostKey);
      await saveNewRoom(this.storage(), room);
    } catch (err) {
      // A half-written room would answer 404 for the next 2h while still holding
      // its code (loadRoom needs all three keys), which is a cheap way to burn
      // codes. Wipe everything so the code is immediately reusable.
      console.error('room create: storage write failed', err instanceof Error ? err.message : err);
      try {
        await this.ctx.storage.deleteAll();
      } catch (cleanupErr) {
        console.error(
          'room create: cleanup failed too',
          cleanupErr instanceof Error ? cleanupErr.message : cleanupErr
        );
      }
      this.room = null;
      return json({ error: 'could not create the room' }, 500);
    }

    // Only now is the room real.
    this.room = room;
    await this.rescheduleAlarm(now);
    // `createdAt` travels with the key so the teacher's device can stamp it
    // immediately. A room code is handed back out once its room expires, and a
    // key stored without the stamp would render somebody else's room as if it
    // owned it until the first host action failed (Codex round 2, SHOULD 1).
    return json(
      hostKey
        ? { code: room.code, hostKey, createdAt: room.createdAt }
        : { code: room.code, createdAt: room.createdAt }
    );
  }

  private async handleJoin(request: Request, now: number): Promise<Response> {
    const body = (await request.json()) as { name: string };
    const result = join(this.room!, body.name, now);
    if (result.playerId === null) {
      // One sentence per reason. "already started" for a full room, or for a
      // name clash, sent the child (and the teacher) after the wrong fix.
      const reason =
        result.refusal === 'duplicate'
          ? 'that name is already in this room'
          : result.refusal === 'closed'
            ? 'this lesson is finished'
            : result.refusal === 'full'
              ? 'this room is full'
              : this.room!.phase === 'round'
                ? 'a round is playing right now'
                : 'that race is finished';
      return json({ error: reason }, 409);
    }
    // The credential this device will prove itself with from now on. Generated
    // here, like the host key, so it travels exactly once (in this response) and
    // otherwise never leaves its own storage slot.
    const memberKey = crypto.randomUUID();
    const members = await loadMembers(this.storage());
    members[result.playerId] = memberKey;

    this.room = result.state;
    await saveJoin(this.storage(), this.room, members);
    await this.rescheduleAlarm(now);
    const extra: Omit<JoinEnvelope, keyof RoomEnvelope> = {
      playerId: result.playerId,
      memberKey,
    };
    // This device just proved who it is by being handed the key, so its reply is
    // written for HER, not for an anonymous reader (panel round 1, M1).
    return this.envelope(extra, { role: 'player', playerId: result.playerId });
  }

  /** The v1 "Race a friend" start. Unchanged on the wire; keeps the room at model 1. */
  private async handleStart(request: Request, now: number): Promise<Response> {
    const body = (await request.json()) as { playerId: string };
    const before = this.room!;
    const next = start(before, body.playerId, now);
    if (next === before) {
      let reason = 'only the host can start';
      if (before.phase !== 'lobby') reason = 'this game already started';
      else if (before.players.length < MIN_PLAYERS) {
        reason = 'wait for a second player to join before you start';
      }
      return json({ error: reason }, 409);
    }
    this.room = next;
    await saveRoundStart(this.storage(), next);
    await this.rescheduleAlarm(now);
    return this.envelope({}, { role: 'player', playerId: body.playerId });
  }

  /** The v2 round start: the teacher picks a game and everyone plays it. */
  private async handleRound(request: Request, now: number): Promise<Response> {
    const body = (await request.json()) as HostBody & {
      kind?: unknown;
      perQuestionMs?: unknown;
      questionsPerRound?: unknown;
    };
    const before = this.room!;

    if (!(await this.isHost(body))) return json({ error: 'only the host can do that' }, 403);
    if (before.phase !== 'lobby') return json({ error: 'a game is already running' }, 409);
    if (before.players.length < minPlayersFor(before)) {
      return json({ error: 'wait for a player to join before you start' }, 409);
    }

    const kind = ROUND_KINDS.includes(body.kind as RoundKind) ? (body.kind as RoundKind) : 'race';
    const perQuestionMs =
      typeof body.perQuestionMs === 'number' ? body.perQuestionMs : before.defaultPerQuestionMs;

    // A legacy room that never uploaded questions cannot build them from a set
    // it does have, so a v2 round always regenerates - except in a v1 room whose
    // uploaded list is the only one it will ever have.
    const questions = before.teacherRoom ? undefined : before.questions;

    // Absent means the default (12). The router has already refused anything
    // outside 6..30, and startRound clamps again, so a direct DO call cannot
    // hand a class a 400-question round either.
    const questionsPerRound =
      typeof body.questionsPerRound === 'number' ? body.questionsPerRound : undefined;

    const next = startRound(
      before,
      { kind, seed: crypto.randomUUID(), perQuestionMs, questions, questionsPerRound },
      now
    );
    if (next === before) return json({ error: 'could not start that game' }, 409);

    this.room = next;
    await saveRoundStart(this.storage(), next);
    await this.rescheduleAlarm(now);
    return this.envelope({}, { role: 'host' });
  }

  private async handleAnswer(request: Request, now: number): Promise<Response> {
    const body = (await request.json()) as {
      playerId: string;
      memberKey?: string;
      index: number;
      choice: number;
    };
    const before = this.room!;
    // Before anything is scored: is this device actually this player? A public
    // player id is not a credential (MUST-FIX 2).
    if (!(await this.isMember(body))) return json({ error: NOT_A_MEMBER }, 403);
    // Out-of-window, duplicate, and unknown-player answers are ignored (the
    // reducer returns the same state); the caller still gets the live state.
    const next = answer(before, body.playerId, body.index, body.choice, now);
    const accepted = next !== before;
    if (accepted) {
      this.room = next;
      await this.saveMeta();
    }
    await this.settleNow(now);
    // Rearm after the mutation so the 60s inactivity clock restarts from THIS
    // answer, and so a settle that just ended the round moves to the results
    // deadline.
    if (accepted) await this.rescheduleAlarm(now);

    // `correct` and `correctChoice` are meaningful only for an answer the server
    // actually recorded. This reply is the one channel the answer key travels
    // on, which is why it is gated on `accepted` rather than on the index alone.
    const question = before.questions[body.index];
    const correct = accepted && question !== undefined && body.choice === question.answer;
    const extra: Omit<AnswerEnvelope, keyof RoomEnvelope> = {
      accepted,
      correct,
      correctChoice: revealedChoice(before, body.index, accepted),
    };
    // A correct answer in a dash round earns the right to open a chest, and the
    // client needs to know how long it has.
    if (correct) {
      const window = pickWindowFor(before, body.index);
      if (window) extra.pick = window;
    }
    // `isMember` above is the same proof `viewerFor` demands on the GET, so the
    // reply is built for the child who sent it. Before this it was built for an
    // anonymous reader, and in a tower round that zeroed HER OWN row: the
    // counter flashed to nothing on every tap, and `alreadyAnswered` read an
    // empty list and handed back a question the server had already scored
    // (panel round 1, M1).
    return this.envelope(extra, { role: 'player', playerId: body.playerId });
  }

  private async handlePick(request: Request, now: number): Promise<Response> {
    const body = (await request.json()) as {
      playerId: string;
      memberKey?: string;
      index: number;
      chest: number;
    };
    const before = this.room!;
    // A chest is single-use, so an unauthenticated pick did not just cheat, it
    // destroyed another player's treasure (MUST-FIX 2).
    if (!(await this.isMember(body))) return json({ error: NOT_A_MEMBER }, 403);
    const result = pick(before, body.playerId, body.index, body.chest, now);
    if (result.accepted) {
      this.room = result.state;
      await this.saveMeta();
    }
    await this.settleNow(now);
    // Re-arm AFTER settling, the same way handleAnswer does (Claude code review
    // round 1, SHOULD-FIX 4). Re-arming first meant that when the last pick of a
    // round ended it, the alarm was left pointing at the round's schedule end
    // instead of the results-idle deadline it had just moved to.
    if (result.accepted) await this.rescheduleAlarm(now);

    // `outcome` is present ONLY on an accepted pick. A refused one must reveal
    // nothing about what was in that chest, or a client could probe all three.
    const extra: Omit<PickEnvelope, keyof RoomEnvelope> = { accepted: result.accepted };
    if (result.accepted) extra.outcome = result.outcome;
    else extra.refusal = result.refusal;
    return this.envelope(extra, { role: 'player', playerId: body.playerId });
  }

  /**
   * "End this round now": the round stops where it is and the room shows the
   * scores as they stand.
   *
   * Distinct from `close` on purpose (MUST-FIX 5). `close` is the end of the
   * lesson and cannot be undone; this one writes the history row and hands the
   * room back to the teacher, so the next round is one tap away and nobody
   * retypes a code.
   */
  private async handleEnd(request: Request, now: number): Promise<Response> {
    const body = (await request.json()) as HostBody;
    const before = this.room!;
    if (!(await this.isHost(body))) return json({ error: 'only the host can do that' }, 403);

    const next = endNow(before, now);
    if (next === before) return json({ error: 'there is no game running to end' }, 409);
    this.room = next;
    await this.saveMeta();
    await this.rescheduleAlarm(now);
    return this.envelope({}, { role: 'host' });
  }

  /** "Pick another game": back to the lobby with the roster intact. */
  private async handleLobby(request: Request, now: number): Promise<Response> {
    const body = (await request.json()) as HostBody;
    const before = this.room!;
    if (!(await this.isHost(body))) return json({ error: 'only the host can do that' }, 403);

    const next = toLobby(before, now);
    if (next === before) return json({ error: 'the round is not finished yet' }, 409);
    this.room = next;
    await this.saveMeta();
    await this.rescheduleAlarm(now);
    return this.envelope({}, { role: 'host' });
  }

  /** "Finish": every client stops polling. */
  private async handleClose(request: Request, now: number): Promise<Response> {
    const body = (await request.json()) as HostBody;
    const before = this.room!;
    if (!(await this.isHost(body))) return json({ error: 'only the host can do that' }, 403);

    const next = close(before, now);
    if (next === before) return this.envelope({}, { role: 'host' });
    this.room = next;
    await this.saveMeta();
    await this.rescheduleAlarm(now);
    return this.envelope({}, { role: 'host' });
  }

  /**
   * The projector asking what the right answer was (D3).
   *
   * Host only, and only for a question whose window and grace have shut, which
   * is `revealedAnswerFor`'s whole job. It is a separate endpoint rather than a
   * field in the polled state for two reasons: the state read is cached by
   * `version`, so a field that becomes true on the clock alone would never
   * arrive; and every device polls that state, while only the teacher's device
   * holds the host key.
   */
  private async handleReveal(request: Request, now: number): Promise<Response> {
    const body = (await request.json()) as HostBody & { index?: unknown };
    // The private host key only, never the legacy public hostId: see
    // isRevealAuthorized. Storage read, so this stays inside the atomic section.
    const storedHostKey = await loadHostKey(this.storage());
    if (!isRevealAuthorized({ hostKey: body.hostKey, storedHostKey })) {
      return json({ error: 'only the host can do that' }, 403);
    }
    const index = typeof body.index === 'number' ? body.index : -1;
    return json({ index, answer: revealedAnswerFor(this.room!, index, now) });
  }

  /**
   * Who is polling, from the identity headers the client puts on its GET.
   *
   * A GET has no body, so the credentials travel as headers rather than in the
   * query string: a host key in a URL ends up in every access log and every
   * Referer. The checks are the SAME two the POST handlers use, so a child
   * cannot read another child's tower count by typing her id into a header.
   *
   * Everything this decides is invisible outside a Sky Tower round; every other
   * kind puts the same bytes on every wire, as it always did.
   */
  private async viewerFor(request: Request): Promise<RoomViewer> {
    const hostKey = request.headers.get('x-host-key');
    if (hostKey) {
      const storedHostKey = await loadHostKey(this.storage());
      if (isRevealAuthorized({ hostKey, storedHostKey })) return { role: 'host' };
    }
    const playerId = request.headers.get('x-player-id');
    const memberKey = request.headers.get('x-member-key');
    if (playerId) {
      const members = await loadMembers(this.storage());
      const ok = isMemberAuthorized({
        model: this.room!.model,
        playerId,
        memberKey,
        storedMemberKey: members[playerId],
      });
      if (ok) return { role: 'player', playerId };
    }
    return { role: 'anon' };
  }

  private async handleState(request: Request, url: URL, now: number): Promise<Response> {
    // A plain read can change the phase (a round whose schedule ran out, a
    // results screen that has gone idle), and a changed phase has a different
    // deadline, so this re-arms like every mutating handler does (Claude code
    // review round 1, SHOULD-FIX 5). Without it the alarm still pointed at the
    // deadline of the phase the room had just left.
    if (await this.settleNow(now)) await this.rescheduleAlarm(now);
    const room = this.room!;
    const viewer = await this.viewerFor(request);
    const seen = Number(url.searchParams.get('v'));
    if (Number.isFinite(seen) && seen === room.version) {
      return json({
        unchanged: true,
        version: room.version,
        nextPollMs: nextPollMsFor(room.phase, room.model),
        serverNow: Date.now(),
      });
    }
    return this.envelope({}, viewer);
  }
}

