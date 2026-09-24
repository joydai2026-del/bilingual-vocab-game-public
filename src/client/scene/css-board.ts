// The 2D board. This is the whole board for week 2: no canvas, no WebGL, no
// dependency. Everything moves with CSS transforms, so the browser composites
// it on the GPU and a projector full of beans stays smooth.
//
// Two layouts, one geometry:
//   - full (teacher screen): a tower. Progress goes UP, players spread across.
//   - compact (student strip): lanes. Progress goes RIGHT, one row per player.
// `place()` is the only code that knows which, so every animation below is
// written once.
//
// All positions are computed in px from the track's measured size rather than
// in CSS percentages, because the beans and the platforms they land on must
// agree to the pixel: a platform drawn by one rule and a bean placed by another
// drift apart at every viewport size.

import type { Board, BoardOptions, BoardOutcome, BoardPlayer } from './board';
import { prefersReducedMotion } from './board';
import { beanColor, paintPaletteVars } from './palette';

const HOP_MS = 460;
const STUMBLE_MS = 560;
const CHEST_MS = 2600;
const BADGE_MS = 1800;

/** Bean box in px, per layout. The CSS reads these as custom properties. */
const SIZE = {
  full: { w: 48, h: 58 },
  compact: { w: 30, h: 34 },
};

/** Room above the tower for the goal star, and under it for the ground. */
const GOAL_BAND = 34;
const GROUND_PAD = 16;
/** Lane height in the compact strip, and the tallest that strip may grow to. */
const LANE_MIN_H = 26;
const LANE_MAX_H = 46;
const COMPACT_MAX_H = 200;
/** Under this, a lane has no room for a name tag under the bean. */
const LANE_TAG_H = 40;
/** Room kept clear at each end of a compact lane, for the bean's name tag. */
const COMPACT_MARGIN = 38;
/** About this many rungs is what reads as a tower, whatever the question count. */
const PLATFORM_TARGET = 12;

interface Slot {
  player: BoardPlayer;
  node: HTMLElement;
  body: HTMLElement;
  scoreOut: HTMLElement;
  nameOut: HTMLElement;
  rail: HTMLElement | null;
  /** True until this bean has been placed once: it appears, it does not fly in. */
  fresh: boolean;
}

