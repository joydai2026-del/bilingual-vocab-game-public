// Sky Tower, in 3D. The kit scene: a small island, one tower of instanced
// rounded blocks, a cloud line for the target, and confetti at the finish.
//
// Nothing in here decides anything. `src/shared/sky-tower.ts` owns the rules;
// this file is told "block 7 landed, and it is Ana's colour" and draws that.
//
// Two notes on why it is shaped the way it is:
//
//   1. The world slides DOWN instead of the camera easing UP. `kit.resize()`
//      recomputes `camera.position` from its own framing constants every time
//      the stage changes size, so anything this file wrote to the camera would
//      be thrown away on the first rotation. Sliding the world group is the
//      same picture and survives a resize.
//
//   2. Blocks are one InstancedMesh whose material is white, tinted per
//      instance with `setColorAt`. That is what makes "coloured by who earned
//      it" cost one draw call instead of sixty.
//
// The only runtime import is the kit. `three` appears here as types only, which
// TypeScript erases, so this file adds nothing to any chunk on its own.

import type { InstancedMesh, Mesh, MeshBasicMaterial, Object3D } from 'three';

import { EASINGS, MAX_INSTANCES, Vector3, createKit, type Kit } from '../scene/three-kit';
import { MAX_TARGET } from '../../shared/sky-tower';

/** One block, in world units. Wide and short, so a tower of 18 still fits. */
const BLOCK_W = 1.9;
const BLOCK_H = 0.62;
const BLOCK_D = 1.9;

/** Top of the island slab: where the first block rests. */
const BASE_Y = 0.16;

/** How far above its resting place a block starts its fall. */
const FALL_H = 5.4;

const DROP_MS = 380;
const SQUASH_MS = 200;
const DUST_MS = 460;

/** World units of tower kept below the top of the frame before it starts to slide. */
const HEAD_ROOM = 5.6;

/** Enough puff sets that four blocks 120 ms apart never steal each other's. */
const DUST_SETS = 6;
const DUST_SPHERES = 5;

export interface TowerScene {
  /** Block `index` (0-based) has landed, earned by the bean of `colorIndex`. */
  drop(index: number, colorIndex: number, color: string): void;
  /** Paint the whole tower at once, with no animation. For a resync. */
  setBlocks(colors: string[]): void;
  /** The finish: confetti over the top of the tower. */
  finish(): void;
  resize(): void;
  dispose(): void;
}

/** True when this page load asked for the render-gate hook (`probe=1`). */
function probeRequested(): boolean {
  try {
    const { search, hash } = window.location;
    return /[?&]probe=1/.test(search) || /[?&]probe=1/.test(hash);
  } catch {
    return false;
  }
}

/** What the render gate reads back. Sampled luminance, not the whole buffer. */
interface TowerPixels {
  w: number;
  h: number;
  drawn: number;
  lum: number[];
}

/**
 * One fading puff: five small spheres on their own material.
 *
 * The spheres are clones of a kit cloud's children, so the geometry is the
 * kit's and gets disposed with it. The material comes from a throwaway shadow
 * disc, which is the one call in the kit that hands back a FRESH transparent
 * material rather than a cached shared one; sharing it would make every puff on
 * screen fade together.
 */
interface DustSet {
  meshes: Mesh[];
  material: MeshBasicMaterial;
  bornAt: number;
  live: boolean;
}

