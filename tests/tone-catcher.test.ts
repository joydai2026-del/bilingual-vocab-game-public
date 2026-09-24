// Tone Catcher's pure half: reading a tone off a pinyin string, building the
// minimal-pair lanes, and the gate reducer. Node environment, no DOM.
//
// `tone-catcher.ts` is importable here on purpose: its scene modules and its
// stylesheet are lazy imports, so nothing in this file drags three or a CSS
// file into the test run.

import { describe, expect, it } from 'vitest';

import {
  TONE_FILLERS,
  baseKey,
  buildToneQuestion,
  buildToneRound,
  isMinimalPair,
  playableToneCards,
  readableEasyLanes,
  toneOf,
  toneSequence,
  type ToneCard,
  sameSound as sameSoundExported,
} from '../src/shared/tone-pairs';
import {
  DEFAULT_SPEED,
  GAP_MS,
  GATE_MS,
  SPEED_MULTIPLIERS,
  SPEED_STOPS,
  STUMBLE_MS,
  MODES,
  easyLaneStyle,
  gatePoints,
  gateSchedule,
  gateSecondsLabel,
  moveTo,
  nudge,
  openGate,
  resolveGate,
  roundLength,
  scaledGateMs,
  scaledStumbleMs,
  speedBonus,
  speedIndex,
  speedRestartNeeded,
  speedName,
  speedValueText,
  startRound,
  toneCatcherDisabledReason,
} from '../src/client/games/tone-catcher';
import type { VocabSet } from '../src/shared/types';

/** The set JJ's harness pastes: a tone family plus four fruits. */
const MA: ToneCard[] = [
  { zh: '妈', pinyin: 'mā', en: 'mother' },
  { zh: '麻', pinyin: 'má', en: 'hemp' },
  { zh: '马', pinyin: 'mǎ', en: 'horse' },
  { zh: '骂', pinyin: 'mà', en: 'to scold' },
];

const FRUIT: ToneCard[] = [
  { zh: '苹果', pinyin: 'píng guǒ', en: 'apple' },
  { zh: '香蕉', pinyin: 'xiāng jiāo', en: 'banana' },
  { zh: '葡萄', pinyin: 'pú tao', en: 'grape' },
  { zh: '西瓜', pinyin: 'xī guā', en: 'watermelon' },
];

const MIXED = [...MA, ...FRUIT];

function asSet(items: ToneCard[]): VocabSet {
  return {
    v: 1,
    title: 'test',
    level: 'big',
    items: items.map((item, i) => ({ id: `i${i}`, ...item })),
  };
}

describe('reading tones off a pinyin string', () => {
  it('reads each of the four marked tones', () => {
    expect(toneOf('mā')).toBe(1);
    expect(toneOf('má')).toBe(2);
    expect(toneOf('mǎ')).toBe(3);
    expect(toneOf('mà')).toBe(4);
  });

  it('an unmarked syllable is the neutral tone, not a missing one', () => {
    expect(toneOf('ma')).toBe(5);
    expect(toneSequence('dòu dou')).toEqual([4, 5]);
  });

  it('reads a two-syllable word the same whether or not it is spaced', () => {
    expect(toneSequence('píng guǒ')).toEqual([2, 3]);
    expect(toneSequence('píngguǒ')).toEqual([2, 3]);
  });

  it('accepts numeric pinyin, because teachers paste it', () => {
    expect(toneOf('ma1')).toBe(1);
    expect(toneSequence('ping2 guo3')).toEqual([2, 3]);
  });

  it('keeps ü apart from u and accepts v and u: for it', () => {
    expect(baseKey('lǜ')).toBe('lü');
    expect(baseKey('lv')).toBe('lü');
    expect(baseKey('lu:')).toBe('lü');
    expect(baseKey('lù')).toBe('lu');
    expect(toneOf('lǜ')).toBe(4);
  });

  it('strips tone and spacing to the same key', () => {
    expect(new Set(MA.map((card) => baseKey(card.pinyin))).size).toBe(1);
    expect(baseKey('píng guǒ')).toBe('pingguo');
    expect(baseKey('píngguǒ')).toBe('pingguo');
  });
});

