// Reveal Rush, the 3D scene. Lazily imported, so `three` stays in its own chunk.
//
// The one piece of real geometry here is the tile grid, and it is placed the
// way it is for a reason worth writing down:
//
//   The twelve tiles live in ONE plane that is perpendicular to the camera's
//   optical axis and centred on it. A rectangle in such a plane projects to an
//   axis-aligned rectangle on screen, whatever the fov, the aspect or the
//   camera's pitch. That is what lets the DOM board box be copied straight off
//   `kit.project()` of two corners and still line up with the tiles at 390x844,
//   820x1180 and 1440x900 alike. A grid left standing upright in world space
//   would project to a trapezoid, the DOM box would be a rectangle, and the two
//   would disagree by more at the top of the board than at the bottom.
//
// The reveal itself is NOT these tiles occluding the glyph (the glyph is a DOM
// element and paints over the canvas whatever the depth buffer thinks). It is
// the clip path the shell writes, from the same rectangles. These tiles are the
// picture; `clipPathFor` is the truth.

import type { Color, InstancedMesh, Mesh, MeshToonMaterial } from 'three';

import '../scene/kit.css';
import './reveal-rush.css';
import {
  GRID_COLS,
  GRID_ROWS,
  PALETTE_ROTATION,
  TILE_COUNT,
  probeRequested,
  tileRect,
  type RevealView,
  type ViewHost,
} from './reveal-rush';

/** How much of the smaller screen dimension the board takes. Matches the twin. */
const BOARD_FRACTION = 0.74;
/** Distance from the camera to the tile plane, in world units. */
const PLANE_DISTANCE = 13;
/** Gap between tiles, as a fraction of the board. */
const GAP = 0.012;
const POP_MS = 560;

interface TileState {
  /** Board-local centre, in the -0.5..0.5 unit square. */
  cx: number;
  cy: number;
  phase: number;
  /** 0 while standing, then 0..1 through the pop. */
  age: number;
  popping: boolean;
  gone: boolean;
  /** Where it flies. */
  vx: number;
  vy: number;
  spin: number;
}

