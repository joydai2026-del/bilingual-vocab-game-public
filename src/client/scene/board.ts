// The board every game screen draws on, behind one interface.
//
// Week 2 ships ONE implementation: the 2D CSS board (`css-board.ts`). Three.js
// is off the critical path per the plan's amendments, so `createBoard` is the
// seam it would slot into later, not a chooser between two live renderers
// today. The room screen must never know which board it got.

export interface BoardPlayer {
  id: string;
  name: string;
  /** Index into the palette. Stable for the life of a room. */
  colorIndex: number;
  /** Cloud Climb: platforms climbed. Treasure Dash: unused, pass 0. */
  step: number;
  score: number;
  isMe: boolean;
}

/**
 * What a chest turned out to hold. Written permissively on purpose: the server
 * owns the real `ChestOutcome` shape, and the board only needs to know which of
 * the three flourishes to play and what number to float.
 */
export type BoardOutcome =
  | { kind: 'points'; points: number }
  | { kind: 'swap'; withPlayerId?: string; before?: number; after?: number }
  | { kind: 'steal'; fromPlayerId?: string; points?: number };

export interface BoardOptions {
  /** Platforms to the top gate. Ignored by Treasure Dash. */
  height: number;
  /** True on a student's device: a small strip instead of a full tower. */
  compact: boolean;
}

export interface Board {
  /** The element the board drew itself into. */
  readonly node: HTMLElement;
  /**
   * The roster. Adding, removing or renaming a player is safe at any time;
   * a `step` that moved without a `hop()` call is simply placed, not animated,
   * which is what a late-joining device wants.
   */
  setPlayers(players: BoardPlayer[]): void;
  /** Squash, arc, land. Also updates that player's step. */
  hop(playerId: string, toStep: number): void;
  /** A wobble in place. The stumble-only wrong-answer feedback. */
  stumble(playerId: string): void;
  /** Opens one of the three chests and plays the outcome's flourish. */
  chest(playerId: string, chestIndex: number, outcome: BoardOutcome): void;
  /**
   * Floats one short label off a bean. The three-chest reveal belongs to the
   * device whose player actually opened it (only that device is told what was
   * inside), so the projected teacher board uses this instead: it says what
   * changed on the scoreboard, which is something the room state really knows.
   */
  badge(playerId: string, text: string, tone: 'good' | 'swap' | 'steal'): void;
  /** Called on a viewport change. The CSS board is fluid, so this is cheap. */
  resize(): void;
  dispose(): void;
}

/** True when the device asked for less movement. Animations then just cut. */
export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

export async function createBoard(
  container: HTMLElement,
  kind: 'climb' | 'dash',
  opts: BoardOptions
): Promise<Board> {
  const { createCssBoard } = await import('./css-board');
  return createCssBoard(container, kind, opts);
}

