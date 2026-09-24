// The cute 3D kit. Every 3D game in this app builds on exactly this file, so
// the look is paid for once and stays consistent.
//
// Rules it enforces (docs/plans/2026-09-08-cute-3d-kit-contract.md):
//   - primitives only, no textures, no asset packs, no GLTF;
//   - MeshToonMaterial + flatShading, one hemisphere light + one directional
//     light, shadow maps OFF and a fake shadow disc under everything;
//   - transparent canvas over a CSS gradient sky (kit.css owns the sky);
//   - not one glyph drawn in WebGL: `project()` hands the caller CSS pixels and
//     the caller puts the text in the DOM overlay;
//   - pixel ratio capped at 2, the render loop parked while the tab is hidden.
//
// This module is the ONE lazy chunk that pulls in `three`. Import it only with
// `await import('./three-kit')` from a game that has already decided it wants
// the 3D path, or the home screen starts paying for a renderer it never uses.

import {
  BoxGeometry,
  BufferGeometry,
  CapsuleGeometry,
  CircleGeometry,
  Color,
  DirectionalLight,
  ExtrudeGeometry,
  Group,
  HemisphereLight,
  InstancedMesh,
  Material,
  Mesh,
  MeshBasicMaterial,
  MeshToonMaterial,
  Object3D,
  PerspectiveCamera,
  Scene,
  Shape,
  SphereGeometry,
  Vector3,
  WebGLRenderer,
} from 'three';

// Re-exported so a game can build a world point without importing `three`
// itself, which would put the library back on the eager path.
export { Vector3 } from 'three';

export type KitColor = 'mint' | 'butter' | 'sky' | 'coral' | 'lilac' | 'cloud' | 'ink';

/** The seven palette tokens. Same values as the `--kit-*` variables in kit.css. */
export const PALETTE: Record<KitColor, string> = {
  mint: '#B7F0D3',
  butter: '#FFE8A3',
  sky: '#BFE3FF',
  coral: '#FFB3A7',
  lilac: '#D9C8FF',
  cloud: '#FFFFFF',
  ink: '#2B2D42',
};

/** One flat colour per bean. Twelve is the roster ceiling a room is sized for. */
export const BEAN_COLORS: string[] = [
  '#FF8FA3',
  '#FFB26B',
  '#FFD166',
  '#EAF07A',
  '#A8E6A1',
  '#6FD6D0',
  '#7EC4F2',
  '#8FA8F0',
  '#B8A6E8',
  '#D9A7F0',
  '#F49AC2',
  '#FFC2B4',
];

export type Ease = 'overshoot' | 'bounce' | 'linear' | 'out';

const BACK = 1.70158;

/** Easing curves. Every one of them is f(0)=0 and f(1)=1; overshoot leaves [0,1]. */
export const EASINGS: Record<Ease, (t: number) => number> = {
  linear: (t) => t,
  out: (t) => 1 - Math.pow(1 - t, 3),
  overshoot: (t) => 1 + (BACK + 1) * Math.pow(t - 1, 3) + BACK * Math.pow(t - 1, 2),
  bounce: (t) => {
    const n = 7.5625;
    const d = 2.75;
    if (t < 1 / d) return n * t * t;
    if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75;
    if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375;
    return n * (t -= 2.625 / d) * t + 0.984375;
  },
};

/**
 * Where a tween sits `run` ms in. A scene that owns its own frame loop drives
 * a value through this instead of through `kit.tween`, because the tween's
 * callback runs AFTER the loop that reads the value: the last frame the scene
 * saw was the second-to-last the tween wrote, so the thing settled a hair off
 * its target and stayed there. Same curves, one reader, exact landing.
 */
export function easeTo(from: number, to: number, run: number, ms: number, ease: Ease = 'out'): number {
  if (!(ms > 0) || run >= ms) return to;
  const curve = EASINGS[ease] ?? EASINGS.out;
  return from + (to - from) * curve(Math.max(run, 0) / ms);
}