export function createCssBoard(
  container: HTMLElement,
  kind: 'climb' | 'dash',
  opts: BoardOptions
): Board {
  const compact = opts.compact;
  const height = Math.max(1, Math.trunc(opts.height) || 1);
  const still = prefersReducedMotion();
  const size = compact ? SIZE.compact : SIZE.full;

  const node = document.createElement('div');
  node.className = [
    'board',
    `board--${kind}`,
    compact ? 'board--compact' : 'board--full',
    still ? 'board--still' : '',
  ]
    .filter(Boolean)
    .join(' ');
  paintPaletteVars(node);
  node.style.setProperty('--bean-w', `${size.w}px`);
  node.style.setProperty('--bean-h', `${size.h}px`);

  const platforms = el('div', 'platforms');
  const goal = el('div', 'goal');
  goal.append(el('span', 'goal-flag', '★'), el('span', 'goal-word', 'Top'));
  const rails = el('div', 'rails');
  const beans = el('div', 'beans');
  const fx = el('div', 'board-fx');
  const track = el('div', 'board-track');
  track.append(platforms, goal, rails, beans, fx);

  const chestStage = el('div', 'chest-stage');
  chestStage.hidden = true;

  node.append(track, chestStage);
  container.replaceChildren(node);

  // The tower's rungs. A Dash board is one ground row, and the compact strip
  // draws a rail per player instead, so neither builds platforms.
  //
  // A rung is NOT drawn per question. A 20-word set would put 21 of them inside
  // half a viewport, closer together than a bean is tall, and the tower would
  // read as ruled paper. Roughly a dozen rungs is what looks like a tower at any
  // question count, so long climbs draw every Nth step and always the top one.
  const platformSteps: number[] = [];
  if (kind === 'climb' && !compact) {
    const stride = Math.max(1, Math.ceil(height / PLATFORM_TARGET));
    for (let i = 0; i <= height; i += stride) platformSteps.push(i);
    if (platformSteps[platformSteps.length - 1] !== height) platformSteps.push(height);
  } else {
    goal.hidden = true;
  }

  const platformNodes = platformSteps.map((step, i) => {
    const platform = el('div', `platform ${i % 2 === 0 ? 'platform--a' : 'platform--b'}`);
    if (step === height) platform.classList.add('platform--top');
    platforms.append(platform);
    return platform;
  });

  let slots: Slot[] = [];
  let disposed = false;
  const timers = new Set<number>();
  /** Bumped by every chest reveal, so an older one cannot hide a newer one. */
  let chestToken = 0;

  const later = (fn: () => void, ms: number): number => {
    const id = window.setTimeout(() => {
      timers.delete(id);
      if (!disposed) fn();
    }, ms);
    timers.add(id);
    return id;
  };

  // ---------- geometry ----------

  /** The y a bean's box sits at for `step`, in px inside the track. */
  function beanY(step: number, trackH: number): number {
    const floor = trackH - size.h - GROUND_PAD;
    if (kind === 'dash') return floor;
    const top = GOAL_BAND;
    if (floor <= top) return Math.max(0, floor);
    return top + (floor - top) * (1 - clamp01(step / height));
  }

  /**
   * Where a bean sits, in px inside the track. One function for both layouts:
   * `step` runs along the game axis, `laneIndex` across it.
   */
  function place(slot: Slot, laneIndex: number, laneCount: number, animate: boolean): void {
    const w = track.clientWidth;
    const h = track.clientHeight;
    // A track that has not been laid out yet (hidden tab, first paint) would
    // park every bean at 0,0 and then jump. Leave them where they are.
    if (w === 0 || h === 0) return;

    const lane = laneCount <= 1 ? 0.5 : (laneIndex + 0.5) / laneCount;
    let x: number;
    let y: number;

    if (compact) {
      // Lanes: one row per player, progress to the right. The bean starts and
      // stops well inside the track because its name tag is centred under it,
      // and the track clips: a bean parked at the very edge loses half its name.
      const run = Math.max(0, w - size.w - 2 * COMPACT_MARGIN);
      const travel = kind === 'dash' ? 0 : run * clamp01(slot.player.step / height);
      x = COMPACT_MARGIN + travel;
      y = lane * h - size.h / 2;
    } else {
      x = (w - size.w) * lane;
      y = beanY(slot.player.step, h);
    }

    if (!animate) slot.node.classList.add('bean--snap');
    slot.node.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
    if (!animate) {
      // Read back so the browser applies the snap before transitions return.
      void slot.node.offsetWidth;
      slot.node.classList.remove('bean--snap');
    }
  }

  /**
   * A bean that has never been placed always snaps: a player joining mid-lesson
   * should appear on their platform, not fly in from the corner. Everything
   * else honours `animate`, which is how a roster update slides a bean that has
   * moved (the `hop()` call then only adds the squash on top).
   */
  function placeAll(animate = false): void {
    layoutPlatforms();
    slots.forEach((slot, index) => {
      place(slot, index, slots.length, animate && !slot.fresh);
      slot.fresh = false;
    });
    layoutRails();
  }

  /** Each rung sits exactly under the beans that stand on it. */
  function layoutPlatforms(): void {
    const h = track.clientHeight;
    if (h === 0 || platformNodes.length === 0) return;
    platformNodes.forEach((platform, i) => {
      platform.style.top = `${Math.round(beanY(platformSteps[i], h) + size.h - 6)}px`;
    });
  }

  /** Compact lanes get a rail behind each bean so a row reads as a track. */
  function layoutRails(): void {
    if (!compact) return;
    slots.forEach((slot, index) => {
      if (!slot.rail) return;
      const lane = slots.length <= 1 ? 0.5 : (index + 0.5) / slots.length;
      slot.rail.style.top = `${(lane * 100).toFixed(2)}%`;
    });
  }

  /**
   * The strip grows a lane per player, up to a ceiling: it sits above a
   * student's question card, so eight beans must not push the question off the
   * screen. Once lanes are tighter than a name tag, only this player's own bean
   * keeps its label; the rest are read by colour and position, which is what a
   * glance at a strip is for anyway.
   */
  function sizeCompactTrack(): void {
    if (!compact) return;
    const lanes = Math.max(2, slots.length);
    const laneH = Math.max(LANE_MIN_H, Math.min(LANE_MAX_H, Math.floor(COMPACT_MAX_H / lanes)));
    track.style.height = `${laneH * lanes}px`;
    node.classList.toggle('board--tight', laneH < LANE_TAG_H);
  }

  // ---------- roster ----------

  function buildSlot(player: BoardPlayer): Slot {
    const color = beanColor(player.colorIndex);
    const bean = el('div', 'bean');
    bean.dataset.playerId = player.id;
    bean.style.setProperty('--fill', color.fill);
    bean.style.setProperty('--rim', color.rim);
    if (player.isMe) bean.classList.add('bean--me');

    const body = el('div', 'bean-body');
    body.append(
      el('i', 'eye eye--l'),
      el('i', 'eye eye--r'),
      el('i', 'blush blush--l'),
      el('i', 'blush blush--r')
    );
    const shadow = el('div', 'bean-shadow');
    const nameOut = el('span', 'bean-name', player.name);
    const scoreOut = el('span', 'bean-score', String(player.score));
    const tag = el('div', 'bean-tag');
    tag.append(nameOut, scoreOut);
    bean.append(shadow, body, tag);
    describe(bean, player, color.name);

    let rail: HTMLElement | null = null;
    if (compact) {
      rail = el('div', 'rail');
      rail.style.setProperty('--rim', color.rim);
      rails.append(rail);
    }

    beans.append(bean);
    return { player, node: bean, body, scoreOut, nameOut, rail, fresh: true };
  }

  function describe(bean: HTMLElement, player: BoardPlayer, colorName: string): void {
    const where = kind === 'climb' ? `, platform ${player.step}` : '';
    bean.setAttribute(
      'aria-label',
      `${player.name}, ${colorName} bean, ${player.score} points${where}`
    );
  }

  function setPlayers(next: BoardPlayer[]): void {
    if (disposed) return;
    const byId = new Map(slots.map((slot) => [slot.player.id, slot]));
    const kept: Slot[] = [];

    for (const player of next) {
      const existing = byId.get(player.id);
      if (existing) {
        byId.delete(player.id);
        if (existing.nameOut.textContent !== player.name) existing.nameOut.textContent = player.name;
        existing.scoreOut.textContent = String(player.score);
        existing.node.classList.toggle('bean--me', player.isMe);
        existing.player = player;
        describe(existing.node, player, beanColor(player.colorIndex).name);
        kept.push(existing);
      } else {
        kept.push(buildSlot(player));
      }
    }

    // Whoever is left in the map is no longer in the room.
    for (const gone of byId.values()) {
      gone.node.remove();
      gone.rail?.remove();
    }

    slots = kept;
    sizeCompactTrack();
    placeAll(true);
  }

  function slotFor(playerId: string): Slot | undefined {
    return slots.find((slot) => slot.player.id === playerId);
  }

  // ---------- animations ----------

  function hop(playerId: string, toStep: number): void {
    const slot = slotFor(playerId);
    if (!slot || disposed) return;
    slot.player = { ...slot.player, step: Math.max(0, Math.trunc(toStep) || 0) };
    describe(slot.node, slot.player, beanColor(slot.player.colorIndex).name);
    place(slot, slots.indexOf(slot), slots.length, true);
    replay(slot.body, 'body--hop', HOP_MS);
  }

  function stumble(playerId: string): void {
    const slot = slotFor(playerId);
    if (!slot || disposed) return;
    replay(slot.body, 'body--stumble', STUMBLE_MS);
  }

  /** A number (or a word) that floats up off a bean and fades. */
  function floatBadge(slot: Slot, text: string, tone: 'good' | 'swap' | 'steal'): void {
    // The wrapper carries the position, the inner span carries the rise: one
    // element cannot animate `transform` and be placed by `transform` at once.
    const badge = el('div', `badge badge--${tone}`);
    badge.style.transform = slot.node.style.transform;
    badge.append(el('span', 'badge-text', text));
    fx.append(badge);
    later(() => badge.remove(), BADGE_MS);
  }

  function chest(playerId: string, chestIndex: number, outcome: BoardOutcome): void {
    if (disposed) return;
    const slot = slotFor(playerId);
    const picked = Math.min(2, Math.max(0, Math.trunc(chestIndex) || 0));
    const token = ++chestToken;

    const row = el('div', 'chest-row');
    for (const i of [0, 1, 2]) {
      const box = el('div', `chest ${i === picked ? 'chest--open' : 'chest--dim'}`);
      box.append(el('div', 'chest-lid'), el('div', 'chest-body'), el('div', 'chest-lock'));
      if (i === picked) box.append(el('div', 'chest-burst', prizeGlyph(outcome)));
      row.append(box);
    }

    chestStage.hidden = false;
    chestStage.replaceChildren(
      row,
      el('p', 'chest-say', prizeWords(outcome, slot?.player.name ?? 'Someone'))
    );

    if (slot) {
      if (outcome.kind === 'points') floatBadge(slot, `+${outcome.points}`, 'good');
      else if (outcome.kind === 'swap') floatBadge(slot, 'SWAP!', 'swap');
      else floatBadge(slot, `STEAL +${outcome.points ?? 0}`, 'steal');
      replay(slot.body, 'body--cheer', HOP_MS);
    }

    later(() => {
      // A second chest opened while this one was showing: it owns the stage now.
      if (token !== chestToken) return;
      chestStage.hidden = true;
      chestStage.replaceChildren();
    }, CHEST_MS);
  }

  function resize(): void {
    if (disposed) return;
    sizeCompactTrack();
    placeAll(false);
  }

  const onWindowResize = (): void => resize();
  window.addEventListener('resize', onWindowResize);

  // The first layout pass often runs before the container has a size (the
  // screen is still being assembled). One frame later it does.
  const firstFrame = window.requestAnimationFrame(() => {
    sizeCompactTrack();
    placeAll(false);
  });

  function dispose(): void {
    disposed = true;
    window.cancelAnimationFrame(firstFrame);
    window.removeEventListener('resize', onWindowResize);
    for (const id of timers) window.clearTimeout(id);
    timers.clear();
    slots = [];
    node.remove();
  }

  function badge(playerId: string, text: string, tone: 'good' | 'swap' | 'steal'): void {
    const slot = slotFor(playerId);
    if (!slot || disposed) return;
    floatBadge(slot, text, tone);
    replay(slot.body, 'body--cheer', HOP_MS);
  }

  const board: Board = { node, setPlayers, hop, stumble, chest, badge, resize, dispose };
  return board;

  // ---------- small helpers ----------

  function replay(target: HTMLElement, className: string, ms: number): void {
    if (still) return;
    target.classList.remove(className);
    void target.offsetWidth; // restart the animation
    target.classList.add(className);
    later(() => target.classList.remove(className), ms + 60);
  }

  function prizeGlyph(outcome: BoardOutcome): string {
    if (outcome.kind === 'points') return '🪙';
    if (outcome.kind === 'swap') return '🔄';
    return '🤲';
  }

  function prizeWords(outcome: BoardOutcome, who: string): string {
    if (outcome.kind === 'points') return `${who} found ${outcome.points} points!`;
    if (outcome.kind === 'swap') return `${who} swapped scores with the leader!`;
    const points = outcome.points ?? 0;
    return points > 0
      ? `${who} took ${points} points from the leader!`
      : `${who} raided the leader's chest!`;
  }
}

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

