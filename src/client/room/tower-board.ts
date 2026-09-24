// The class tower, on the projector.
//
// One tower, built by everybody. The scene itself is the solo game's
// (`sky-tower-3d.ts`, or `sky-tower-css.ts` when the device has no WebGL 2):
// this file is the part that turns a POLL into blocks, which is the only thing
// a room does differently from a child playing alone.
//
// The hard bit is ownership. The server records how many questions each child
// got right and nothing about the ORDER they landed in, because the order is a
// picture and not a rule. So the projector keeps its own append-only list: each
// poll it works out how many new blocks each child earned since the last one
// and appends that many in that child's colour. Blocks already standing never
// change colour, which is the whole point of tinting them at all.
//
// A projector that JOINS a round already in progress (a reload, a second
// screen) has no history to append to. It repaints from the counts alone, in
// roster round-robin, which is a stable picture of who contributed what even
// though it is not the order the class actually saw. Every block after that is
// appended for real.

import { BURST_GAP_MS } from '../../shared/sky-tower';
import { beanColor } from '../scene/palette';
import { wantsFlat } from '../scene/webgl';
import { mountTowerFlat } from '../games/sky-tower-css';
import type { TowerScene } from '../games/sky-tower-3d';

/** One child, as the tower cares about them: a colour and a count. */
export interface TowerContributor {
  id: string;
  colorIndex: number;
  correct: number;
}

export interface TowerBoard {
  readonly node: HTMLElement;
  /**
   * The class as of this poll. New blocks land 120 ms apart, in roster order,
   * exactly as the solo game spaces a burst; a count that went DOWN (which only
   * a fresh round can do) repaints from scratch.
   */
  update(contributors: TowerContributor[]): void;
  /** How many blocks are standing. What the harness counts. */
  height(): number;
  /** The win: confetti over the top block. */
  finish(): void;
  resize(): void;
  dispose(): void;
}

/**
 * Blocks for a tower nobody watched grow: roster round-robin over the counts.
 *
 * Round-robin rather than "all of Ana's, then all of Ben's", because a solid
 * block of one colour reads as one child having built the tower, which is the
 * opposite of what the round was.
 */
function resyncOrder(contributors: TowerContributor[]): number[] {
  const left = contributors.map((c) => Math.max(0, c.correct));
  const out: number[] = [];
  let moved = true;
  while (moved) {
    moved = false;
    for (let i = 0; i < contributors.length; i += 1) {
      if (left[i] <= 0) continue;
      left[i] -= 1;
      out.push(contributors[i].colorIndex);
      moved = true;
    }
  }
  return out;
}

export async function createTowerBoard(
  container: HTMLElement,
  opts: { target: number; flat?: boolean }
): Promise<TowerBoard> {
  const node = document.createElement('div');
  node.className = 'kit-stage tower-board';
  const overlay = document.createElement('div');
  overlay.className = 'kit-overlay';
  node.append(overlay);
  node.dataset.blocks = '0';
  container.replaceChildren(node);

  const label = `${opts.target} blocks`;
  const flat = opts.flat ?? wantsFlat();

  let scene: TowerScene;
  if (flat) {
    scene = mountTowerFlat(node, overlay, { target: opts.target, cloudLabel: label });
  } else {
    try {
      const { mountTower3d } = await import('../games/sky-tower-3d');
      scene = await mountTower3d(node, overlay, { target: opts.target, cloudLabel: label });
    } catch {
      // The three chunk did not arrive, or this device cannot build a context
      // after all. A class does not stop for that.
      node.replaceChildren(overlay);
      overlay.replaceChildren();
      node.classList.remove('kit-sky-day', 'kit-sky-sunset');
      scene = mountTowerFlat(node, overlay, { target: opts.target, cloudLabel: label });
    }
  }

  /** What each child had last poll, so a delta can be appended once. */
  let seen = new Map<string, number>();
  let colors: string[] = [];
  let seeded = false;
  let disposed = false;
  const pending: number[] = [];
  let drip = 0;

  /**
   * How many blocks the SCENE has been told to draw, on the element itself.
   *
   * Not a debug hook: it is the only externally readable statement of what the
   * renderer was actually handed, which is the difference between "the class
   * total is 9" and "nine blocks are standing". The live harness asserts the
   * two agree, and a screenshot cannot.
   */
  function stampHeight(): void {
    node.dataset.blocks = String(colors.length);
  }

  function land(colorIndex: number): void {
    const color = beanColor(colorIndex).fill;
    scene.drop(colors.length, colorIndex, color);
    colors.push(color);
    stampHeight();
  }

  /** Empties the queue one block at a time, BURST_GAP_MS apart. */
  function pump(): void {
    if (disposed || drip !== 0) return;
    const next = pending.shift();
    if (next === undefined) return;
    land(next);
    drip = window.setTimeout(() => {
      drip = 0;
      pump();
    }, BURST_GAP_MS);
  }

  function repaint(contributors: TowerContributor[]): void {
    pending.length = 0;
    window.clearTimeout(drip);
    drip = 0;
    colors = resyncOrder(contributors).map((index) => beanColor(index).fill);
    scene.setBlocks(colors);
    stampHeight();
  }

  return {
    node,
    update(contributors: TowerContributor[]): void {
      if (disposed) return;
      if (!seeded) {
        seeded = true;
        seen = new Map(contributors.map((c) => [c.id, Math.max(0, c.correct)]));
        repaint(contributors);
        return;
      }
      // A count that fell is a new round, or a roster the server rebuilt.
      // Nothing to animate: draw what is true now.
      const fell = contributors.some((c) => Math.max(0, c.correct) < (seen.get(c.id) ?? 0));
      if (fell) {
        seen = new Map(contributors.map((c) => [c.id, Math.max(0, c.correct)]));
        repaint(contributors);
        return;
      }
      for (const c of contributors) {
        const before = seen.get(c.id) ?? 0;
        const now = Math.max(0, c.correct);
        for (let i = before; i < now; i += 1) pending.push(c.colorIndex);
        seen.set(c.id, now);
      }
      pump();
    },
    height(): number {
      return colors.length;
    },
    finish(): void {
      if (disposed) return;
      // Everything still in the air lands first, so the confetti is not thrown
      // over a tower that is two blocks short of what the class earned.
      while (pending.length > 0) land(pending.shift()!);
      window.clearTimeout(drip);
      drip = 0;
      scene.finish();
    },
    resize(): void {
      if (!disposed) scene.resize();
    },
    dispose(): void {
      disposed = true;
      window.clearTimeout(drip);
      pending.length = 0;
      scene.dispose();
    },
  };
}

