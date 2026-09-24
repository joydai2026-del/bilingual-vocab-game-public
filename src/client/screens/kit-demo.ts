// #/kit-demo: the hidden page the three 3D games are eyeballed against.
//
// Not linked from anywhere. It exists so a change to the kit can be LOOKED at
// (the render gate) instead of only compiled, and so a game builder can see
// what every kit call actually produces before writing a scene.
//
// It renders the same picture twice: the WebGL scene, and the CSS twin that
// runs when `?flat=1` is set or the device has no WebGL 2. Both are here for
// the same reason every game ships a twin.

import '../scene/kit.css';
import { wantsFlat } from '../scene/webgl';
import { h } from '../ui';
import './kit-demo.css';

const TITLE = '云端大冒险';
const PINYIN = 'yún duān dà mào xiǎn';
const HERO_LABEL = '豆豆 dòu dou';

/** What the render-gate hook hands back. Sampled, not the whole buffer. */
interface KitPixels {
  w: number;
  h: number;
  drawn: number;
  lum: number[];
}

/** The six floating platforms, shared by the 3D scene and the flat twin. */
const PLATFORMS: Array<{ w: number; h: number; color: string; x: number; y: number; z: number }> = [
  { w: 6.4, h: 3.2, color: 'mint', x: -3.4, y: 0, z: 1.4 },
  { w: 6.4, h: 3.2, color: 'butter', x: 3.4, y: 0, z: 1.4 },
  { w: 3.2, h: 2.2, color: 'sky', x: -5.4, y: 1.7, z: -3.6 },
  { w: 2.8, h: 2.0, color: 'coral', x: 0.3, y: 2.7, z: -5.2 },
  { w: 3.4, h: 2.2, color: 'lilac', x: 5.2, y: 2.0, z: -4.2 },
  { w: 2.4, h: 1.8, color: 'cloud', x: -2.2, y: 3.5, z: -7.4 },
];

/** Eight beans on a 4 x 2 grid standing on the two front platforms. */
const BEAN_SPOTS: Array<[number, number]> = [
  [-4.9, 2.5],
  [-1.9, 2.5],
  [1.9, 2.5],
  [4.9, 2.5],
  [-4.9, -0.2],
  [-1.9, -0.2],
  [1.9, -0.2],
  [4.9, -0.2],
];

function shell(): {
  page: HTMLElement;
  stage: HTMLElement;
  overlay: HTMLElement;
  flat: boolean;
} {
  const flat = wantsFlat();
  const overlay = h('div', { class: 'kit-overlay' }, [
    h('div', { class: 'kit-title-slot' }, [
      h('h1', { class: 'kit-title' }, [TITLE, h('span', { class: 'kit-pinyin', text: PINYIN })]),
    ]),
    h('div', { class: 'kit-mode', text: flat ? 'flat twin (CSS only)' : '3D (three.js)' }),
    h('button', {
      class: 'kit-hit kit-toggle',
      type: 'button',
      text: flat ? '3D look' : 'Flat look',
      onclick: () => {
        const url = new URL(window.location.href);
        if (flat) url.searchParams.delete('flat');
        else url.searchParams.set('flat', '1');
        window.location.href = url.toString();
      },
    }),
  ]);
  const stage = h('div', { class: 'kit-stage' });
  const page = h('div', { class: 'kit-demo' }, [stage]);
  return { page, stage, overlay, flat };
}

/** The flat twin: the same picture in rounded divs. No canvas, no three. */
function mountFlat(stage: HTMLElement, overlay: HTMLElement): () => void {
  stage.classList.add('kit-sky-day');

  const tint: Record<string, string> = {
    mint: '#B7F0D3',
    butter: '#FFE8A3',
    sky: '#BFE3FF',
    coral: '#FFB3A7',
    lilac: '#D9C8FF',
    cloud: '#FFFFFF',
  };

  // World x in [-8, 8] and y in [0, 6] map onto the box; higher y sits higher
  // and further back, which is all the depth cue a flat twin needs.
  const left = (x: number, w: number): string => `${((x - w / 2 + 8) / 16) * 100}%`;
  const width = (w: number): string => `${(w / 16) * 100}%`;
  const bottom = (y: number): string => `${18 + (y / 6) * 52}%`;

  for (const p of PLATFORMS) {
    stage.append(
      h('div', {
        class: 'kit-flat-platform',
        style: `left:${left(p.x, p.w)};width:${width(p.w)};bottom:${bottom(p.y)};height:${
          2.4 + p.h * 0.9
        }%;background:${tint[p.color]}`,
      })
    );
  }

  const beans = ['#FF8FA3', '#FFB26B', '#FFD166', '#EAF07A', '#A8E6A1', '#6FD6D0', '#7EC4F2', '#8FA8F0'];
  BEAN_SPOTS.forEach(([x, z], i) => {
    const back = z < 1;
    stage.append(
      h('div', {
        class: 'kit-flat-shadow',
        style: `left:${left(x, 1.3)};width:${width(1.3)};bottom:${back ? 30 : 21}%;opacity:${
          back ? 0.5 : 1
        }`,
      }),
      h('div', {
        class: 'kit-flat-bean',
        style: `left:${left(x, 1)};width:${width(1)};bottom:${back ? 31 : 22}%;transform:scale(${
          back ? 0.82 : 1
        });transform-origin:bottom center;background:${beans[i]}`,
      })
    );
  });

  stage.append(
    h('div', { class: 'kit-flat-cloud', style: 'left:12%;top:10%;width:11%' }),
    h('div', { class: 'kit-flat-cloud', style: 'left:70%;top:18%;width:8%' })
  );

  const label = h('div', {
    class: 'kit-label',
    text: HERO_LABEL,
    style: `left:${left(-4.9, 0)};top:62%`,
  });
  overlay.append(label);
  stage.append(overlay);

  return () => {
    stage.replaceChildren();
  };
}

