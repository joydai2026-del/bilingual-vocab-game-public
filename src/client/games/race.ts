// Race Quiz, solo. Every word in both directions, four choices, a timer per
// question, and a score with a speed bonus. The final screen offers "Race a
// friend", which creates a room on the worker.

import { buildQuestions, perQuestionMsFor, scoreAnswer } from '../../shared/quiz';
import type { Direction, QuizQuestion, VocabSet } from '../../shared/types';
import { applyLevel, audioStatusLine, pinyinToggle } from '../controls';
import { celebrate } from '../feedback';
import { navigate } from '../router';
import { createRoom, joinRoom } from '../room/api';
import { writeMembership } from '../room/session';
import { saveName, savedName } from '../state';
import { h, notice, screen } from '../ui';
import { createQuizView } from './quizview';

const FEEDBACK_MS = 1500;

/**
 * The directions this set can actually be quizzed in.
 *
 * A multiple-choice question needs at least two different answer labels, so a
 * direction whose answers all read the same is dropped rather than shown as a
 * one-button question (which also fails the room's own validation).
 *
 * - `zh2en` answers with English glosses, so it needs two different glosses.
 * - `en2zh` answers with Chinese words, and only asks about words whose gloss
 *   is unique (an ambiguous prompt has no single right answer), so it needs at
 *   least one such word and two different Chinese words to choose between.
 */
export function playableDirections(set: VocabSet): Direction[] {
  const glossCounts = new Map<string, number>();
  for (const item of set.items) {
    glossCounts.set(item.en, (glossCounts.get(item.en) ?? 0) + 1);
  }

  const directions: Direction[] = [];
  if (new Set(set.items.map((item) => item.en)).size >= 2) directions.push('zh2en');

  const askable = set.items.filter((item) => (glossCounts.get(item.en) ?? 0) === 1);
  if (askable.length >= 1 && new Set(set.items.map((item) => item.zh)).size >= 2) {
    directions.push('en2zh');
  }
  return directions;
}

/** Plain-language reason shown wherever Race is offered but cannot be played. */
export function raceDisabledReason(set: VocabSet): string | undefined {
  if (playableDirections(set).length > 0) return undefined;
  const count = set.items.length;
  return `Race needs at least two words with different meanings. This set has ${count} ${
    count === 1 ? 'word' : 'words'
  }.`;
}

