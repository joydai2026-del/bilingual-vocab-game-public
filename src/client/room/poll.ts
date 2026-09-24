// Room polling. The server tells us how soon to come back (`nextPollMs`:
// 2000 in the lobby, 1000 while playing, 0 = stop) and answers `unchanged`
// when nothing moved since the version we hold.
//
// Most errors are worth another try: a dropped connection, a 500, a 429 that
// wants a longer wait. A 404 is not. The room is gone and no amount of asking
// brings it back, so polling stops and the caller is told once.

import { fetchRoom, RoomError, type PollAuth, type RoomEnvelope } from './api';

export interface PollOptions {
  getVersion: () => number | undefined;
  /**
   * Who is polling, re-read on every tick because a child's membership is
   * minted after the first poll and a teacher's key can be forgotten mid-
   * lesson. Absent means "do not say", which is what a join screen wants.
   */
  getAuth?: () => PollAuth | undefined;
  onEnvelope: (envelope: RoomEnvelope) => void;
  onError?: (error: Error) => void;
}

const DEFAULT_MS = 1500;
const ERROR_MS = 3000;
/** Being told to slow down and then retrying every 3s is how you stay blocked. */
const RATE_LIMIT_MS = 15000;

/** Starts polling; returns a stop function. Safe to call stop twice. */
export function startPolling(code: string, options: PollOptions): () => void {
  let stopped = false;
  let timer = 0;

  const schedule = (ms: number): void => {
    if (stopped) return;
    timer = window.setTimeout(run, Math.max(250, ms));
  };

  async function run(): Promise<void> {
    if (stopped) return;
    try {
      const envelope = await fetchRoom(code, options.getVersion(), options.getAuth?.());
      if (stopped) return;
      options.onEnvelope(envelope);
      const next = envelope.nextPollMs;
      if (next === 0) {
        stopped = true;
        return;
      }
      schedule(typeof next === 'number' ? next : DEFAULT_MS);
    } catch (error) {
      if (stopped) return;
      // Stop before the callback, so a handler that repaints the screen is not
      // undone by a poll that was already in flight.
      const gone = error instanceof RoomError && error.status === 404;
      if (gone) stopped = true;
      options.onError?.(error instanceof Error ? error : new Error('Lost the room connection.'));
      if (gone) return;
      schedule(error instanceof RoomError && error.status === 429 ? RATE_LIMIT_MS : ERROR_MS);
    }
  }

  void run();

  return () => {
    stopped = true;
    window.clearTimeout(timer);
  };
}