describe('minimal pairs', () => {
  it('same syllable, different tone is a pair', () => {
    expect(isMinimalPair('mā', 'mà')).toBe(true);
    expect(isMinimalPair('mā', 'má')).toBe(true);
  });

  it('a different syllable is not a pair, however close it sounds', () => {
    expect(isMinimalPair('mā', 'bā')).toBe(false);
    expect(isMinimalPair('mā', 'māo')).toBe(false);
  });

  it('the same word is not its own pair', () => {
    expect(isMinimalPair('mā', 'mā')).toBe(false);
  });

  it('a different syllable count is not a pair', () => {
    expect(isMinimalPair('mā', 'mā ma')).toBe(false);
  });

  it('polyphones: the tone comes from the card, never from the character', () => {
    // 重 is chóng in 重复 and zhòng in 重要. Nothing here looks the reading up,
    // so both survive and they are NOT treated as a tone pair of each other.
    const chong: ToneCard = { zh: '重', pinyin: 'chóng', en: 'again' };
    const zhong: ToneCard = { zh: '重', pinyin: 'zhòng', en: 'heavy' };
    expect(toneSequence(chong.pinyin)).toEqual([2]);
    expect(toneSequence(zhong.pinyin)).toEqual([4]);
    expect(isMinimalPair(chong.pinyin, zhong.pinyin)).toBe(false);
  });

  it('polyphones: two cards with the same character keep their own readings', () => {
    const chong: ToneCard = { zh: '重', pinyin: 'chóng', en: 'again' };
    const chong4: ToneCard = { zh: '重', pinyin: 'chòng', en: 'facing' };
    // Same characters, so they may never share a gate (the label would be
    // identical), even though they ARE a tone pair.
    expect(isMinimalPair(chong.pinyin, chong4.pinyin)).toBe(true);
    const question = buildToneQuestion(chong, [chong, chong4, ...FRUIT], { seed: 5 });
    expect(question.options.filter((option) => option.zh === '重')).toHaveLength(1);
  });
});

describe('building the three lanes', () => {
  it('uses a real pair from the set when the set has one', () => {
    const question = buildToneQuestion(MA[0], MIXED, { seed: 3 });
    const distractors = question.options.filter((option) => option.kind !== 'answer');
    expect(distractors).toHaveLength(2);
    expect(distractors.every((option) => option.kind === 'set-pair')).toBe(true);
    expect(distractors.every((option) => baseKey(option.pinyin) === 'ma')).toBe(true);
  });

  it('falls back to the filler list when the set has no pair for that word', () => {
    const cat: ToneCard = { zh: '猫', pinyin: 'māo', en: 'a cat' };
    const question = buildToneQuestion(cat, FRUIT, { seed: 11 });
    const kinds = question.options.filter((o) => o.kind !== 'answer').map((o) => o.kind);
    expect(kinds).toContain('filler-pair');
    const pair = question.options.find((o) => o.kind === 'filler-pair')!;
    expect(baseKey(pair.pinyin)).toBe('mao');
  });

  it('falls back to near neighbours when nothing anywhere is a pair', () => {
    const question = buildToneQuestion(FRUIT[0], FRUIT, { seed: 7 });
    const distractors = question.options.filter((o) => o.kind !== 'answer');
    expect(distractors).toHaveLength(2);
    expect(distractors.every((o) => o.kind === 'near' || o.kind === 'filler-near')).toBe(true);
  });

  it('always has three lanes with the answer in exactly one of them', () => {
    for (const card of MIXED) {
      const question = buildToneQuestion(card, MIXED, { seed: 42 });
      expect(question.options).toHaveLength(3);
      expect(question.options[question.correct].zh).toBe(card.zh);
      expect(question.options.filter((o) => o.kind === 'answer')).toHaveLength(1);
    }
  });

  it('no two lanes can ever show the same label, in any mode', () => {
    for (let seed = 0; seed < 40; seed += 1) {
      for (const card of MIXED) {
        const { options } = buildToneQuestion(card, MIXED, { seed });
        expect(new Set(options.map((o) => o.zh)).size).toBe(3);
        expect(new Set(options.map((o) => o.pinyin)).size).toBe(3);
        expect(new Set(options.map((o) => o.en)).size).toBe(3);
      }
    }
  });

  it('is deterministic: the same seed gives the same lanes in the same order', () => {
    const a = buildToneQuestion(MA[2], MIXED, { seed: 99 });
    const b = buildToneQuestion(MA[2], MIXED, { seed: 99 });
    expect(a.options.map((o) => o.zh)).toEqual(b.options.map((o) => o.zh));
    expect(a.correct).toBe(b.correct);
  });

  it('carries the tone numbers the contour drawer needs', () => {
    const question = buildToneQuestion(FRUIT[0], MIXED, { seed: 1 });
    expect(question.tones).toEqual([2, 3]);
    expect(question.options.every((o) => o.tones.length >= 1)).toBe(true);
  });

  it('tops a two-word set up from the fillers rather than dropping a lane', () => {
    const tiny = FRUIT.slice(0, 2);
    const question = buildToneQuestion(tiny[0], tiny, { seed: 4 });
    expect(question.options).toHaveLength(3);
  });

  it('every filler gloss is distinct, so Easy mode can label with glosses', () => {
    expect(new Set(TONE_FILLERS.map((c) => c.en)).size).toBe(TONE_FILLERS.length);
    expect(new Set(TONE_FILLERS.map((c) => c.zh)).size).toBe(TONE_FILLERS.length);
  });
});

