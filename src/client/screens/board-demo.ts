// `#/demo/board` — the board on its own, with four fake beans.
//
// Not linked from anywhere a class would find. It exists so the board can be
// looked at (and screenshotted) without a room, a server or a set: every
// animation the room can ask for is one button away here.

import { createBoard, type Board, type BoardPlayer } from '../scene/board';
import { screen, h } from '../ui';

const NAMES = ['Ana', 'Ben', 'Chen', 'Dot'];
const HEIGHT = 10;

export function renderBoardDemo(root: HTMLElement): () => void {
  const { root: page, body } = screen('Board demo', {
    back: '#/',
    subtitle: 'Four beans, no room, no server.',
  });

  const stage = h('div', { class: 'board-host' });
  const controls = h('div', { class: 'row' });
  body.append(controls, stage);
  root.replaceChildren(page);

  let players: BoardPlayer[] = NAMES.map((name, i) => ({
    id: `p${i}`,
    name,
    colorIndex: i,
    step: 0,
    score: 0,
    isMe: i === 0,
  }));

  let board: Board | null = null;
  let kind: 'climb' | 'dash' = 'climb';
  let compact = false;
  let timer = 0;
  let disposed = false;
  let generation = 0;

  async function build(): Promise<void> {
    const mine = ++generation;
    board?.dispose();
    board = null;
    const next = await createBoard(stage, kind, { height: HEIGHT, compact });
    // Two rebuilds raced (two taps in a row): the loser throws its board away
    // rather than leaving two boards fighting over one container.
    if (disposed || mine !== generation) {
      next.dispose();
      return;
    }
    board = next;
    board.setPlayers(players);
  }

  /** One random bean either hops or stumbles, the way a real round drives it. */
  function tick(): void {
    if (!board) return;
    const i = Math.floor(Math.random() * players.length);
    const target = players[i];
    if (Math.random() < 0.7) {
      const step = Math.min(HEIGHT, target.step + 1);
      players = players.map((p, n) =>
        n === i ? { ...p, step, score: p.score + 100 } : p
      );
      board.setPlayers(players);
      board.hop(target.id, step);
    } else {
      board.stumble(target.id);
    }
  }

  const button = (label: string, onClick: () => void): HTMLButtonElement => {
    const node = h('button', { class: 'btn', type: 'button', text: label });
    node.addEventListener('click', onClick);
    return node;
  };

  controls.append(
    button('Hop or stumble', tick),
    button('Coins', () =>
      board?.chest(players[0].id, 1, { kind: 'points', points: 200 })
    ),
    button('Swap', () =>
      board?.chest(players[0].id, 0, {
        kind: 'swap',
        withPlayerId: players[1].id,
        before: 100,
        after: 900,
      })
    ),
    button('Steal', () =>
      board?.chest(players[2].id, 2, { kind: 'steal', fromPlayerId: players[1].id, points: 250 })
    ),
    button('Climb / Dash', () => {
      kind = kind === 'climb' ? 'dash' : 'climb';
      void build();
    }),
    button('Full / compact', () => {
      compact = !compact;
      void build();
    })
  );

  void build();
  timer = window.setInterval(tick, 1400);

  return () => {
    disposed = true;
    window.clearInterval(timer);
    board?.dispose();
    board = null;
  };
}

