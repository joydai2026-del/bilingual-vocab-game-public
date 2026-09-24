// Reveal Rush, flat twin. No canvas, no `three`, same game.
//
// It draws the twelve tiles as rounded divs on the SAME board box the 3D scene
// uses, from the SAME `tileRect` fractions, over the SAME clipped glyph. That
// is the whole reason the two modes reveal identical slices: neither renderer
// decides what shows, `clipPathFor` does, and both hand it the same rectangles.

import '../scene/kit.css';
import './reveal-rush.css';
// `reveal-rush` is already on the eager path (main.ts routes to it), so this
// lazily loaded twin importing back into it costs nothing and keeps ONE copy of
// the grid geometry.
import { PALETTE_ROTATION, TILE_COUNT, tileRect, type RevealView, type ViewHost } from './reveal-rush';

/** How much of the stage the board takes. Same fraction the 3D scene uses. */
const BOARD_FRACTION = 0.74;

export function createFlatView(host: ViewHost): RevealView {
  const { stage, board } = host;
  stage.classList.add('kit-sky-day');

  const layer = document.createElement('div');
  layer.className = 'rr-tiles';
  board.append(layer);

  let tiles: HTMLDivElement[] = [];
  let lastW = -1;
  let lastH = -1;

  /** A square board, centred, sized off whichever side of the stage is smaller. */
  function layout(): void {
    const w = stage.clientWidth || 0;
    const h = stage.clientHeight || 0;
    if (w <= 0 || h <= 0) return;
    const side = Math.max(40, Math.floor(Math.min(w, h) * BOARD_FRACTION));
    board.style.left = `${Math.round((w - side) / 2)}px`;
    board.style.top = `${Math.round((h - side) / 2)}px`;
    board.style.width = `${side}px`;
    board.style.height = `${side}px`;
    placeTiles(side);
    if (side !== lastW || side !== lastH) {
      lastW = side;
      lastH = side;
      host.onLayout(side, side);
    }
  }

  function placeTiles(side: number): void {
    tiles.forEach((tile, index) => {
      const r = tileRect(index);
      // A one-pixel outward bleed on every edge, so two neighbours never leave a
      // sliver of glyph showing between them at a fractional board size.
      tile.style.left = `${r.x * side - 1}px`;
      tile.style.top = `${r.y * side - 1}px`;
      tile.style.width = `${r.w * side + 2}px`;
      tile.style.height = `${r.h * side + 2}px`;
    });
  }

  function reset(): void {
    for (const tile of tiles) tile.remove();
    tiles = Array.from({ length: TILE_COUNT }, (_, index) => {
      const tile = document.createElement('div');
      tile.className = 'rr-tile';
      tile.dataset.tile = String(index);
      tile.style.background = PALETTE_ROTATION[index % PALETTE_ROTATION.length];
      tile.style.animationDelay = `${(index % 5) * 0.22}s`;
      return tile;
    });
    layer.append(...tiles);
    lastW = -1;
    layout();
  }

  function pop(index: number): void {
    const tile = tiles[index];
    if (!tile || tile.classList.contains('popping')) return;
    const angle = (index / TILE_COUNT) * Math.PI * 2;
    const dx = Math.cos(angle) * 220 + (Math.random() * 60 - 30);
    const dy = -180 - Math.random() * 140;

    // Squash on the way out, then let the transition carry it off. Two frames
    // apart so the browser has a start value to animate from.
    tile.style.transform = 'scale(1.16, 0.82)';
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        tile.classList.add('popping');
        tile.style.transform = `translate(${dx.toFixed(0)}px, ${dy.toFixed(0)}px) rotate(${(
          dx / 4
        ).toFixed(0)}deg) scale(0.7, 1.2)`;
      });
    });
    window.setTimeout(() => tile.remove(), 560);
    sparkle(tile);
  }

  /** A dozen coloured squares thrown out of the tile. The flat confetti. */
  function sparkle(from: HTMLElement): void {
    const side = board.clientWidth || 1;
    const cx = parseFloat(from.style.left || '0') + parseFloat(from.style.width || '0') / 2;
    const cy = parseFloat(from.style.top || '0') + parseFloat(from.style.height || '0') / 2;
    for (let i = 0; i < 12; i += 1) {
      const dot = document.createElement('div');
      dot.className = 'rr-spark';
      dot.style.left = `${cx}px`;
      dot.style.top = `${cy}px`;
      dot.style.background = PALETTE_ROTATION[(i + 2) % PALETTE_ROTATION.length];
      layer.append(dot);
      const a = (i / 12) * Math.PI * 2 + Math.random();
      const d = side * (0.12 + Math.random() * 0.22);
      requestAnimationFrame(() => {
        dot.style.transform = `translate(${(Math.cos(a) * d).toFixed(0)}px, ${(
          Math.sin(a) * d
        ).toFixed(0)}px) rotate(${(Math.random() * 360).toFixed(0)}deg)`;
        dot.style.opacity = '0';
      });
      window.setTimeout(() => dot.remove(), 820);
    }
  }

  function scatter(): void {
    tiles.forEach((tile, index) => {
      if (!tile.isConnected) return;
      window.setTimeout(() => pop(index), (index % 6) * 55);
    });
  }

  let observer: ResizeObserver | null = null;
  if (typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(() => layout());
    observer.observe(stage);
  }
  const onResize = (): void => layout();
  window.addEventListener('resize', onResize);

  reset();

  return {
    reset,
    pop,
    scatter,
    dispose(): void {
      observer?.disconnect();
      observer = null;
      window.removeEventListener('resize', onResize);
      layer.remove();
      tiles = [];
    },
  };
}