describe('the round', () => {
  it('is the set length when the set is shorter than twelve', () => {
    expect(buildToneRound(MIXED, { seed: 1 })).toHaveLength(8);
  });

  it('caps at twelve however long the set is', () => {
    const long = Array.from({ length: 30 }, (_, i) => ({
      zh: `字${i}`,
      pinyin: 'zì',
      en: `word ${i}`,
    }));
    expect(buildToneRound(long, { seed: 1 })).toHaveLength(12);
  });

  it('skips cards that cannot be spoken, labelled or read', () => {
    const messy: ToneCard[] = [
      ...MA,
      { zh: '', pinyin: 'kōng', en: 'empty zh' },
      { zh: '无', pinyin: '', en: 'no pinyin' },
      { zh: '未', pinyin: 'wèi', en: '' },
    ];
    expect(playableToneCards(messy)).toHaveLength(4);
    expect(buildToneRound(messy, { seed: 1 })).toHaveLength(4);
  });

  it('says why it cannot be played rather than showing a dead button', () => {
    expect(toneCatcherDisabledReason(asSet(MIXED))).toBeUndefined();
    const reason = toneCatcherDisabledReason(asSet(MA.slice(0, 2)));
    expect(reason).toMatch(/at least three words/);
    expect(reason).toMatch(/has 2\./);
  });
});

describe('gate timing and scoring', () => {
  it('gates arrive slower on Easy and faster on Hard', () => {
    expect(GATE_MS.easy).toBe(6000);
    expect(GATE_MS.normal).toBe(4000);
    expect(GATE_MS.hard).toBe(3000);
  });

  it('schedules one gate per word, evenly spaced at the SPEED the dial is on', () => {
    // The default is Quick, so a Normal gate is 2000 ms and not 4000 ms.
    const step = scaledGateMs('normal', DEFAULT_SPEED);
    expect(step).toBe(2000);
    const plan = gateSchedule(step, 4);
    expect(plan).toHaveLength(4);
    expect(plan[0]).toBe(0);
    expect(plan[1] - plan[0]).toBe(step + GAP_MS);
    expect(plan[3]).toBe(3 * (step + GAP_MS));
    // Chill is the old, unscaled schedule.
    expect(gateSchedule(scaledGateMs('normal', 0), 2)[1]).toBe(GATE_MS.normal + GAP_MS);
  });

  it('rounds are capped at twelve and never negative', () => {
    expect(roundLength(8)).toBe(8);
    expect(roundLength(40)).toBe(12);
    expect(roundLength(-3)).toBe(0);
  });

  it('the speed bonus runs from four for instant to nothing at the buzzer', () => {
    expect(speedBonus(0, 4000)).toBe(4);
    expect(speedBonus(2000, 4000)).toBe(2);
    expect(speedBonus(4000, 4000)).toBe(0);
    expect(speedBonus(9999, 4000)).toBe(0);
  });

  it('standing still and being right scores the point but no bonus', () => {
    expect(speedBonus(null, 4000)).toBe(0);
    expect(gatePoints(true, null, 4000)).toBe(1);
  });

  it('a wrong lane scores nothing however fast it was', () => {
    expect(gatePoints(false, 0, 4000)).toBe(0);
  });

  it('the hint says "1 second", never "1 seconds"', () => {
    expect(gateSecondsLabel(scaledGateMs('hard', 4))).toBe('1 second');
    expect(gateSecondsLabel(scaledGateMs('normal', 4))).toBe('1.3 seconds');
    expect(gateSecondsLabel(scaledGateMs('hard', 3))).toBe('1.2 seconds');
    expect(gateSecondsLabel(scaledGateMs('easy', 0))).toBe('6 seconds');
    // Every reachable pairing reads as English.
    for (const mode of MODES) {
      for (let stop = 0; stop < SPEED_STOPS.length; stop += 1) {
        expect(gateSecondsLabel(scaledGateMs(mode, stop))).toMatch(/^\d+(\.\d)? seconds?$/);
      }
    }
  });
});

