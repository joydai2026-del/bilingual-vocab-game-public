// Memory Match. Cards face down; turn two over and find the Chinese word
// with its English meaning. 6 pairs a round for little kids, 8 for big kids
// and adults; a bigger set keeps going in later rounds.
//
// Round slicing lives in shared/memory.ts so every word is played exactly
// once across the rounds (a one-word tail joins the round before it).

import { roundCount, roundItems } from '../../shared/memory';
import { seededShuffle } from '../../shared/rng';
import type { VocabItem, VocabSet } from '../../shared/types';
import { applyLevel, audioStatusLine, pinyinToggle } from '../controls';
import { celebrate, correctSound, flipSound, pulse, shake } from '../feedback';
import { pinyinOn } from '../state';
import { speak } from '../tts';
import { speakerButton } from '../speaker';
import { h, isCjkSentence, screen } from '../ui';

interface Card {
  item: VocabItem;
  side: 'zh' | 'en';
  node: HTMLButtonElement;
  matched: boolean;
}

function pairsPerRound(set: VocabSet): number {
  return set.level === 'kids' ? 6 : 8;
}

function formatTime(ms: number): string {
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

export function renderMemory(root: HTMLElement, set: VocabSet, encoded: string): () => void {
  applyLevel(set.level);

  const perRound = pairsPerRound(set);
  const { root: page, body } = screen('Memory Match', { back: `#/set/${encoded}` });

  const movesOut = h('b', { text: '0' });
  const timeOut = h('b', { text: '0:00' });
  const roundOut = h('b', { text: '1' });
  const grid = h('div', { class: 'memory-grid' });
  const banner = h('div');
  const controls = h('div', { class: 'row' });

  let order = seededShuffle(set.items, Math.floor(Math.random() * 2 ** 31));
  let roundIndex = 0;
  let cards: Card[] = [];
  let facing: Card[] = [];
  let moves = 0;
  let matched = 0;
  let startedAt = Date.now();
  let locked = false;

  const timer = window.setInterval(() => {
    timeOut.textContent = formatTime(Date.now() - startedAt);
  }, 500);

  const roundTotal = Math.max(1, roundCount(set.items.length, perRound));

  const faceFor = (card: Card): HTMLElement => {
    if (card.side === 'en') {
      // A Chinese-taught set's meaning is a whole sentence, not a two-word
      // gloss. At the card's normal size it came out one character per line and
      // stretched the tile (round 1 review, 390 px). The sentence class shrinks
      // it and lets it wrap.
      return h('span', {
        class: isCjkSentence(card.item.en) ? 'face zh-sentence' : 'face',
        text: card.item.en,
      });
    }
    return h('span', { class: 'face' }, [
      h('span', { class: 'zh', text: card.item.zh }),
      pinyinOn() && card.item.pinyin ? h('span', { class: 'py', text: card.item.pinyin }) : null,
    ]);
  };

  const paintFaces = (): void => {
    for (const card of cards) {
      const face = card.node.querySelector('.face');
      face?.replaceWith(faceFor(card));
    }
  };

  const onFlip = (card: Card): void => {
    if (locked || card.matched || facing.includes(card)) return;

    card.node.classList.add('up');
    facing.push(card);
    flipSound();

    if (facing.length < 2) return;

    moves++;
    movesOut.textContent = String(moves);
    const [a, b] = facing;

    if (a.item.id === b.item.id) {
      facing = [];
      matched++;
      for (const card2 of [a, b]) {
        card2.matched = true;
        card2.node.classList.remove('up');
        card2.node.classList.add('done');
        card2.node.disabled = true;
        pulse(card2.node);
      }
      correctSound();
      void speak(a.item.zh).catch(() => undefined);
      // A matched Chinese card keeps a speaker so the word can be replayed.
      const zhCard = [a, b].find((card2) => card2.side === 'zh');
      if (zhCard) {
        zhCard.node.disabled = false;
        zhCard.node.append(speakerButton(() => zhCard.item.zh, { class: 'in-card' }));
      }

      if (matched === cards.length / 2) finishRound();
      return;
    }

    locked = true;
    shake(a.node);
    shake(b.node);
    window.setTimeout(() => {
      for (const card2 of facing) card2.node.classList.remove('up');
      facing = [];
      locked = false;
    }, 900);
  };

  const buildRound = (): void => {
    banner.replaceChildren();
    controls.replaceChildren();
    facing = [];
    matched = 0;
    locked = false;
    // Every round is its own game, so its turns and its clock start at zero.
    // "Next words" used to carry them forward, and a fresh 2-pair round whose
    // minimum is 2 turns reported 8 (live verification 2026-09-08, D6).
    moves = 0;
    movesOut.textContent = '0';
    startedAt = Date.now();
    timeOut.textContent = '0:00';

    const items = roundItems(order, roundIndex, perRound);

    cards = [];
    for (const item of items) {
      for (const side of ['zh', 'en'] as const) {
        const node = h('button', {
          class: 'memory-card',
          type: 'button',
          'aria-label': 'Face-down card',
        });
        const card: Card = { item, side, node, matched: false };
        node.append(faceFor(card), h('span', { class: 'back-face', text: '?' }));
        node.addEventListener('click', () => onFlip(card));
        cards.push(card);
      }
    }

    const shuffled = seededShuffle(cards, Math.floor(Math.random() * 2 ** 31));
    grid.replaceChildren(...shuffled.map((card) => card.node));
    // A CUSTOM PROPERTY, not the property itself. Setting
    // `grid-template-columns` inline beat the phone media query, so a 390 px
    // screen kept four ~78-pixel columns and a Chinese definition came down
    // them three characters at a time (round 1 review). The stylesheet now
    // owns the narrow case and this only says what the wide case wants.
    grid.style.setProperty('--memory-cols', String(items.length >= 6 ? 4 : 2));
    roundOut.textContent = String(roundIndex + 1);
  };

  function finishRound(): void {
    const hasMore = roundIndex + 1 < roundTotal;
    banner.replaceChildren(
      h('div', { class: 'final' }, [
        h('p', {
          class: 'score',
          text: set.level === 'kids' ? 'You found them all!' : 'Round complete',
        }),
        h('p', {
          class: 'hint',
          text: `${moves} turns · ${formatTime(Date.now() - startedAt)}`,
        }),
      ])
    );
    celebrate(banner, set.level);

    const again = h('button', { class: 'btn btn-primary', type: 'button', text: 'Play again' });
    again.addEventListener('click', () => {
      order = seededShuffle(set.items, Math.floor(Math.random() * 2 ** 31));
      roundIndex = 0;
      buildRound();
    });
    controls.replaceChildren(again);

    if (hasMore) {
      const next = h('button', { class: 'btn', type: 'button', text: 'Next words' });
      next.addEventListener('click', () => {
        roundIndex++;
        buildRound();
      });
      controls.append(next);
    }
  }

  body.append(
    h('div', { class: 'game-bar' }, [
      h('div', { class: 'row' }, [
        h('span', { class: 'stat' }, ['Turns ', movesOut]),
        h('span', { class: 'stat' }, ['Time ', timeOut]),
        roundTotal > 1
          ? h('span', { class: 'stat' }, ['Round ', roundOut, ` of ${roundTotal}`])
          : null,
      ]),
      pinyinToggle(() => paintFaces()),
    ]),
    grid,
    banner,
    controls,
    audioStatusLine()
  );

  root.replaceChildren(page);
  buildRound();

  return () => window.clearInterval(timer);
}