export function renderRace(root: HTMLElement, set: VocabSet, encoded: string): () => void {
  applyLevel(set.level);

  const perQuestionMs = perQuestionMsFor(set.level);
  const directions = playableDirections(set);

  const { root: page, body } = screen('Race Quiz', { back: `#/set/${encoded}` });

  // Reachable by pasting a play link straight into the address bar; the set
  // page already hides the button.
  if (directions.length === 0) {
    body.append(notice(raceDisabledReason(set)!, 'warn'));
    root.replaceChildren(page);
    return () => undefined;
  }

  let questions = buildQuestions(set, {
    directions,
    seed: Math.floor(Math.random() * 2 ** 31),
  });
  const scoreOut = h('b', { text: '0' });
  const stage = h('div');
  const problem = h('div');

  let index = 0;
  let score = 0;
  let askedAt = 0;
  let tick = 0;
  let advance = 0;
  let answered = false;

  const stopTimers = (): void => {
    window.clearInterval(tick);
    window.clearTimeout(advance);
  };

  const view = createQuizView(set, (choice) => onAnswer(choice));

  function onAnswer(choice: number | null): void {
    window.clearInterval(tick);
    answered = true;
    const question = questions[index];
    const elapsed = Date.now() - askedAt;
    const correct = choice === question.answer;
    if (correct) {
      score += scoreAnswer(true, elapsed, perQuestionMs);
      scoreOut.textContent = String(score);
    }
    view.reveal(question.answer, choice);
    advance = window.setTimeout(() => {
      index++;
      if (index >= questions.length) finish();
      else ask();
    }, FEEDBACK_MS);
  }

  function ask(): void {
    const question: QuizQuestion = questions[index];
    answered = false;
    view.show(question, { n: index + 1, total: questions.length });
    view.setProgress(1);
    askedAt = Date.now();
    tick = window.setInterval(() => {
      const left = 1 - (Date.now() - askedAt) / perQuestionMs;
      view.setProgress(left);
      if (left <= 0) {
        window.clearInterval(tick);
        onAnswer(null);
      }
    }, 100);
  }

  /**
   * The name field the creator fills in before a room exists. The room screen
   * asks for a name too, but by then the room is already open and someone else
   * may have joined it first.
   */
  function makeRoomPanel(): HTMLElement {
    // Kept across retries, so a failed join never makes a second empty room.
    let roomCode: string | null = null;

    const nameInput = h('input', {
      type: 'text',
      id: 'host-name',
      placeholder: 'Your name',
      maxlength: '16',
      value: savedName(),
    });
    const make = h('button', {
      class: 'btn btn-primary btn-big',
      type: 'button',
      text: 'Make the room',
    });
    const trouble = h('div');

    const run = (): void => {
      const name = nameInput.value.trim();
      if (!name) {
        trouble.replaceChildren(
          notice('Type a name so your friend knows who they are racing.', 'error')
        );
        nameInput.focus();
        return;
      }
      saveName(name);
      trouble.replaceChildren();
      make.disabled = true;
      make.textContent = roomCode ? 'Joining...' : 'Making a room...';

      void (async () => {
        if (!roomCode) roomCode = await createRoom({ set, questions, perQuestionMs });
        const { playerId, memberKey } = await joinRoom(roomCode, name);
        writeMembership(roomCode, playerId, memberKey, name);
        navigate(`#/room/${roomCode}`);
      })().catch(() => {
        make.disabled = false;
        make.textContent = 'Try again';
        trouble.replaceChildren(
          notice(
            roomCode
              ? `Room ${roomCode} is open, but you did not get in. Try again.`
              : 'Could not open a room. Check the connection and try again.',
            'error'
          )
        );
      });
    };

    make.addEventListener('click', run);
    nameInput.addEventListener('keydown', (event) => {
      if ((event as KeyboardEvent).key === 'Enter') run();
    });

    return h('div', { class: 'panel' }, [
      h('p', {
        class: 'hint',
        text: 'You go in first, so you are the one who starts the race.',
      }),
      h('div', { class: 'field' }, [
        h('label', { for: 'host-name', text: 'What is your name?' }),
        nameInput,
      ]),
      make,
      trouble,
    ]);
  }

  function finish(): void {
    stopTimers();
    const best = questions.length * 200;
    const final = h('div', { class: 'final' }, [
      h('p', { class: 'score', text: String(score) }),
      h('p', { text: `out of ${best} points` }),
      h('p', {
        class: 'hint',
        text: set.level === 'kids' ? 'Nice work! Want to go again?' : 'Great job.',
      }),
    ]);

    const again = h('button', { class: 'btn btn-primary', type: 'button', text: 'Play again' });
    again.addEventListener('click', () => {
      questions = buildQuestions(set, {
        directions,
        seed: Math.floor(Math.random() * 2 ** 31),
      });
      index = 0;
      score = 0;
      scoreOut.textContent = '0';
      problem.replaceChildren();
      stage.replaceChildren(view.node);
      ask();
    });

    // Making the room and joining it are one step, on purpose. The server
    // makes whoever joins first the host, so if the creator only got a code
    // and typed a name afterwards, the friend who typed faster became the
    // host of a room they did not make. The creator joins here, before the
    // code is ever shown, and reaches the lobby already in the player list.
    const race = h('button', { class: 'btn', type: 'button', text: 'Race a friend' });
    const roomPanel = h('div');
    race.addEventListener('click', () => {
      race.disabled = true;
      roomPanel.replaceChildren(makeRoomPanel());
      roomPanel.querySelector('input')?.focus();
    });

    stage.replaceChildren(final, h('div', { class: 'row' }, [again, race]), roomPanel);
    celebrate(final, set.level);
  }

  body.append(
    h('div', { class: 'game-bar' }, [
      h('span', { class: 'stat' }, ['Score ', scoreOut]),
      pinyinToggle(() => {
        // Repaint the current question with or without pinyin (never mid-reveal).
        if (!answered && index < questions.length) {
          view.show(questions[index], { n: index + 1, total: questions.length });
        }
      }),
    ]),
    stage,
    problem,
    audioStatusLine()
  );

  stage.append(view.node);
  root.replaceChildren(page);
  ask();

  return stopTimers;
}

