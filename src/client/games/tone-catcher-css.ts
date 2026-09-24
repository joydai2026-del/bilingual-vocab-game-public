// Tone Catcher, the flat twin. Same rules, same DOM overlay, no WebGL.
//
// It runs when `?flat=1` is set, when the device has no WebGL 2, or when the 3D
// chunk fails to arrive. The picture is the same one with the depth taken out:
// three pastel lanes narrowing toward a horizon line, a CSS bean at the bottom,
// and the gate labels sliding down the track from small to large.

import '../scene/kit.css';
import './tone-catcher.css';
import type { CatcherScene, GateResult } from './tone-catcher';

// The road, in percentages of the track box. It runs from a narrow band at the
// horizon down to almost the full width at the bean, and each lane is one
// trapezoid cut out of a full-size div with `clip-path`. Doing the geometry
// here rather than in three hand-written CSS polygons is what stops the three
// lanes drifting out of alignment with each other.
const FAR_LEFT = 43;
const FAR_RIGHT = 57;
const NEAR_LEFT = 10;
const NEAR_RIGHT = 90;

/** Lane centres as a percentage of the stage width, near end and far end. */
const NEAR_X = [
  NEAR_LEFT + (NEAR_RIGHT - NEAR_LEFT) / 6,
  50,
  NEAR_RIGHT - (NEAR_RIGHT - NEAR_LEFT) / 6,
];

/**
 * Where the three signs sit while the gate is still far away. Not the true
 * perspective position: at the horizon all three lanes are within 14% of each
 * other and the labels would sit on top of one another on a phone.
 */
const LABEL_FAR_X = [19, 50, 81];

/** The gate slides from the horizon down to the bean. */
const FAR_Y = 16;
const NEAR_Y = 72;

function laneClip(i: number): string {
  const farStep = (FAR_RIGHT - FAR_LEFT) / 3;
  const nearStep = (NEAR_RIGHT - NEAR_LEFT) / 3;
  const fl = FAR_LEFT + i * farStep;
  const fr = fl + farStep;
  const nl = NEAR_LEFT + i * nearStep;
  const nr = nl + nearStep;
  return `polygon(${nl}% 100%, ${fl}% 0%, ${fr}% 0%, ${nr}% 100%)`;
}

export interface SceneOpts {
  probe?: boolean;
}