export async function createSceneView(host: ViewHost): Promise<RevealView> {
  const { stage, board } = host;

  const canvas = document.createElement('canvas');
  // Before the overlay, so the DOM glyph and the labels sit over the picture.
  stage.prepend(canvas);

  const { createKit, Vector3 } = await import('../scene/three-kit');
  const kit = createKit(canvas, { sky: 'day' });

  // --- the tiles -------------------------------------------------------------

  // One rounded slab, harvested from `kit.block` and then instanced twelve
  // times. `kit.block` is the only rounded-box builder the kit exposes and it
  // tracks the geometry for disposal, so this borrows both.
  const tileW = 1 / GRID_COLS - GAP;
  const tileH = 1 / GRID_ROWS - GAP;
  const proto = kit.block({ w: tileW, h: tileH, d: 0.075, color: 'cloud' });

  // White base colour, so the per-instance tint is the colour you see: an
  // instance colour MULTIPLIES the material's, and a lilac base would drag
  // every tile toward lilac.
  const tiles: InstancedMesh = kit.instanced(proto.geometry, 'cloud', TILE_COUNT);
  const tint: Color = (tiles.material as MeshToonMaterial).color.clone();
  kit.scene.add(tiles);

  // A Mesh is an Object3D, so this one composes instance matrices without the
  // scene ever seeing it, and without a runtime import of `three` for Object3D.
  const dummy: Mesh = kit.block({ w: 1, h: 1, d: 1, color: 'ink' });

  const state: TileState[] = Array.from({ length: TILE_COUNT }, (_, index) => {
    const r = tileRect(index);
    return {
      cx: r.x + r.w / 2 - 0.5,
      // Screen y grows downward, world y grows upward.
      cy: 0.5 - (r.y + r.h / 2),
      phase: (index % 5) * 1.3 + (index % 3) * 0.7,
      age: 0,
      popping: false,
      gone: false,
      vx: 0,
      vy: 0,
      spin: 0,
    };
  });

  for (let i = 0; i < TILE_COUNT; i += 1) {
    tiles.setColorAt(i, tint.set(PALETTE_ROTATION[i % PALETTE_ROTATION.length]));
  }
  if (tiles.instanceColor) tiles.instanceColor.needsUpdate = true;

  // --- the room around it ----------------------------------------------------

  const floor = kit.tile({ w: 26, h: 14, color: 'mint' });
  kit.scene.add(floor);

  const clouds = [kit.cloud(1.5), kit.cloud(1.1), kit.cloud(1.3)];
  for (const puff of clouds) kit.scene.add(puff);

  const watcher = kit.bean({ color: '#FF8FA3', name: 'watcher' });
  kit.scene.add(watcher.group);

  // --- placement -------------------------------------------------------------

  const dir = new Vector3();
  const centre = new Vector3();
  const corner = new Vector3();
  let side = 1;

  function place(): void {
    kit.camera.getWorldDirection(dir);
    centre.copy(kit.camera.position).addScaledVector(dir, PLANE_DISTANCE);

    tiles.position.copy(centre);
    // Rotating +Z by this angle about X lands it on -dir, i.e. the plane faces
    // straight back at the camera. See the header note.
    tiles.rotation.set(Math.asin(Math.max(-1, Math.min(1, dir.y))), 0, 0);

    const vFov = (kit.camera.fov * Math.PI) / 180;
    const visH = 2 * PLANE_DISTANCE * Math.tan(vFov / 2);
    const visW = visH * (kit.camera.aspect || 1);
    side = Math.min(visH, visW) * BOARD_FRACTION;
    tiles.scale.setScalar(side);

    // The furniture hangs off the board, so it follows the board at every
    // viewport instead of drifting across it on a phone.
    floor.position.set(centre.x, centre.y - side * 0.62, centre.z - 3);
    clouds[0].position.set(centre.x - side * 0.82, centre.y + side * 0.42, centre.z - 6);
    clouds[1].position.set(centre.x + side * 0.86, centre.y + side * 0.3, centre.z - 7);
    clouds[2].position.set(centre.x + side * 0.1, centre.y + side * 0.66, centre.z - 9);
    watcher.group.scale.setScalar(side * 0.1);
    watcher.group.position.set(
      centre.x - side * 0.66,
      centre.y - side * 0.6,
      centre.z - 2.6
    );
  }

  // --- the frame -------------------------------------------------------------

  let lastW = -1;
  let lastH = -1;

  function frame(dt: number, t: number): void {
    place();

    for (let i = 0; i < TILE_COUNT; i += 1) {
      const s = state[i];
      if (s.gone) {
        dummy.scale.setScalar(0);
        dummy.position.set(0, 0, 0);
        dummy.rotation.set(0, 0, 0);
        dummy.updateMatrix();
        tiles.setMatrixAt(i, dummy.matrix);
        continue;
      }

      if (s.popping) {
        s.age = Math.min(1, s.age + (dt * 1000) / POP_MS);
        const e = s.age;
        dummy.position.set(s.cx + s.vx * e, s.cy + s.vy * e - 0.9 * e * e, 1.4 * e);
        dummy.rotation.set(s.spin * e * 2.2, s.spin * e, s.spin * e * 1.4);
        // Squash on the way out, stretch as it leaves, then away to nothing.
        const squash = e < 0.18 ? 1 - e * 1.1 : 1;
        const stretch = e < 0.18 ? 1 + e * 1.6 : 1;
        const shrink = Math.max(0, 1 - e * e);
        dummy.scale.set(squash * shrink, stretch * shrink, shrink);
        dummy.updateMatrix();
        tiles.setMatrixAt(i, dummy.matrix);
        if (s.age >= 1) s.gone = true;
        continue;
      }

      // Standing: a slow bob, a hair of tilt, nothing that could be mistaken
      // for the tile coming off.
      const bob = Math.sin(t * 1.4 + s.phase) * 0.008;
      dummy.position.set(s.cx, s.cy + bob, Math.cos(t * 1.1 + s.phase) * 0.01);
      dummy.rotation.set(bob * 1.6, 0, Math.sin(t * 0.9 + s.phase) * 0.02);
      dummy.scale.setScalar(1);
      dummy.updateMatrix();
      tiles.setMatrixAt(i, dummy.matrix);
    }
    tiles.instanceMatrix.needsUpdate = true;

    for (const puff of clouds) {
      puff.position.x += dt * 0.5;
      if (puff.position.x > centre.x + side * 1.3) puff.position.x = centre.x - side * 1.3;
    }

    // The DOM board box, copied off the projection of the grid's own corners.
    tiles.updateMatrixWorld();
    const a = kit.project(corner.set(-0.5, 0.5, 0).applyMatrix4(tiles.matrixWorld));
    corner.set(0.5, -0.5, 0).applyMatrix4(tiles.matrixWorld);
    const b = kit.project(corner);
    const w = Math.max(1, b.x - a.x);
    const hgt = Math.max(1, b.y - a.y);
    board.style.left = `${a.x.toFixed(1)}px`;
    board.style.top = `${a.y.toFixed(1)}px`;
    board.style.width = `${w.toFixed(1)}px`;
    board.style.height = `${hgt.toFixed(1)}px`;
    if (Math.abs(w - lastW) > 0.5 || Math.abs(hgt - lastH) > 0.5) {
      lastW = w;
      lastH = hgt;
      host.onLayout(w, hgt);
    }
  }

  place();
  const stopFrame = kit.onFrame(frame);
  const onResize = (): void => kit.resize();
  window.addEventListener('resize', onResize);

  // --- what the shell asks for ----------------------------------------------

  function reset(): void {
    for (const s of state) {
      s.age = 0;
      s.popping = false;
      s.gone = false;
      s.vx = 0;
      s.vy = 0;
      s.spin = 0;
    }
    lastW = -1;
  }

  function pop(index: number): void {
    const s = state[index];
    if (!s || s.popping) return;
    const angle = (index / TILE_COUNT) * Math.PI * 2 + 0.4;
    s.popping = true;
    s.age = 0;
    s.vx = Math.cos(angle) * 0.9;
    s.vy = 0.9 + Math.abs(Math.sin(angle)) * 0.5;
    s.spin = (index % 2 === 0 ? 1 : -1) * (2 + (index % 3));
    kit.confetti(
      corner.set(s.cx, s.cy, 0.2).applyMatrix4(tiles.matrixWorld).clone(),
      34
    );
  }

  function scatter(): void {
    for (let i = 0; i < TILE_COUNT; i += 1) {
      const at = i;
      window.setTimeout(() => pop(at), (i % 6) * 55);
    }
    void watcher.cheer();
  }

  // --- the render gate's way in ---------------------------------------------

  // Same shape as the kit demo's hook and for the same reason: a WebGL drawing
  // buffer is wiped when the browser composites, so a readPixels from any other
  // task reads zeros. The draw and the read have to happen in ONE task. Behind
  // `?probe=1`, so a class never carries it.
  let removePixels = (): void => undefined;
  if (probeRequested()) {
    (window as unknown as { __revealPixels?: (want: number) => unknown }).__revealPixels = (
      want = 240
    ) => {
      kit.renderer.render(kit.scene, kit.camera);
      const gl = kit.renderer.getContext();
      const cw = canvas.width;
      const ch = canvas.height;
      const buf = new Uint8Array(cw * ch * 4);
      gl.readPixels(0, 0, cw, ch, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      const step = Math.max(1, Math.floor((cw * ch) / want));
      const lum: number[] = [];
      let drawn = 0;
      for (let i = 0; i < cw * ch; i += step) {
        const o = i * 4;
        lum.push(0.299 * buf[o] + 0.587 * buf[o + 1] + 0.114 * buf[o + 2]);
        if (buf[o + 3] > 8) drawn += 1;
      }
      return { w: cw, h: ch, drawn, lum };
    };
    removePixels = () => {
      delete (window as unknown as { __revealPixels?: unknown }).__revealPixels;
    };
  }

  return {
    reset,
    pop,
    scatter,
    dispose(): void {
      window.removeEventListener('resize', onResize);
      removePixels();
      stopFrame();
      kit.dispose();
      canvas.remove();
    },
  };
}