/** An InstancedMesh is allocated once, so a bad count must never grow it. */
export const MAX_INSTANCES = 1024;

/** Clamps a requested instance count to a whole number that never exceeds it. */
export function instanceCount(requested: number): number {
  if (!Number.isFinite(requested)) return 0;
  return Math.max(0, Math.min(MAX_INSTANCES, Math.floor(requested)));
}

function resolveColor(c: KitColor | string): string {
  return (PALETTE as Record<string, string>)[c] ?? c;
}

/**
 * A toon material with flat shading on.
 *
 * three@0.185 leaves `flatShading` out of MeshToonMaterial's declared
 * constructor parameters, but WebGLPrograms reads `material.flatShading ===
 * true` on EVERY material to decide the FLAT_SHADED define, so assigning it
 * after construction is what actually turns the faceted look on. Verified in
 * node_modules/three/build/three.module.js.
 */
function makeToon(hex: string): MeshToonMaterial {
  const mat = new MeshToonMaterial({ color: new Color(hex) });
  (mat as unknown as { flatShading: boolean }).flatShading = true;
  return mat;
}

export interface Bean {
  group: Group;
  hop(dy?: number): Promise<void>;
  stumble(): Promise<void>;
  cheer(): Promise<void>;
  setColor(c: string): void;
}

/**
 * One rest height per bean. `hop` and `cheer` both lift the bean and put it
 * back, and each used to capture its own base from wherever y happened to be.
 * A cheer starting mid-hop therefore captured the LIFTED y and landed there,
 * so the bean floated for the rest of the session. Short gates make the
 * overlap common, so the base is owned here instead: the first animation to
 * start records the rest height, the last one to finish restores it exactly.
 */
export function restHeight(read: () => number, write: (y: number) => void) {
  let depth = 0;
  let rest = 0;
  return {
    enter(): number {
      if (depth === 0) rest = read();
      depth += 1;
      return rest;
    },
    exit(): void {
      depth -= 1;
      if (depth > 0) return;
      depth = 0;
      write(rest);
    },
  };
}

export interface Kit {
  scene: Scene;
  camera: PerspectiveCamera;
  renderer: WebGLRenderer;
  bean(opts: { color?: string; name?: string }): Bean;
  block(opts: { w: number; h: number; d: number; color: KitColor | string; rounded?: boolean }): Mesh;
  tile(opts: { w: number; h: number; color: KitColor | string }): Mesh;
  pill(opts: { length: number; radius: number; color: KitColor | string }): Mesh;
  cloud(scale?: number): Group;
  shadowDisc(radius: number): Mesh;
  instanced(geometry: BufferGeometry, color: KitColor | string, count: number): InstancedMesh;
  tween(target: object, to: Record<string, number>, ms: number, ease?: Ease): Promise<void>;
  confetti(at: Vector3, count?: number): void;
  project(v: Vector3): { x: number; y: number };
  onFrame(cb: (dt: number, t: number) => void): () => void;
  resize(): void;
  dispose(): void;
}

/** Rounded box, built from an extruded rounded rectangle. Centred on the origin. */
function roundedBoxGeometry(w: number, h: number, d: number, radius: number): BufferGeometry {
  const r = Math.max(0.001, Math.min(radius, w / 2 - 0.001, h / 2 - 0.001));
  const bevel = Math.min(r, d / 2 - 0.001, 0.08);
  const depth = Math.max(0.001, d - bevel * 2);
  const x = -w / 2;
  const y = -h / 2;

  const shape = new Shape();
  shape.moveTo(x + r, y);
  shape.lineTo(x + w - r, y);
  shape.absarc(x + w - r, y + r, r, -Math.PI / 2, 0, false);
  shape.lineTo(x + w, y + h - r);
  shape.absarc(x + w - r, y + h - r, r, 0, Math.PI / 2, false);
  shape.lineTo(x + r, y + h);
  shape.absarc(x + r, y + h - r, r, Math.PI / 2, Math.PI, false);
  shape.lineTo(x, y + r);
  shape.absarc(x + r, y + r, r, Math.PI, Math.PI * 1.5, false);

  const geo = new ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: bevel > 0.002,
    bevelSize: bevel,
    bevelThickness: bevel,
    bevelSegments: 2,
    curveSegments: 4,
  });
  geo.translate(0, 0, -d / 2 + bevel);
  return geo;
}

