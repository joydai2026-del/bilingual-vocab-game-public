import type { VocabItem, VocabSet, Direction, QuizQuestion, Level } from './types';
import { seededShuffle, hashSeed } from './rng';

/** Per-question timer, in ms, per the plan's level rules. */
export function perQuestionMsFor(level: Level): number {
  return level === 'kids' ? 12000 : 8000;
}

/**
 * Builds one QuizQuestion per item per requested direction, shuffled by seed.
 *
 * Per the plan (amendments after Codex round 1):
 * - distractors are drawn from unique labels only (never two choices with the
 *   same text), down to a minimum of 2 total choices when the set is small;
 * - an item whose English gloss duplicates another item's gloss is excluded
 *   from the en2zh direction only (the zh differs, but the en prompt would be
 *   ambiguous about which zh was meant).
 */
export function buildQuestions(
  set: VocabSet,
  opts: { directions?: Direction[]; seed?: number } = {}
): QuizQuestion[] {
  const directions = opts.directions ?? (['zh2en', 'en2zh'] as Direction[]);
  const seed = opts.seed ?? hashSeed(`${set.title}:${set.items.map((i) => i.id).join(',')}`);

  const glossCounts = new Map<string, number>();
  for (const item of set.items) {
    glossCounts.set(item.en, (glossCounts.get(item.en) ?? 0) + 1);
  }
  const hasUniqueGloss = (item: VocabItem): boolean => (glossCounts.get(item.en) ?? 0) === 1;

  const questions: QuizQuestion[] = [];
  let counter = 0;

  for (const dir of directions) {
    const eligibleItems = dir === 'en2zh' ? set.items.filter(hasUniqueGloss) : set.items;

    for (const item of eligibleItems) {
      const prompt = dir === 'zh2en' ? item.zh : item.en;
      const correctLabel = dir === 'zh2en' ? item.en : item.zh;

      const distractorPool = Array.from(
        new Set(
          set.items
            .filter((other) => other.id !== item.id)
            .map((other) => (dir === 'zh2en' ? other.en : other.zh))
        )
      ).filter((label) => label !== correctLabel);

      const shuffledPool = seededShuffle(distractorPool, seed + counter * 7919 + 1);
      const distractors = shuffledPool.slice(0, Math.min(3, shuffledPool.length));

      const rawChoices = [correctLabel, ...distractors];
      const order = seededShuffle(
        rawChoices.map((_, i) => i),
        seed + counter * 104729 + 2
      );
      const choices = order.map((i) => rawChoices[i]);
      const answer = order.indexOf(0);

      questions.push({ index: counter, dir, itemId: item.id, prompt, choices, answer });
      counter++;
    }
  }

  // Shuffle overall question order deterministically, then re-number `index`
  // to match final position (index is a display/answer-submission ordinal).
  return seededShuffle(questions, seed).map((q, i) => ({ ...q, index: i }));
}

/**
 * Score for one answered question. 0 if wrong; otherwise a base of 100 plus a
 * speed bonus up to 100 for answering instantly (linear falloff to 0 at the
 * per-question time limit or slower).
 */
export function scoreAnswer(correct: boolean, ms: number, perQuestionMs: number): number {
  if (!correct) return 0;
  const speedFraction = Math.max(0, 1 - ms / perQuestionMs);
  return 100 + Math.round(100 * speedFraction);
}