describe('the speed dial', () => {
  it('has the five stops in order, slowest first', () => {
    expect([...SPEED_STOPS]).toEqual(['Chill', 'Steady', 'Quick', 'Fast', 'Turbo']);
    expect([...SPEED_MULTIPLIERS]).toEqual([1, 1.5, 2, 2.5, 3]);
    expect(SPEED_STOPS).toHaveLength(SPEED_MULTIPLIERS.length);
  });

  it('starts on Quick, twice the old tempo', () => {
    expect(DEFAULT_SPEED).toBe(2);
    expect(speedName(undefined)).toBe('Quick');
    expect(SPEED_MULTIPLIERS[DEFAULT_SPEED]).toBe(2);
  });

  it('reads a stored stop back', () => {
    expect(speedIndex('0')).toBe(0);
    expect(speedIndex('4')).toBe(4);
    expect(speedIndex(1)).toBe(1);
    expect(speedName('4')).toBe('Turbo');
    expect(speedValueText('4')).toBe('Turbo, 3 times speed');
    expect(speedValueText(undefined)).toBe('Quick, 2 times speed');
  });

  it('anything that is not one of the five falls back to the default', () => {
    for (const junk of [null, undefined, '', '   ', 'Turbo', '9', '-1', '1.5', 'NaN', {}, []]) {
      expect(speedIndex(junk)).toBe(DEFAULT_SPEED);
    }
  });

  it("restarts only when the committed stop is not the round's own stop", () => {
    // The rule the whole gesture path exists for: a drag or a key burst that
    // wanders and comes home must NOT throw the child's round away, and any
    // other landing must.
    for (let stop = 0; stop < SPEED_STOPS.length; stop += 1) {
      expect(speedRestartNeeded(stop, stop)).toBe(false);
    }
    expect(speedRestartNeeded(0, 3)).toBe(true);
    expect(speedRestartNeeded(3, 0)).toBe(true);
    expect(speedRestartNeeded(DEFAULT_SPEED, DEFAULT_SPEED + 1)).toBe(true);
  });

  it('divides the gate time by the multiplier, per difficulty', () => {
    expect(scaledGateMs('normal', 0)).toBe(4000);
    expect(scaledGateMs('normal', 2)).toBe(2000);
    expect(scaledGateMs('normal', 4)).toBeCloseTo(4000 / 3, 6);
    expect(scaledGateMs('easy', 4)).toBe(2000);
    expect(scaledGateMs('hard', 0)).toBe(3000);
    expect(scaledGateMs('hard', 4)).toBe(1000);
  });

  it('a junk stop still gives a real duration, never NaN', () => {
    expect(scaledGateMs('normal', 'wat')).toBe(2000);
    expect(Number.isFinite(scaledGateMs('easy', null))).toBe(true);
  });

  it('Turbo really is faster than Chill at every difficulty', () => {
    for (const mode of ['easy', 'normal', 'hard'] as const) {
      expect(scaledGateMs(mode, 4)).toBeLessThan(scaledGateMs(mode, 0));
    }
  });

  it('the bonus still rewards an early commit at the scaled time', () => {
    const turbo = scaledGateMs('normal', 4);
    expect(speedBonus(0, turbo)).toBe(4);
    expect(speedBonus(turbo / 2, turbo)).toBe(2);
    expect(speedBonus(turbo, turbo)).toBe(0);
    // The same wall-clock hesitation is worth less once the gate is quicker.
    expect(speedBonus(1000, turbo)).toBeLessThan(speedBonus(1000, scaledGateMs('normal', 0)));
  });
});