/**
 * Hand the WebGL drawing context back, then free the objects.
 *
 * `dispose()` alone releases GPU resources but not the context itself. Chrome
 * keeps roughly sixteen live contexts per tab and silently kills the oldest, so
 * a teacher who bounces between Tone Catcher, Sky Tower and Reveal Rush in one
 * lesson eventually lands on a blank canvas. `forceContextLoss()` is the only
 * call that gives the context back on demand, and it goes FIRST: it needs the
 * renderer's own state, which `dispose()` tears down.
 *
 * Typed structurally rather than as `WebGLRenderer` so the order can be covered
 * by a unit test with a recorder in place of a GPU, and so a renderer without
 * the method (an old build, a stub) still gets disposed instead of throwing on
 * the way out of a route change.
 */
export function releaseRenderer(renderer: {
  forceContextLoss?: () => void;
  dispose: () => void;
}): void {
  try {
    renderer.forceContextLoss?.();
  } catch {
    // A context that is already gone is the outcome we wanted anyway.
  }
  renderer.dispose();
}

export function createKit(
  canvas: HTMLCanvasElement,
  opts: { sky?: 'day' | 'sunset'; fov?: number } = {}
): Kit {
  const renderer = new WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearAlpha(0);
  renderer.shadowMap.enabled = false;

  const scene = new Scene();
  const camera = new PerspectiveCamera(opts.fov ?? 42, 1, 0.1, 300);
  camera.position.set(0, 5.2, 12);
  camera.lookAt(0, 1.4, 0);

  // Framing is defined once, at 16:9, and `resize()` holds the HORIZONTAL field
  // constant by dollying back. A perspective camera otherwise keeps the
  // vertical field, which on a portrait phone crops the sides off a board the
  // whole class is looking at. Games lay their scenes out on x, so x is what
  // must survive the rotation.
  const LOOK_AT = new Vector3(0, 1.4, 0);
  const BASE_ASPECT = 16 / 9;
  // Pulling back without a limit does keep every prop on screen, but on a
  // phone the board ends up a postage stamp in a sea of sky. 2.6 is where a
  // 390-wide portrait still shows the full width of a bean roster at a size a
  // child can actually see; past that the sides may crop.
  const MAX_PULL = 2.6;
  const baseOffset = camera.position.clone().sub(LOOK_AT);

  const hemi = new HemisphereLight(0xffffff, 0xbcc4d8, 1.15);
  const key = new DirectionalLight(0xffffff, 1.35);
  key.position.set(5, 9, 7);
  scene.add(hemi, key);

  // The sky is CSS behind a transparent canvas, so the kit only sets the class.
  const stage = canvas.parentElement;
  if (stage) stage.classList.add(opts.sky === 'sunset' ? 'kit-sky-sunset' : 'kit-sky-day');

  // Everything the kit hands out is tracked so `dispose()` is one pass and does
  // not depend on the caller having left objects in the scene graph.
  const geometries = new Set<BufferGeometry>();
  const materials = new Set<Material>();
  const toonCache = new Map<string, MeshToonMaterial>();

  function toon(color: KitColor | string): MeshToonMaterial {
    const hex = resolveColor(color);
    const hit = toonCache.get(hex);
    if (hit) return hit;
    const made = makeToon(hex);
    toonCache.set(hex, made);
    materials.add(made);
    return made;
  }

  function track<T extends BufferGeometry>(geo: T): T {
    geometries.add(geo);
    return geo;
  }

  // --- the frame loop -------------------------------------------------------

  const frameCbs = new Set<(dt: number, t: number) => void>();
  let raf = 0;
  let last = 0;
  let elapsed = 0;
  let alive = true;

  function frame(now: number): void {
    if (!alive) return;
    raf = requestAnimationFrame(frame);
    if (typeof document !== 'undefined' && document.hidden) {
      last = now; // parked: no callbacks, no draw, and no dt spike on return
      return;
    }
    const dt = last === 0 ? 0 : Math.min((now - last) / 1000, 0.05);
    last = now;
    elapsed += dt;
    for (const cb of Array.from(frameCbs)) cb(dt, elapsed);
    renderer.render(scene, camera);
  }
  raf = requestAnimationFrame(frame);

  function onFrame(cb: (dt: number, t: number) => void): () => void {
    frameCbs.add(cb);
    return () => frameCbs.delete(cb);
  }

  // --- sizing ---------------------------------------------------------------

  function resize(): void {
    const w = canvas.clientWidth || canvas.width || 1;
    const h = canvas.clientHeight || canvas.height || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    const pull = Math.min(Math.max(BASE_ASPECT / camera.aspect, 1), MAX_PULL);
    camera.position.copy(LOOK_AT).addScaledVector(baseOffset, pull);
    camera.lookAt(LOOK_AT);
    camera.updateProjectionMatrix();
  }
  resize();

  let observer: ResizeObserver | null = null;
  if (typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(() => resize());
    observer.observe(canvas);
  }

  function project(v: Vector3): { x: number; y: number } {
    const p = v.clone().project(camera);
    const w = canvas.clientWidth || 1;
    const h = canvas.clientHeight || 1;
    return { x: (p.x * 0.5 + 0.5) * w, y: (-p.y * 0.5 + 0.5) * h };
  }

  // --- tween ----------------------------------------------------------------

  function tween(target: object, to: Record<string, number>, ms: number, ease: Ease = 'out'): Promise<void> {
    const box = target as Record<string, number>;
    const keys = Object.keys(to);
    const from: Record<string, number> = {};
    for (const k of keys) from[k] = Number(box[k]) || 0;

    if (!(ms > 0)) {
      for (const k of keys) box[k] = to[k];
      return Promise.resolve();
    }

    const curve = EASINGS[ease] ?? EASINGS.out;
    return new Promise<void>((done) => {
      let run = 0;
      const stop = onFrame((dt) => {
        run += dt * 1000;
        const t = Math.min(run / ms, 1);
        const e = curve(t);
        for (const k of keys) box[k] = from[k] + (to[k] - from[k]) * e;
        if (t >= 1) {
          stop();
          done();
        }
      });
    });
  }

  // --- props ----------------------------------------------------------------

  function block(o: { w: number; h: number; d: number; color: KitColor | string; rounded?: boolean }): Mesh {
    const geo =
      o.rounded === false
        ? track(new BoxGeometry(o.w, o.h, o.d))
        : track(roundedBoxGeometry(o.w, o.h, o.d, Math.min(o.w, o.h) * 0.22));
    return new Mesh(geo, toon(o.color));
  }

  function tile(o: { w: number; h: number; color: KitColor | string }): Mesh {
    const geo = track(roundedBoxGeometry(o.w, o.h, 0.28, Math.min(o.w, o.h) * 0.2));
    const mesh = new Mesh(geo, toon(o.color));
    mesh.rotation.x = -Math.PI / 2; // a slab lies flat; w runs x, h runs z
    return mesh;
  }

  function pill(o: { length: number; radius: number; color: KitColor | string }): Mesh {
    return new Mesh(track(new CapsuleGeometry(o.radius, o.length, 4, 8)), toon(o.color));
  }

  function shadowDisc(radius: number): Mesh {
    const geo = track(new CircleGeometry(radius, 20));
    const mat = new MeshBasicMaterial({
      color: new Color(PALETTE.ink),
      transparent: true,
      opacity: 0.16,
      depthWrite: false,
    });
    materials.add(mat);
    const disc = new Mesh(geo, mat);
    disc.rotation.x = -Math.PI / 2;
    return disc;
  }

  // Four overlapping spheres reading as one puff. They share one geometry and
  // one material, so a whole sky of clouds is cheap.
  const puffGeo = track(new SphereGeometry(0.6, 16, 12));

  function cloud(scale = 1): Group {
    const group = new Group();
    const spots: Array<[number, number, number, number]> = [
      [-0.72, 0, 0, 0.8],
      [0, 0.2, 0, 1.1],
      [0.72, 0.02, 0, 0.85],
      [0.08, -0.12, 0.38, 0.66],
    ];
    for (const [x, y, z, s] of spots) {
      const m = new Mesh(puffGeo, toon('cloud'));
      m.position.set(x, y, z);
      m.scale.setScalar(s);
      group.add(m);
    }
    group.scale.setScalar(scale);
    return group;
  }

  function instanced(geometry: BufferGeometry, color: KitColor | string, count: number): InstancedMesh {
    geometries.add(geometry);
    return new InstancedMesh(geometry, toon(color), instanceCount(count));
  }

  // --- bean -----------------------------------------------------------------

  const bodyGeo = track(new CapsuleGeometry(0.4, 0.5, 4, 8));
  const eyeGeo = track(new SphereGeometry(0.12, 16, 12));
  const pupilGeo = track(new SphereGeometry(0.06, 16, 12));
  const armGeo = track(new CapsuleGeometry(0.085, 0.18, 3, 8));

  function bean(o: { color?: string; name?: string } = {}): Bean {
    const hex = o.color ?? BEAN_COLORS[0];
    const bodyMat = makeToon(hex);
    materials.add(bodyMat);

    const group = new Group();
    if (o.name) group.name = o.name;

    const body = new Mesh(bodyGeo, bodyMat);
    body.position.y = 0.65;
    group.add(body);

    for (const side of [-1, 1]) {
      const eye = new Mesh(eyeGeo, toon('cloud'));
      eye.position.set(0.15 * side, 0.86, 0.33);
      group.add(eye);
      const pupil = new Mesh(pupilGeo, toon('ink'));
      pupil.position.set(0.16 * side, 0.85, 0.42);
      group.add(pupil);
      const arm = new Mesh(armGeo, bodyMat);
      arm.position.set(0.42 * side, 0.6, 0);
      arm.rotation.z = (Math.PI / 5) * -side;
      group.add(arm);
    }

    const disc = shadowDisc(0.42);
    disc.position.y = 0.01;
    group.add(disc);

    // Squash and stretch is on the BODY, so the shadow disc stays on the floor.
    const squash = body.scale;

    const restY = restHeight(
      () => group.position.y,
      (y) => {
        group.position.y = y;
      }
    );

    // The yaw needs the same owner for the same reason: `cheer` used to capture
    // and restore `rotation.y` on its own, so a second cheer starting mid-spin
    // captured a turning bean and restored it THERE, leaving a permanent yaw
    // offset. Not reachable at today's gate times, but it is the same bug.
    const restSpin = restHeight(
      () => group.rotation.y,
      (y) => {
        group.rotation.y = y;
      }
    );

    async function hop(dy = 0.9): Promise<void> {
      const base = restY.enter();
      try {
        await tween(squash, { x: 1.14, y: 0.8, z: 1.14 }, 70, 'out');
        const arc = (async () => {
          await tween(group.position, { y: base + dy }, 110, 'out');
          await tween(group.position, { y: base }, 130, 'bounce');
        })();
        await tween(squash, { x: 0.92, y: 1.15, z: 0.92 }, 80, 'out');
        await tween(squash, { x: 1, y: 1, z: 1 }, 70, 'overshoot');
        await arc;
      } finally {
        restY.exit();
      }
    }

    async function stumble(): Promise<void> {
      await tween(group.rotation, { z: -0.35 }, 110, 'out');
      await tween(squash, { x: 1.12, y: 0.86, z: 1.12 }, 80, 'out');
      await tween(group.rotation, { z: 0.22 }, 130, 'out');
      await tween(group.rotation, { z: 0 }, 160, 'overshoot');
      await tween(squash, { x: 1, y: 1, z: 1 }, 120, 'overshoot');
    }

    async function cheer(): Promise<void> {
      const base = restY.enter();
      const spin = restSpin.enter();
      try {
        await Promise.all([
          tween(group.rotation, { y: spin + Math.PI * 2 }, 520, 'out'),
          (async () => {
            await tween(squash, { x: 1.16, y: 0.82, z: 1.16 }, 90, 'out');
            await tween(squash, { x: 0.9, y: 1.2, z: 0.9 }, 120, 'out');
            await tween(squash, { x: 1, y: 1, z: 1 }, 160, 'overshoot');
          })(),
          (async () => {
            await tween(group.position, { y: base + 1.1 }, 200, 'out');
            await tween(group.position, { y: base }, 260, 'bounce');
          })(),
        ]);
      } finally {
        restSpin.exit();
        restY.exit();
      }
    }

    return {
      group,
      hop,
      stumble,
      cheer,
      setColor: (c: string) => bodyMat.color.set(resolveColor(c)),
    };
  }

  // --- confetti -------------------------------------------------------------

  const confettiGeo = track(new BoxGeometry(0.11, 0.11, 0.02));
  // No `vertexColors` here on purpose. It would define USE_COLOR, the geometry
  // has no `color` attribute, and vColor would come out (0,0,0): black paper.
  // An InstancedMesh with `setColorAt` turns on USE_INSTANCING_COLOR by itself.
  const confettiMat = new MeshBasicMaterial({ toneMapped: false });
  materials.add(confettiMat);

  function confetti(at: Vector3, count = 44): void {
    const n = instanceCount(count);
    if (n === 0) return;
    const mesh = new InstancedMesh(confettiGeo, confettiMat, n);
    const dummy = new Object3D();
    const vel: Vector3[] = [];
    const spin: Vector3[] = [];
    const tint = new Color();

    for (let i = 0; i < n; i += 1) {
      const a = Math.random() * Math.PI * 2;
      const speed = 1.6 + Math.random() * 2.4;
      vel.push(new Vector3(Math.cos(a) * speed * 0.55, 2.6 + Math.random() * 2.2, Math.sin(a) * speed * 0.55));
      spin.push(new Vector3(Math.random() * 8 - 4, Math.random() * 8 - 4, Math.random() * 8 - 4));
      dummy.position.copy(at);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      mesh.setColorAt(i, tint.set(BEAN_COLORS[i % BEAN_COLORS.length]));
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    scene.add(mesh);

    const pos = vel.map(() => at.clone());
    const rot = vel.map(() => new Vector3());
    let age = 0;
    const stop = onFrame((dt) => {
      age += dt * 1000;
      for (let i = 0; i < n; i += 1) {
        vel[i].y -= 9.4 * dt;
        pos[i].addScaledVector(vel[i], dt);
        rot[i].addScaledVector(spin[i], dt);
        dummy.position.copy(pos[i]);
        dummy.rotation.set(rot[i].x, rot[i].y, rot[i].z);
        dummy.scale.setScalar(Math.max(0, 1 - age / 900));
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (age >= 900) {
        stop();
        scene.remove(mesh);
        mesh.dispose();
      }
    });
  }

  // --- teardown -------------------------------------------------------------

  function dispose(): void {
    alive = false;
    cancelAnimationFrame(raf);
    frameCbs.clear();
    if (observer) observer.disconnect();
    observer = null;
    scene.traverse((o) => {
      const m = o as Mesh;
      if (m.geometry) geometries.add(m.geometry);
    });
    scene.clear();
    for (const g of geometries) g.dispose();
    for (const m of materials) m.dispose();
    geometries.clear();
    materials.clear();
    toonCache.clear();
    releaseRenderer(renderer);
  }

  return {
    scene,
    camera,
    renderer,
    bean,
    block,
    tile,
    pill,
    cloud,
    shadowDisc,
    instanced,
    tween,
    confetti,
    project,
    onFrame,
    resize,
    dispose,
  };
}