export function mountToneCatcherCss(
  stage: HTMLElement,
  overlay: HTMLElement,
  _opts: SceneOpts = {}
): CatcherScene {
  stage.classList.add('kit-sky-day', 'tc-flat');

  const track = document.createElement('div');
  track.className = 'tc-flat-track';
  for (let i = 0; i < 3; i += 1) {
    const lane = document.createElement('div');
    lane.className = `tc-flat-lane tc-flat-lane-${i}`;
    lane.style.clipPath = laneClip(i);
    track.append(lane);
  }
  stage.append(track);

  for (const spot of [
    { left: '10%', top: '8%', width: '15%' },
    { left: '68%', top: '13%', width: '12%' },
  ]) {
    const puff = document.createElement('div');
    puff.className = 'kit-flat-cloud tc-flat-cloud';
    puff.style.left = spot.left;
    puff.style.top = spot.top;
    puff.style.width = spot.width;
    stage.append(puff);
  }

  const shadow = document.createElement('div');
  shadow.className = 'kit-flat-shadow tc-flat-shadow';
  const bean = document.createElement('div');
  bean.className = 'kit-flat-bean tc-flat-bean';
  stage.append(shadow, bean);

  const labelLayer = document.createElement('div');
  labelLayer.className = 'tc-gate-layer';
  overlay.append(labelLayer);
  stage.append(overlay);

  let labels: HTMLElement[] = [];
  let progress = 0;
  let lane = 1;

  function placeBean(animate: boolean): void {
    if (animate) {
      bean.style.transition = 'left 200ms cubic-bezier(.34,1.56,.64,1)';
      shadow.style.transition = bean.style.transition;
    } else {
      // A restart lands here mid-slide. Dropping the transition and FLUSHING it
      // before the new left cancels the run in flight; without the flush the
      // browser can keep animating and park the bean in the old lane.
      bean.classList.remove('tc-hop');
      bean.style.transition = 'none';
      shadow.style.transition = 'none';
      void bean.offsetWidth;
    }
    bean.style.left = `${NEAR_X[lane]}%`;
    shadow.style.left = `${NEAR_X[lane]}%`;
  }

  function placeLabels(): void {
    if (!labels.length) return;
    const top = FAR_Y + (NEAR_Y - FAR_Y) * progress;
    const scale = 0.62 + 0.62 * progress;
    labels.forEach((label, i) => {
      const x = LABEL_FAR_X[i] + (NEAR_X[i] - LABEL_FAR_X[i]) * progress;
      label.style.left = `${x}%`;
      label.style.top = `${top}%`;
      label.style.transform = `translate(-50%, -50%) scale(${scale.toFixed(3)})`;
      label.style.opacity = progress < 0.04 ? '0' : '1';
    });
  }

  function showGate(nodes: HTMLElement[]): void {
    labels = nodes;
    labelLayer.replaceChildren(...nodes);
    for (const node of nodes) node.classList.add('tc-gate-label-flat');
    progress = 0;
    for (const el of track.children) el.classList.remove('tc-flat-lane-lit');
    placeLabels();
  }

  function setGateProgress(t: number): void {
    progress = Math.max(0, Math.min(1, t));
    placeLabels();
  }

  function setLane(next: number, animate: boolean): void {
    lane = Math.max(0, Math.min(NEAR_X.length - 1, next));
    placeBean(animate);
    if (animate) {
      bean.classList.remove('tc-hop');
      // Restart the keyframe: reading offsetWidth forces the style flush.
      void bean.offsetWidth;
      bean.classList.add('tc-hop');
    }
  }

  function resolve(result: GateResult): void {
    if (result.correct) {
      bean.classList.remove('tc-stumble');
      bean.classList.add('tc-cheer');
      burst();
    } else {
      bean.classList.remove('tc-cheer');
      void bean.offsetWidth;
      bean.classList.add('tc-stumble');
      track.children[result.correctLane]?.classList.add('tc-flat-lane-lit');
    }
  }

  /** The flat answer to `kit.confetti`: a dozen coloured squares on a timer. */
  function burst(): void {
    const colors = ['#FF8FA3', '#FFD166', '#A8E6A1', '#7EC4F2', '#D9C8FF'];
    const box = document.createElement('div');
    box.className = 'tc-flat-burst';
    box.style.left = `${NEAR_X[lane]}%`;
    for (let i = 0; i < 14; i += 1) {
      const bit = document.createElement('i');
      bit.style.background = colors[i % colors.length];
      bit.style.setProperty('--x', `${Math.round(Math.random() * 160 - 80)}px`);
      bit.style.setProperty('--r', `${Math.round(Math.random() * 360)}deg`);
      bit.style.setProperty('--d', `${Math.round(Math.random() * 160)}ms`);
      box.append(bit);
    }
    stage.append(box);
    window.setTimeout(() => box.remove(), 1000);
  }

  function clearGate(): void {
    labels = [];
    labelLayer.replaceChildren();
    for (const el of track.children) el.classList.remove('tc-flat-lane-lit');
    bean.classList.remove('tc-cheer', 'tc-stumble', 'tc-hop');
  }

  placeBean(false);

  return {
    showGate,
    setGateProgress,
    setLane,
    resolve,
    clearGate,
    resize: () => placeLabels(),
    dispose: () => {
      labelLayer.remove();
      track.remove();
      bean.remove();
      shadow.remove();
      stage.classList.remove('kit-sky-day', 'tc-flat');
      for (const puff of Array.from(stage.querySelectorAll('.tc-flat-cloud'))) puff.remove();
      for (const b of Array.from(stage.querySelectorAll('.tc-flat-burst'))) b.remove();
    },
  };
}