describe('the gate reducer', () => {
  it('a hit adds the point, the bonus and the streak', () => {
    let state = startRound(3, 1000);
    state = moveTo(state, 2, 1000); // instant decision
    state = resolveGate(state, 2, 1400, 4000);
    expect(state.correct).toBe(1);
    expect(state.score).toBe(5); // 1 + a full speed bonus
    expect(state.streak).toBe(1);
    expect(state.bestStreak).toBe(1);
    expect(state.last).toBe('hit');
    expect(state.done).toBe(false);
  });

  it('a miss zeroes the streak and slows the runner for 1.5 s', () => {
    let state = startRound(3, 0);
    state = moveTo(state, 0, 100);
    state = resolveGate(state, 2, 4000, 4000);
    expect(state.correct).toBe(0);
    expect(state.score).toBe(0);
    expect(state.streak).toBe(0);
    expect(state.slowUntil).toBe(4000 + STUMBLE_MS);
    expect(state.last).toBe('miss');
  });

  it('the best streak survives a miss', () => {
    let state = startRound(4, 0);
    state = moveTo(state, 1, 0);
    state = resolveGate(state, 1, 500, 4000);
    state = openGate(state, 600);
    state = moveTo(state, 1, 600);
    state = resolveGate(state, 1, 1100, 4000);
    expect(state.bestStreak).toBe(2);
    state = openGate(state, 3000);
    state = resolveGate(state, 0, 3500, 4000);
    expect(state.streak).toBe(0);
    expect(state.bestStreak).toBe(2);
  });

  it('the stumble freeze rides the same divisor as the gate', () => {
    expect(scaledStumbleMs(0)).toBe(STUMBLE_MS);
    expect(scaledStumbleMs(4)).toBe(STUMBLE_MS / 3);
    expect(scaledStumbleMs('nonsense')).toBe(STUMBLE_MS / 2); // the Quick default

    let state = startRound(3, 0);
    state = moveTo(state, 0, 100);
    state = resolveGate(state, 2, 1000, scaledGateMs('hard', 4), scaledStumbleMs(4));
    expect(state.slowUntil).toBe(1500); // 1000 + 500, not 1000 + 1500
  });

  it('every difficulty and every stop leaves a usable window in the next gate', () => {
    // The freeze starts when a gate resolves; the next gate opens GAP_MS later
    // and runs for one scaled gate. If the freeze outlasts both, the gate after
    // a miss is unanswerable, which is the bug this pins down.
    for (const mode of MODES) {
      for (let stop = 0; stop < SPEED_STOPS.length; stop += 1) {
        const freeze = scaledStumbleMs(stop);
        const window = GAP_MS + scaledGateMs(mode, stop);
        expect(
          freeze,
          `${mode} at ${SPEED_STOPS[stop]}: freeze ${freeze}ms vs window ${window}ms`
        ).toBeLessThan(window);
      }
    }
  });

  it('the slow really freezes the lane, then lets go', () => {
    let state = startRound(3, 0);
    state = resolveGate(state, 2, 1000, 4000); // a miss: lane 1 vs 2
    expect(state.slowUntil).toBe(2500);
    const frozen = moveTo(state, 0, 2000);
    expect(frozen.lane).toBe(1);
    const free = moveTo(state, 0, 2600);
    expect(free.lane).toBe(0);
  });

  it('arrow keys move one lane and stop at the edges', () => {
    let state = startRound(3, 0);
    expect(nudge(state, -1, 10).lane).toBe(0);
    state = nudge(state, -1, 10);
    expect(nudge(state, -1, 20).lane).toBe(0);
    expect(nudge(state, 1, 30).lane).toBe(1);
  });

  it('staying in the lane you are already in is not a decision', () => {
    const state = startRound(3, 0);
    expect(moveTo(state, 1, 500)).toBe(state);
    expect(moveTo(state, 1, 500).decidedAt).toBeNull();
  });

  it('a lane that does not exist is ignored', () => {
    const state = startRound(3, 0);
    expect(moveTo(state, 7, 100)).toBe(state);
    expect(moveTo(state, -1, 100)).toBe(state);
  });

  it('the round ends on the last gate and stops accepting answers', () => {
    let state = startRound(2, 0);
    state = resolveGate(state, 1, 100, 4000);
    expect(state.done).toBe(false);
    state = openGate(state, 200);
    state = resolveGate(state, 1, 300, 4000);
    expect(state.done).toBe(true);
    expect(state.gate).toBe(2);
    const after = resolveGate(state, 1, 400, 4000);
    expect(after).toBe(state);
    expect(moveTo(state, 0, 500)).toBe(state);
  });
});

