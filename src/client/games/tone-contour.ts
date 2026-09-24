// The little pitch curve drawn over a Hard-mode lane.
//
// Colour is decoration only: the SHAPE carries the tone, and the tone number
// is printed under it, so a colour-blind child and a black-and-white projector
// both still get the answer. That is the whole reason this is a drawn curve
// and not four coloured dots.

/** viewBox units. y = 0 is the top of the voice range, y = H the bottom. */
const W = 34;
const H = 24;

/**
 * One path per tone. 1 flat high, 2 rising, 3 dipping, 4 falling. Tone 5
 * (neutral) has no contour at all, so it is drawn as a short mid dash.
 */
const PATHS: Record<number, string> = {
  1: `M3 5 L${W - 3} 5`,
  2: `M3 ${H - 4} L${W - 3} 4`,
  3: `M3 9 C 10 ${H - 1}, 20 ${H - 1}, ${W - 3} 7`,
  4: `M3 4 L${W - 3} ${H - 4}`,
  5: `M11 ${H / 2} L${W - 11} ${H / 2}`,
};

function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string>
): SVGElementTagNameMap[K] {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

/**
 * A row of contours, one per syllable, each with its tone number underneath.
 * `tones` comes straight from `toneSequence()`, so a two-syllable word gets two
 * curves side by side in reading order.
 */
export function toneContour(tones: readonly number[]): HTMLElement {
  const row = document.createElement('span');
  row.className = 'tc-contours';
  row.setAttribute('aria-hidden', 'true');

  for (const raw of tones.length ? tones : [5]) {
    const tone = PATHS[raw] ? raw : 5;
    const cell = document.createElement('span');
    cell.className = `tc-contour tc-tone-${tone}`;

    const svg = svgEl('svg', {
      viewBox: `0 0 ${W} ${H}`,
      width: String(W),
      height: String(H),
      fill: 'none',
    });
    // A pale baseline so a flat first tone still reads as "high", not "middle".
    svg.append(
      svgEl('path', {
        d: `M3 ${H - 2} L${W - 3} ${H - 2}`,
        stroke: 'currentColor',
        'stroke-width': '1',
        'stroke-opacity': '0.28',
        'stroke-linecap': 'round',
      }),
      svgEl('path', {
        d: PATHS[tone],
        stroke: 'currentColor',
        'stroke-width': '3.2',
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
      })
    );

    const number = document.createElement('b');
    number.textContent = String(tone);

    cell.append(svg, number);
    row.append(cell);
  }

  return row;
}

/** Spoken form of a tone row, for the lane button's accessible name. */
export function toneWords(tones: readonly number[]): string {
  return (tones.length ? tones : [5])
    .map((tone) => (tone === 5 ? 'neutral tone' : `tone ${tone}`))
    .join(', ');
}

