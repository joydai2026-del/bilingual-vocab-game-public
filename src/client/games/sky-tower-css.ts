// Sky Tower, flat. The twin that runs when the device has no WebGL 2, when the
// three chunk fails to arrive, or when the URL says `?flat=1`.
//
// Same rules, same numbers, same DOM overlay: the only difference is that the
// blocks are rounded divs on a CSS island instead of one InstancedMesh. It has
// to be the same picture, because a child on an old tablet is playing the same
// lesson as the child next to her.

import type { TowerScene } from './sky-tower-3d';

/**
 * How many blocks are on screen before the stack starts sliding down.
 *
 * Twelve, because that is roughly what the 3D camera holds in frame before it
 * starts to climb, and the two renderers have to show the same picture. At
 * eight the flat twin pushed the island off the bottom of the stage on a
 * finished normal-level tower while the 3D one still showed it.
 */
const VISIBLE_BLOCKS = 12;

/** Share of the stage height the visible part of the tower may take. */
const TOWER_BAND = 0.62;

const MIN_BLOCK_PX = 13;
const MAX_BLOCK_PX = 46;

/** Height of the island top as a share of the stage. Mirrors `--tower-base`. */
const BASE_FRACTION = 0.21;

export function mountTowerFlat(
  stage: HTMLElement,
  overlay: HTMLElement,
  opts: { target: number; cloudLabel?: string }
): TowerScene {
  stage.classList.add('kit-sky-day');

  const world = document.createElement('div');
  world.className = 'tower-flat-world';

  const island = document.createElement('div');
  island.className = 'tower-flat-island';
  island.append(
    Object.assign(document.createElement('div'), { className: 'tower-flat-grass' }),
    Object.assign(document.createElement('div'), { className: 'tower-flat-dirt' })
  );

  const stack = document.createElement('div');
  stack.className = 'tower-flat-stack';

  const cloudLine = document.createElement('div');
  cloudLine.className = 'tower-flat-cloudline';
  for (let i = 0; i < 3; i += 1) {
    const puff = document.createElement('div');
    puff.className = 'kit-flat-cloud';
    puff.style.left = `${8 + i * 34}%`;
    puff.style.width = `${18 + (i === 1 ? 6 : 0)}%`;
    cloudLine.append(puff);
  }

  // The label lives on the OVERLAY, not on the cloud line, so it can be clamped
  // to the top edge while the cloud line itself is still off screen. Same
  // reasoning as the 3D path: a goal you cannot see is not a goal.
  const goalLabel = document.createElement('div');
  goalLabel.className = 'kit-label tower-goal tower-goal-flat';
  goalLabel.textContent = opts.cloudLabel ?? `${opts.target} blocks`;
  overlay.append(goalLabel);

  world.append(island, stack, cloudLine);
  stage.append(world);
  // Same reason as the 3D path: the overlay has to come after the scene to be
  // on top of it, and appending an element already in the stage just moves it.
  stage.append(overlay);

  let blockPx = 26;
  const built: HTMLElement[] = [];

  function measure(): void {
    const h = stage.clientHeight || 360;
    const raw = (h * TOWER_BAND) / VISIBLE_BLOCKS;
    blockPx = Math.max(MIN_BLOCK_PX, Math.min(MAX_BLOCK_PX, raw));
    world.style.setProperty('--tower-block', `${blockPx.toFixed(2)}px`);
    cloudLine.style.bottom = `calc(var(--tower-base) + ${(opts.target * blockPx).toFixed(2)}px + ${(
      blockPx * 0.9
    ).toFixed(2)}px)`;
    slide();
  }

  function slide(): void {
    const over = Math.max(0, built.length - VISIBLE_BLOCKS);
    const shift = over * blockPx;
    world.style.transform = `translateY(${shift.toFixed(2)}px)`;

    const stageH = stage.clientHeight || 320;
    const lineFromBottom = stageH * BASE_FRACTION + opts.target * blockPx + blockPx * 0.9;
    const top = stageH - lineFromBottom + shift;
    goalLabel.style.top = `${Math.max(16, Math.min(top, stageH - 16)).toFixed(2)}px`;
    goalLabel.style.left = '50%';
  }

  function addBlock(color: string, animate: boolean): void {
    const block = document.createElement('div');
    block.className = animate ? 'tower-flat-block tower-flat-block--drop' : 'tower-flat-block';
    block.style.background = color;
    block.style.bottom = `${(built.length * blockPx).toFixed(2)}px`;
    stack.append(block);
    built.push(block);

    if (animate) {
      const puff = document.createElement('div');
      puff.className = 'tower-flat-dust';
      puff.style.bottom = `${(built.length * blockPx).toFixed(2)}px`;
      stack.append(puff);
      window.setTimeout(() => puff.remove(), 700);
    }
    slide();
  }

  function reflowBlocks(): void {
    built.forEach((block, i) => {
      block.style.bottom = `${(i * blockPx).toFixed(2)}px`;
    });
  }

  const onResize = (): void => {
    measure();
    reflowBlocks();
  };
  window.addEventListener('resize', onResize);
  measure();

  return {
    drop: (_index: number, _colorIndex: number, color: string) => addBlock(color, true),
    setBlocks: (colors: string[]) => {
      stack.replaceChildren();
      built.length = 0;
      for (const color of colors) addBlock(color, false);
    },
    finish: () => {
      world.classList.add('tower-flat-win');
      const burst = document.createElement('div');
      burst.className = 'tower-flat-confetti';
      for (let i = 0; i < 24; i += 1) {
        const bit = document.createElement('span');
        bit.style.setProperty('--x', `${Math.round(Math.random() * 200 - 100)}%`);
        bit.style.setProperty('--d', `${Math.round(Math.random() * 300)}ms`);
        burst.append(bit);
      }
      world.append(burst);
      window.setTimeout(() => burst.remove(), 2400);
    },
    resize: onResize,
    dispose: () => {
      window.removeEventListener('resize', onResize);
      goalLabel.remove();
      world.remove();
    },
  };
}