// --- panel round 1, M1: two lanes that sound the same ------------------------
//
// `collides()` used to compare the raw pinyin STRING, so two cards written
// differently but pronounced identically (ta1 next to tā, or píng guǒ next to
// píngguǒ) could take two lanes in the same question. In Hard mode the lane
// label IS the pinyin, so a child hears the word, sees the same word twice, and
// has a 50% chance of being marked wrong for a phonetically correct pick.

/** Two labels a learner cannot tell apart by ear: same syllables, same tones. */
const sameSound = (a: string, b: string): boolean => sameSoundExported(a, b);

function soundClashes(question: { options: readonly { pinyin: string }[] }): number {
  let clashes = 0;
  for (let i = 0; i < question.options.length; i++) {
    for (let j = i + 1; j < question.options.length; j++) {
      if (sameSound(question.options[i].pinyin, question.options[j].pinyin)) clashes++;
    }
  }
  return clashes;
}

describe('lanes never repeat a sound', () => {
  it('a neutral-tone syllable (dōngxi next to dōng xi) is one sound, not two lanes', () => {
    // Panel round 2: a neutral syllable carries no mark, so the tone lists came
    // out [1,5] vs [1] and the two spellings passed as different sounds.
    expect(sameSoundExported('dōngxi', 'dōng xi')).toBe(true);
    expect(sameSoundExported('māma', 'mā ma')).toBe(true);
    expect(sameSoundExported('mā', 'mǎ')).toBe(false);
    const pool: ToneCard[] = [
      { zh: '东西', pinyin: 'dōngxi', en: 'thing' },
      { zh: '東西', pinyin: 'dōng xi', en: 'thing' },
      { zh: '猫', pinyin: 'māo', en: 'cat' },
    ];
    let clashes = 0;
    for (let seed = 1; seed <= 40; seed++) {
      clashes += soundClashes(buildToneQuestion(pool[0], pool, { lanes: 3, seed }));
    }
    expect(clashes).toBe(0);
  });
  it('mixed notation (ta1 next to tā) never lands in two lanes at once', () => {
    const pool: ToneCard[] = [
      { zh: '他', pinyin: 'ta1', en: 'he' },
      { zh: '她', pinyin: 'tā', en: 'she' },
      { zh: '猫', pinyin: 'māo', en: 'cat' },
    ];
    let clashes = 0;
    for (let seed = 1; seed <= 60; seed++) {
      clashes += soundClashes(buildToneQuestion(pool[1], pool, { lanes: 3, seed }));
    }
    expect(clashes).toBe(0);
  });

  it('spacing style alone (píng guǒ next to píngguǒ) does not do it either', () => {
    const pool: ToneCard[] = [
      { zh: '苹果', pinyin: 'píng guǒ', en: 'apple' },
      { zh: '蘋果', pinyin: 'píngguǒ', en: 'apple fruit' },
      { zh: '香蕉', pinyin: 'xiāng jiāo', en: 'banana' },
    ];
    let clashes = 0;
    for (let seed = 1; seed <= 60; seed++) {
      clashes += soundClashes(buildToneQuestion(pool[0], pool, { lanes: 3, seed }));
    }
    expect(clashes).toBe(0);
  });

  it('still fills three lanes when the whole set is one word written two ways', () => {
    const pool: ToneCard[] = [
      { zh: '他', pinyin: 'ta1', en: 'he' },
      { zh: '她', pinyin: 'tā', en: 'she' },
    ];
    for (let seed = 1; seed <= 60; seed++) {
      const q = buildToneQuestion(pool[0], pool, { lanes: 3, seed });
      expect(q.options).toHaveLength(3);
      expect(q.options[q.correct].zh).toBe('他');
      expect(soundClashes(q)).toBe(0);
    }
  });
});

