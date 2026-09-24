// Tone Catcher, the 3D track. `three` arrives in this chunk and nowhere else.
//
// Three pastel lanes running away to a vanishing point, white pill rails, a
// bean at the near end, drifting clouds, and one gate at a time sliding in from
// the horizon. Every glyph is DOM: the gate labels are HTML pinned to world
// points with `kit.project`, exactly as the kit contract requires.

import type { Kit, Bean } from '../scene/three-kit';
import '../scene/kit.css';
import './tone-catcher.css';
import type { CatcherScene, GateResult } from './tone-catcher';

/** Where the three lanes sit on world x. */
export const LANE_X = [-3.4, 0, 3.4];

/** How long the runner takes to slide from one lane to the next. */
export const SLIDE_MS = 220;

/** The gate travels from here to the bean. */
const FAR_Z = -24;
const BEAN_Z = 3.2;
const TRACK_LEN = 40;
/** The road carries on past the bean so it reaches the bottom of the frame. */
const TRACK_OVERRUN = 5;

export interface SceneOpts {
  probe?: boolean;
}

export async function mountToneCatcher3d(
  stage: HTMLElement,
  overlay: HTMLElement,
  opts: SceneOpts = {}
): Promise<CatcherScene> {
  const canvas = document.createElement('canvas');
  stage.append(canvas);

  const { createKit, BEAN_COLORS, Vector3, easeTo } = await import('../scene/three-kit');
  const kit: Kit = createKit(canvas, { sky: 'day', fov: 46 });

  // A runner looks down the track, so the camera sits lower and closer than the
  // kit's board default and aims at the horizon rather than at the floor.
  kit.camera.position.set(0, 3.3, 9.2);
  kit.camera.lookAt(0, 1, -7);

  // --- the track ------------------------------------------------------------

  const laneColors = ['mint', 'butter', 'lilac'] as const;
  LANE_X.forEach((x, i) => {
    const lane = kit.tile({ w: 3.1, h: TRACK_LEN, color: laneColors[i] });
    lane.position.set(x, 0, BEAN_Z + TRACK_OVERRUN - TRACK_LEN / 2);
    kit.scene.add(lane);
  });

  for (const x of [-5.05, -1.7, 1.7, 5.05]) {
    const rail = kit.pill({ length: TRACK_LEN, radius: 0.11, color: 'cloud' });
    rail.rotation.x = Math.PI / 2; // a capsule stands on y; lay it along z
    rail.position.set(x, 0.2, BEAN_Z + TRACK_OVERRUN - TRACK_LEN / 2);
    kit.scene.add(rail);
  }

  // --- the runner -----------------------------------------------------------

  const bean: Bean = kit.bean({ color: BEAN_COLORS[0], name: 'runner' });
  bean.group.position.set(LANE_X[1], 0.16, BEAN_Z);
  // The kit's bean is sized for a whole roster on a board; one runner on a
  // three-lane track needs to read from the back of a classroom.
  bean.group.scale.setScalar(1.3);
  kit.scene.add(bean.group);

  // --- the gate -------------------------------------------------------------
  //
  // Three arches, moved together along z. They are parented straight to the
  // scene rather than to a Group, because a Group would mean importing `Group`
  // from three here and the kit deliberately owns that import.

  let gateOn = false;
  let progress = 0;
  let lane = 1;

  interface GatePost {
    left: ReturnType<Kit['pill']>;
    right: ReturnType<Kit['pill']>;
    bar: ReturnType<Kit['pill']>;
    light: ReturnType<Kit['block']>;
  }

  const posts: GatePost[] = LANE_X.map((x, i) => {
    const color = laneColors[i];
    const left = kit.pill({ length: 1.7, radius: 0.16, color });
    left.position.set(x - 1.4, 0.95, FAR_Z);
    const right = kit.pill({ length: 1.7, radius: 0.16, color });
    right.position.set(x + 1.4, 0.95, FAR_Z);
    const bar = kit.pill({ length: 2.8, radius: 0.16, color });
    bar.rotation.z = Math.PI / 2;
    bar.position.set(x, 1.85, FAR_Z);
    // The "correct lane" light. Mint, flat on the floor, hidden until a miss.
    const light = kit.block({ w: 2.9, h: 0.12, d: 1.4, color: 'mint', rounded: true });
    light.position.set(x, 0.08, FAR_Z);
    light.visible = false;
    kit.scene.add(left, right, bar, light);
    return { left, right, bar, light };
  });

  const setGateZ = (z: number): void => {
    for (const post of posts) {
      post.left.position.z = z;
      post.right.position.z = z;
      post.bar.position.z = z;
      post.left.visible = gateOn;
      post.right.visible = gateOn;
      post.bar.visible = gateOn;
    }
  };

  // --- clouds ---------------------------------------------------------------

  const clouds = [1.4, 1.0, 1.7].map((scale, i) => {
    const puff = kit.cloud(scale);
    puff.position.set(-10 + i * 8, 5.2 + (i % 2) * 1.4, -15 - i * 4);
    kit.scene.add(puff);
    return puff;
  });

  // --- DOM labels -----------------------------------------------------------

  const labelLayer = document.createElement('div');
  labelLayer.className = 'tc-gate-layer';
  overlay.append(labelLayer);
  stage.append(overlay);

  let labels: HTMLElement[] = [];

  function placeLabels(): void {
    if (!labels.length) return;
    const z = FAR_Z + (BEAN_Z - FAR_Z) * progress;
    // Bigger as it gets closer: the label is the gate's face, so it has to grow
    // with the gate or the perspective reads as a bug.
    const scale = 0.62 + 0.62 * progress;
    // True perspective would stack the three labels almost on top of each other
    // while the gate is far away, which on a 390-wide phone is unreadable. So
    // they are held wider apart out there and slide onto their own lanes as the
    // gate arrives. The gate ARCHES stay honest; only the signs are spread.
    const spread = 1 + 0.85 * (1 - progress) ** 1.4;
    labels.forEach((label, i) => {
      const at = kit.project(new Vector3(LANE_X[i] * spread, 2.15, z));
      label.style.left = `${at.x}px`;
      label.style.top = `${at.y}px`;
      label.style.transform = `translate(-50%, -50%) scale(${scale.toFixed(3)})`;
      label.style.opacity = progress < 0.04 ? '0' : '1';
    });
  }

  // The lane slide runs on this frame loop rather than on `kit.tween`. The
  // loop is then the only thing that reads OR writes the runner's x, so a
  // restart mid-slide simply drops it, and the last frame lands exactly on the
  // lane. Driven by kit.tween the loop read the carrier one frame before the
  // tween wrote its final value, and the runner settled off-centre for good.
  let slide: { from: number; to: number; run: number } | null = null;

  const stopFrame = kit.onFrame((dt) => {
    for (const puff of clouds) {
      puff.position.x += dt * 0.55;
      if (puff.position.x > 12) puff.position.x = -12;
    }
    if (slide) {
      slide.run += dt * 1000;
      bean.group.position.x = easeTo(slide.from, slide.to, slide.run, SLIDE_MS, 'overshoot');
      if (slide.run >= SLIDE_MS) slide = null;
    }
    placeLabels();
  });

  // --- the CatcherScene contract -------------------------------------------

  function showGate(nodes: HTMLElement[]): void {
    labels = nodes;
    labelLayer.replaceChildren(...nodes);
    for (const node of nodes) node.classList.add('tc-gate-label-3d');
    gateOn = true;
    progress = 0;
    for (const post of posts) post.light.visible = false;
    setGateZ(FAR_Z);
    placeLabels();
  }

  function setGateProgress(t: number): void {
    progress = Math.max(0, Math.min(1, t));
    setGateZ(FAR_Z + (BEAN_Z - FAR_Z) * progress);
  }

  function setLane(next: number, animate: boolean): void {
    lane = Math.max(0, Math.min(LANE_X.length - 1, next));
    if (!animate) {
      slide = null;
      bean.group.position.x = LANE_X[lane];
      return;
    }
    slide = { from: bean.group.position.x, to: LANE_X[lane], run: 0 };
    void bean.hop(0.55);
  }

  function resolve(result: GateResult): void {
    const at = new Vector3(LANE_X[lane], 1.1, BEAN_Z);
    if (result.correct) {
      kit.confetti(at, 46);
      void bean.cheer();
    } else {
      void bean.stumble();
      const light = posts[result.correctLane]?.light;
      if (light) {
        light.visible = true;
        light.position.z = BEAN_Z;
      }
    }
  }

  function clearGate(): void {
    gateOn = false;
    labels = [];
    labelLayer.replaceChildren();
    for (const post of posts) post.light.visible = false;
    setGateZ(FAR_Z);
  }

  const scene: CatcherScene = {
    showGate,
    setGateProgress,
    setLane,
    resolve,
    clearGate,
    resize: () => kit.resize(),
    dispose: () => {
      stopFrame();
      labelLayer.remove();
      kit.dispose();
      canvas.remove();
    },
  };

  if (opts.probe) {
    // Same trick as the kit demo: render and read back inside ONE task, because
    // the browser wipes the drawing buffer as soon as it composites.
    scene.probePixels = (want = 240) => {
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

  setGateZ(FAR_Z);
  kit.resize();
  return scene;
}

