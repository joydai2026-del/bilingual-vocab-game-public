// A room with no server in it.
//
// This is the biggest architectural win in the week-2 plan: solo Cloud Climb is
// not a second implementation of the game. It builds a real `RoomState` and
// drives the SAME pure reducers the Durable Object drives (`createRoom`, `join`,
// `startRound`, `answer`, `settle`), with three seeded CPU beans standing in for
// the classmates. A rule bug here is a rule bug in the room, and one test over
// `src/shared/round.ts` covers both.
//
// Solo Treasure Dash was cut for week 2, so nothing here opens a chest. Adding
// it is a `pick` call on the same reducers, not a second game.
//
// The only thing this file owns is the clock: it feeds `Date.now()` into the
// reducers where the DO would feed its own.

import { cpuMoveMs, cpuPlan, type CpuMove, type CpuPace } from '../../shared/cpu';
import { answer as applyAnswer, createRoom, join, settle, startRound } from '../../shared/room';
import type { Direction, RoomState, RoundKind, VocabSet } from '../../shared/types';

export interface LocalRoomOptions {
  set: VocabSet;
  kind: RoundKind;
  /** The human's name on their own bean. */
  myName: string;
  /** Three of these become the CPU beans. */
  cpuNames: string[];
  pace: CpuPace;
  perQuestionMs: number;
  directions: Direction[];
  /** Everything seeded from here, so a solo game replays exactly. */
  seed: string;
  now: number;
}

interface CpuBean {
  id: string;
  moves: CpuMove[];
  /** Next move not yet applied. */
  cursor: number;
}

export interface LocalAnswer {
  accepted: boolean;
  correct: boolean;
  /** -1 when the reducer refused, exactly as the server withholds it. */
  correctChoice: number;
}

export class LocalRoom {
  private room: RoomState;
  private readonly cpus: CpuBean[] = [];
  readonly myId: string;

  constructor(opts: LocalRoomOptions) {
    let room = createRoom('SOLO', opts.set, [], opts.perQuestionMs, opts.now, {
      teacher: true,
    });

    const mine = join(room, opts.myName, opts.now);
    room = mine.state;
    if (!mine.playerId) throw new Error('the local room would not take a player');
    this.myId = mine.playerId;

    for (const name of opts.cpuNames) {
      const joined = join(room, name, opts.now);
      room = joined.state;
      if (joined.playerId) {
        this.cpus.push({ id: joined.playerId, moves: [], cursor: 0 });
      }
    }

    room = startRound(
      room,
      // No projector here: this child reads the answer off her own screen the
      // instant she taps, so the round carries no reveal pause and keeps the
      // brisk one-question-every-few-seconds pacing the solo games shipped with
      // (round-2 review, SHOULD-FIX 3).
      { kind: opts.kind, seed: opts.seed, directions: opts.directions, projector: false },
      opts.now
    );
    if (room.phase !== 'round' || !room.round) {
      throw new Error('the local room would not start a round');
    }

    // The plan is drawn once the question count is known, and from a seed that
    // includes the bean's own id, so three CPUs on one seed play differently.
    for (const cpu of this.cpus) {
      cpu.moves = cpuPlan(`${opts.seed}:${cpu.id}`, room.round.questionCount, opts.pace);
    }

    this.room = room;
  }

  state(): RoomState {
    return this.room;
  }

  /** This device's own player, for score and step readouts. */
  myPlayer(): RoomState['players'][number] | undefined {
    return this.room.players.find((player) => player.id === this.myId);
  }

  /**
   * Answers as the human. Returns what the room's reply would carry, including
   * the withheld `-1` when the reducer refused, so the screen behaves the same
   * way it does against the real server.
   */
  answer(index: number, choice: number, now: number): LocalAnswer {
    const before = this.room;
    const after = applyAnswer(before, this.myId, index, choice, now);
    if (after === before) return { accepted: false, correct: false, correctChoice: -1 };
    this.room = after;
    const question = after.questions[index];
    return {
      accepted: true,
      correct: choice === question.answer,
      correctChoice: question.answer,
    };
  }

  /**
   * Advances the clock: applies every CPU move that is now due, then lets the
   * room's own finish conditions run. Returns true when anything moved, so a
   * caller can repaint only when there is something to repaint.
   */
  tick(now: number): boolean {
    const before = this.room;
    const round = this.room.round;
    if (round && this.room.phase === 'round') {
      for (const cpu of this.cpus) {
        while (cpu.cursor < cpu.moves.length) {
          const move = cpu.moves[cpu.cursor];
          const at =
            round.startsAt + move.index * round.slotMs + cpuMoveMs(move, round.perQuestionMs);
          if (at > now) break;
          cpu.cursor++;
          this.applyCpu(cpu, move, at, now);
        }
      }
    }
    this.room = settle(this.room, now);
    return this.room !== before;
  }

  /**
   * One CPU move, through the same reducers a real player goes through.
   *
   * The move is applied at the instant it was planned for, not at the instant
   * this tick happened to run, so a browser that skipped a frame does not hand
   * the CPU a slower time than it planned. A move whose window has already shut
   * (a backgrounded tab) is simply refused by the reducer, which is the honest
   * outcome: that bean missed the question.
   */
  private applyCpu(cpu: CpuBean, move: CpuMove, at: number, now: number): void {
    const question = this.room.questions[move.index];
    if (!question) return;

    const choice = move.correct
      ? question.answer
      : (question.answer + 1) % question.choices.length;
    this.room = applyAnswer(this.room, cpu.id, move.index, choice, Math.min(at, now));
  }
}