// ROUND 1 REVIEW, must-fix 5. A Chinese-taught teacher's set carries Chinese
// definitions as its meanings. Easy mode puts the meaning on the gate, and the
// filler list carries CEDICT English, so the one Chinese lane WAS the answer
// and the game gave itself away on every round.
describe('a set whose meanings are Chinese sentences', () => {
  const ZH_MEANINGS: ToneCard[] = [
    { zh: '科技创新', pinyin: 'kē jì chuàng xīn', en: '用新的科学和技术创造新的东西。' },
    { zh: '人工智能', pinyin: 'rén gōng zhì néng', en: '让机器像人一样学习和工作。' },
    { zh: '就业', pinyin: 'jiù yè', en: '找到工作。' },
    { zh: '失业', pinyin: 'shī yè', en: '没有工作，失去工作。' },
    { zh: '市场', pinyin: 'shì chǎng', en: '买东西和卖东西的地方。' },
  ];
  const cjk = (s: string): boolean => /[㐀-䶿一-鿿]/.test(s);

  it('never puts an English filler next to a Chinese answer', () => {
    for (let seed = 1; seed <= 60; seed++) {
      for (const answer of ZH_MEANINGS) {
        const q = buildToneQuestion(answer, ZH_MEANINGS, { lanes: 3, seed });
        expect(q.options).toHaveLength(3);
        // Either every lane reads as Chinese, or the caller is told the
        // meanings cannot be shown at all. A mixed round is the bug.
        expect(q.options.every((o) => cjk(o.en)) || !readableEasyLanes(q)).toBe(true);
      }
    }
  });

  it('falls back to a readable label when the meanings do not all match', () => {
    const two = ZH_MEANINGS.slice(0, 2);
    const q = buildToneQuestion(two[0], two, { lanes: 3, seed: 5 });
    // Only one other Chinese meaning exists, so a filler had to fill lane 3.
    expect(q.options.filter((o) => cjk(o.en))).toHaveLength(2);
    expect(readableEasyLanes(q)).toBe(false);
  });

  it('leaves an ordinary English set alone', () => {
    const q = buildToneQuestion(FRUIT[0], FRUIT, { lanes: 3, seed: 7 });
    expect(readableEasyLanes(q)).toBe(true);
  });
});

describe('how easy mode labels a gate on this set', () => {
  // Fixture 78's own rows: a Chinese term over a Chinese definition, short
  // entries included. 找到工作。 is five characters and is NOT a sentence by
  // itself, which is why the decision is a majority rather than all of them.
  const ZH_SET: ToneCard[] = [
    { zh: '科技创新', pinyin: 'kē jì chuàng xīn', en: '用新的科学和技术创造新的东西。' },
    { zh: '人工智能', pinyin: 'rén gōng zhì néng', en: '让机器像人一样学习、思考和工作。' },
    { zh: '语音识别', pinyin: 'yǔ yīn shí bié', en: '电脑听懂人说的话。' },
    { zh: '就业', pinyin: 'jiù yè', en: '找到工作。' },
    { zh: '失业', pinyin: 'shī yè', en: '没有工作，失去工作' },
  ];

  it('numbers the lanes for a set of Chinese definitions', () => {
    expect(easyLaneStyle(ZH_SET)).toBe('number');
  });

  it('keeps the meanings on the gates for an ordinary word set', () => {
    expect(easyLaneStyle(FRUIT)).toBe('text');
    expect(easyLaneStyle(MA)).toBe('text');
  });

  it('keeps them for a set of short Chinese glosses, which still fit', () => {
    expect(
      easyLaneStyle([
        { zh: '苹果', pinyin: 'píng guǒ', en: '水果' },
        { zh: '书', pinyin: 'shū', en: '书本' },
      ])
    ).toBe('text');
  });

  it('takes a majority, so one Chinese definition does not flip a word set', () => {
    expect(easyLaneStyle([...FRUIT, ZH_SET[0]])).toBe('text');
  });

  it('ignores blank meanings, and a set with none at all stays on text', () => {
    expect(easyLaneStyle([])).toBe('text');
    expect(easyLaneStyle([{ zh: '苹果', pinyin: 'píng guǒ', en: '   ' }])).toBe('text');
    expect(easyLaneStyle([ZH_SET[0], { zh: '语音识别', pinyin: 'yǔ yīn shí bié', en: '' }])).toBe(
      'number'
    );
  });
});

