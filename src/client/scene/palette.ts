// The pastel palette the board is drawn in. One source of truth: the CSS board
// reads it through custom properties, so a colour is never written twice.
//
// Eight beans is the classroom ceiling the plan sizes for, so there are eight
// colours and a player's colour is `colorIndex % 8`. Every fill is paired with
// a darker rim so a bean still reads as a shape on a washed-out projector.

export interface BeanColor {
  /** Body fill. */
  fill: string;
  /** Rim and shadow, dark enough to survive a projector. */
  rim: string;
  /** Plain-language name, used in the demo route and in aria labels. */
  name: string;
}

export const BEAN_COLORS: BeanColor[] = [
  { fill: '#ff8fa3', rim: '#b8455a', name: 'coral' },
  { fill: '#7ec4f2', rim: '#22648f', name: 'sky' },
  { fill: '#8fd9a8', rim: '#2f7d51', name: 'mint' },
  { fill: '#ffd166', rim: '#a97b0c', name: 'sunny' },
  { fill: '#b8a6e8', rim: '#61499f', name: 'violet' },
  { fill: '#ffb26b', rim: '#a85f16', name: 'mango' },
  { fill: '#6fd6d0', rim: '#1f7d78', name: 'teal' },
  { fill: '#f49ac2', rim: '#a84278', name: 'rose' },
];

export function beanColor(colorIndex: number): BeanColor {
  const safe = Number.isFinite(colorIndex) ? Math.abs(Math.trunc(colorIndex)) : 0;
  return BEAN_COLORS[safe % BEAN_COLORS.length];
}

/** Platforms alternate between these two tints so the tower reads as steps. */
export const PLATFORM_TINTS = ['#ffffff', '#f2f6ff'];

export const BOARD_COLORS = {
  /** Sky behind the tower. */
  skyTop: '#e8f2ff',
  skyBottom: '#fff4e4',
  platformRim: '#c9d6e8',
  goal: '#ffd166',
  goalRim: '#a97b0c',
  chest: '#e0a45c',
  chestDark: '#a86c2c',
  chestLid: '#f0be7c',
  coin: '#ffd166',
  label: '#16212e',
} as const;

/**
 * Writes the palette onto an element as custom properties. Anything drawn
 * inside it (DOM today, a canvas later) can then read one set of values.
 */
export function paintPaletteVars(node: HTMLElement): void {
  node.style.setProperty('--sky-top', BOARD_COLORS.skyTop);
  node.style.setProperty('--sky-bottom', BOARD_COLORS.skyBottom);
  node.style.setProperty('--platform-a', PLATFORM_TINTS[0]);
  node.style.setProperty('--platform-b', PLATFORM_TINTS[1]);
  node.style.setProperty('--platform-rim', BOARD_COLORS.platformRim);
  node.style.setProperty('--goal', BOARD_COLORS.goal);
  node.style.setProperty('--goal-rim', BOARD_COLORS.goalRim);
  node.style.setProperty('--chest', BOARD_COLORS.chest);
  node.style.setProperty('--chest-dark', BOARD_COLORS.chestDark);
  node.style.setProperty('--chest-lid', BOARD_COLORS.chestLid);
  node.style.setProperty('--coin', BOARD_COLORS.coin);
}