export async function mountTower3d(
  stage: HTMLElement,
  overlay: HTMLElement,
  opts: { target: number; cloudLabel?: string }
): Promise<TowerScene> {
  const canvas = document.createElement('canvas');
  stage.append(canvas);

  const kit: Kit = createKit(canvas, { sky: 'day' });

  // --- the world group: everything that slides as the tower grows ----------
  // A kit cloud is a Group, and a Group with its children removed is the plain
  // container this needs. Building it this way keeps `three` a type-only
  // import here.
  const world = kit.cloud(1);
  world.clear();
  world.scale.setScalar(1);
  kit.scene.add(world);

  // --- the island ----------------------------------------------------------
  const grass = kit.tile({ w: 6.2, h: 5.0, color: 'mint' });
  grass.position.set(0, 0, 0);
  world.add(grass);

  const dirt = kit.block({ w: 5.3, h: 1.5, d: 4.2, color: 'butter' });
  dirt.position.set(0, -0.85, 0);
  world.add(dirt);

  const islandShadow = kit.shadowDisc(3.1);
  islandShadow.position.set(0, -1.68, 0);
  world.add(islandShadow);

  // Two beans watching from the grass, so the island reads as a place and the
  // blocks have something human-sized next to them.
  for (const [x, z, color] of [
    [-2.15, 1.5, '#7EC4F2'],
    [2.15, 1.5, '#FF8FA3'],
  ] as Array<[number, number, string]>) {
    const watcher = kit.bean({ color });
    watcher.group.position.set(x, 0.14, z);
    watcher.group.rotation.y = x > 0 ? -0.4 : 0.4;
    world.add(watcher.group);
  }

  // --- the tower -----------------------------------------------------------
  // `template` is two things at once on purpose: the geometry every instance
  // draws, and the scratch Object3D used to compose each instance matrix. It is
  // never added to the scene.
  const template = kit.block({ w: BLOCK_W, h: BLOCK_H, d: BLOCK_D, color: 'cloud' });
  const dummy = template as unknown as Object3D;
  const capacity = Math.min(MAX_INSTANCES, Math.max(MAX_TARGET, opts.target) + 2);
  const blocks: InstancedMesh = kit.instanced(template.geometry, 'cloud', capacity);
  blocks.count = 0;
  world.add(blocks);

  const restY = (index: number): number => BASE_Y + BLOCK_H / 2 + index * BLOCK_H;

  function writeBlock(index: number, y: number, sx: number, sy: number, sz: number): void {
    dummy.position.set(0, y, 0);
    dummy.rotation.set(0, 0, 0);
    dummy.scale.set(sx, sy, sz);
    dummy.updateMatrix();
    blocks.setMatrixAt(index, dummy.matrix);
    blocks.instanceMatrix.needsUpdate = true;
  }

  // One scratch Color, borrowed from a throwaway shadow disc's material, so no
  // `new Color()` is needed and `three` stays a type-only import here.
  const scratchColor = (kit.shadowDisc(0.001).material as MeshBasicMaterial).color;

  function tint(index: number, color: string): void {
    // setColorAt allocates the instanceColor attribute on first use, which is
    // what turns USE_INSTANCING_COLOR on. The base material is white, so the
    // instance colour comes through unchanged.
    scratchColor.set(color);
    blocks.setColorAt(index, scratchColor);
    if (blocks.instanceColor) blocks.instanceColor.needsUpdate = true;
  }

  // --- the cloud line ------------------------------------------------------
  const cloudY = restY(opts.target - 1) + BLOCK_H / 2 + 1.15;
  for (const [x, z, s] of [
    [-2.9, -0.2, 0.95],
    [0.3, 0.5, 1.15],
    [3.1, -0.4, 0.85],
  ] as Array<[number, number, number]>) {
    const puff = kit.cloud(s);
    puff.position.set(x, cloudY, z);
    world.add(puff);
  }

  const goalLabel = document.createElement('div');
  goalLabel.className = 'kit-label tower-goal';
  goalLabel.textContent = opts.cloudLabel ?? `${opts.target} blocks`;
  overlay.append(goalLabel);
  // Appending an element that is already there just moves it, which is exactly
  // what is wanted: the DOM overlay has to sit after the canvas to be on top.
  stage.append(overlay);

  // --- dust ----------------------------------------------------------------
  const puffProto = (kit.cloud(1).children[0] as Mesh) ?? null;
  const dustSets: DustSet[] = [];
  if (puffProto) {
    for (let s = 0; s < DUST_SETS; s += 1) {
      const material = kit.shadowDisc(0.001).material as MeshBasicMaterial;
      material.color.set('#FFFFFF');
      material.opacity = 0;
      material.depthWrite = false;
      const meshes: Mesh[] = [];
      for (let i = 0; i < DUST_SPHERES; i += 1) {
        const m = puffProto.clone() as Mesh;
        m.material = material;
        m.visible = false;
        m.scale.setScalar(0.18);
        world.add(m);
        meshes.push(m);
      }
      dustSets.push({ meshes, material, bornAt: 0, live: false });
    }
  }

  let dustCursor = 0;

  function puffAt(y: number, at: number): void {
    if (dustSets.length === 0) return;
    const set = dustSets[dustCursor % dustSets.length];
    dustCursor += 1;
    set.bornAt = at;
    set.live = true;
    set.material.opacity = 0.6;
    set.meshes.forEach((m, i) => {
      const angle = (i / DUST_SPHERES) * Math.PI * 2 + Math.random() * 0.5;
      // Wider than the block is half-wide (0.95), so the puff rings the
      // landing instead of sitting on top of it.
      const reach = 1.25 + Math.random() * 0.45;
      m.visible = true;
      m.position.set(Math.cos(angle) * reach, y - BLOCK_H / 2 + 0.1, Math.sin(angle) * reach);
      m.scale.setScalar(0.16);
    });
  }

  // --- animation -----------------------------------------------------------

  interface Anim {
    index: number;
    start: number;
    dusted: boolean;
  }

  const anims: Anim[] = [];
  let clock = 0;
  let slide = 0;

  function drop(index: number, _colorIndex: number, color: string): void {
    if (index < 0 || index >= capacity) return;
    tint(index, color);
    writeBlock(index, restY(index) + FALL_H, 1, 1, 1);
    if (blocks.count <= index) blocks.count = index + 1;
    anims.push({ index, start: clock, dusted: false });
  }

  function setBlocks(colors: string[]): void {
    const n = Math.min(colors.length, capacity);
    anims.length = 0;
    for (let i = 0; i < n; i += 1) {
      tint(i, colors[i]);
      writeBlock(i, restY(i), 1, 1, 1);
    }
    blocks.count = n;
  }

  function finish(): void {
    const top = restY(Math.max(0, blocks.count - 1)) + world.position.y + 1.2;
    kit.confetti(new Vector3(0, top, 0), 60);
  }

  const goalPoint = new Vector3();

  const stopFrame = kit.onFrame((dt) => {
    clock += dt * 1000;

    // Blocks in flight.
    for (let a = anims.length - 1; a >= 0; a -= 1) {
      const anim = anims[a];
      const age = clock - anim.start;
      const rest = restY(anim.index);
      if (age < DROP_MS) {
        const t = age / DROP_MS;
        writeBlock(anim.index, rest + FALL_H * (1 - EASINGS.bounce(t)), 1, 1, 1);
      } else if (age < DROP_MS + SQUASH_MS) {
        if (!anim.dusted) {
          anim.dusted = true;
          puffAt(rest, clock);
        }
        const t = (age - DROP_MS) / SQUASH_MS;
        const e = EASINGS.overshoot(t);
        const sy = 0.72 + 0.28 * e;
        const sxz = 1.16 - 0.16 * e;
        writeBlock(anim.index, rest - (BLOCK_H * (1 - sy)) / 2, sxz, sy, sxz);
      } else {
        writeBlock(anim.index, rest, 1, 1, 1);
        anims.splice(a, 1);
      }
    }

    // Dust fading out.
    for (const set of dustSets) {
      if (!set.live) continue;
      const age = clock - set.bornAt;
      if (age >= DUST_MS) {
        set.live = false;
        set.material.opacity = 0;
        for (const m of set.meshes) m.visible = false;
        continue;
      }
      const t = age / DUST_MS;
      set.material.opacity = 0.6 * (1 - t);
      for (const m of set.meshes) {
        m.scale.setScalar(0.16 + 0.34 * t);
        m.position.y += dt * 0.35;
      }
    }

    // The world slides down so the top of the tower stays in frame. Eased, not
    // snapped: a block landing should not jerk the whole island.
    const topY = blocks.count > 0 ? restY(blocks.count - 1) : 0;
    const want = -Math.max(0, topY - HEAD_ROOM);
    slide += (want - slide) * Math.min(1, dt * 3.2);
    world.position.y = slide;

    // The cloud line starts well above the top of the frame, so the label that
    // says how tall the tower has to be is clamped to the edge rather than
    // clipped away: a goal you cannot see is not a goal.
    goalPoint.set(0, cloudY + world.position.y, 0);
    const at = kit.project(goalPoint);
    const w = canvas.clientWidth || 1;
    const hpx = canvas.clientHeight || 1;
    goalLabel.style.left = `${Math.max(48, Math.min(at.x, w - 48))}px`;
    goalLabel.style.top = `${Math.max(16, Math.min(at.y, hpx - 16))}px`;
  });

  // The render gate's only way in, and only when the URL asked for it. A WebGL
  // drawing buffer is wiped when the browser composites the frame, so a
  // readPixels from an outside task always returns zeros: the draw and the read
  // have to happen in the SAME task, which is what this does.
  if (probeRequested()) {
    (window as unknown as { __towerPixels?: (want: number) => TowerPixels }).__towerPixels = (
      want = 240
    ) => {
      kit.renderer.render(kit.scene, kit.camera);
      const gl = kit.renderer.getContext();
      const w = canvas.width;
      const h = canvas.height;
      const buf = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      const step = Math.max(1, Math.floor((w * h) / want));
      const lum: number[] = [];
      let drawn = 0;
      for (let i = 0; i < w * h; i += step) {
        const o = i * 4;
        lum.push(0.299 * buf[o] + 0.587 * buf[o + 1] + 0.114 * buf[o + 2]);
        if (buf[o + 3] > 8) drawn += 1;
      }
      return { w, h, drawn, lum };
    };
  }

  const onResize = (): void => kit.resize();
  window.addEventListener('resize', onResize);

  return {
    drop,
    setBlocks,
    finish,
    resize: () => kit.resize(),
    dispose: () => {
      delete (window as unknown as { __towerPixels?: unknown }).__towerPixels;
      window.removeEventListener('resize', onResize);
      stopFrame();
      goalLabel.remove();
      kit.dispose();
      canvas.remove();
    },
  };
}