/** The 3D scene. `three` arrives only here, in its own lazy chunk. */
async function mount3d(stage: HTMLElement, overlay: HTMLElement): Promise<() => void> {
  const canvas = h('canvas');
  stage.append(canvas);

  const { createKit, BEAN_COLORS, Vector3 } = await import('../scene/three-kit');
  const kit = createKit(canvas, { sky: 'day' });

  for (const p of PLATFORMS) {
    const slab = kit.tile({ w: p.w, h: p.h, color: p.color });
    slab.position.set(p.x, p.y, p.z);
    kit.scene.add(slab);
  }

  const beans = BEAN_SPOTS.map(([x, z], i) => {
    const b = kit.bean({ color: BEAN_COLORS[i], name: `bean-${i}` });
    b.group.position.set(x, 0.14, z);
    kit.scene.add(b.group);
    return b;
  });
  const hero = beans[0];

  const puff = kit.cloud(1.3);
  puff.position.set(-8, 5.2, -6);
  kit.scene.add(puff);

  const label = h('div', { class: 'kit-label', text: HERO_LABEL });
  overlay.append(label);
  stage.append(overlay);

  const head = new Vector3();
  const stopFrame = kit.onFrame((dt) => {
    puff.position.x += dt * 0.9;
    if (puff.position.x > 9) puff.position.x = -9;
    head.set(hero.group.position.x, hero.group.position.y + 1.6, hero.group.position.z);
    const at = kit.project(head);
    label.style.left = `${at.x}px`;
    label.style.top = `${at.y}px`;
  });

  let live = true;
  void (async () => {
    while (live) {
      await hero.hop(0.95);
      if (!live) return;
      await new Promise((r) => setTimeout(r, 380));
    }
  })();

  const burst = window.setInterval(() => {
    kit.confetti(new Vector3(hero.group.position.x, hero.group.position.y + 1.1, hero.group.position.z), 48);
  }, 3000);

  const onResize = (): void => kit.resize();
  window.addEventListener('resize', onResize);

  // The render gate's only way in. A WebGL drawing buffer is wiped when the
  // browser composites the frame, so `readPixels` from an outside task always
  // reads zeros: the draw and the read must happen in the SAME task. This hook
  // does exactly that and hands back sampled luminance for the harness to judge.
  // It exists only on this hidden demo page, never in a game.
  (window as unknown as { __kitPixels?: (want: number) => KitPixels }).__kitPixels = (want = 240) => {
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

  return () => {
    live = false;
    delete (window as unknown as { __kitPixels?: unknown }).__kitPixels;
    window.clearInterval(burst);
    window.removeEventListener('resize', onResize);
    stopFrame();
    kit.dispose();
    stage.replaceChildren();
  };
}

export function renderKitDemo(root: HTMLElement): () => void {
  const { page, stage, overlay, flat } = shell();
  root.replaceChildren(page);

  let teardown: (() => void) | null = null;
  let dropped = false;

  if (flat) {
    teardown = mountFlat(stage, overlay);
  } else {
    void mount3d(stage, overlay)
      .then((off) => {
        if (dropped) off();
        else teardown = off;
      })
      .catch(() => {
        // The contract's fallback: a failed import or a dead context runs the
        // twin rather than leaving a blank stage.
        if (!dropped) teardown = mountFlat(stage, overlay);
      });
  }

  return () => {
    dropped = true;
    if (teardown) teardown();
    teardown = null;
  };
}

