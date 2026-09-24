// The seeded CPU beans the solo games play against.
//
// Per the week-2 amendments, this checks determinism and bounds only: no
// distribution tests (they are slow, flaky, and prove nothing a teacher cares
// about).

import { describe, it, expect } from 'vitest';
import { cpuMoveMs, cpuPlan } from '../src/shared/cpu';

const PER_QUESTION_MS = 8000;

describe('cpuPlan', () => {
  it('is byte-identical across runs for the same seed', () => {
    const a = cpuPlan('bean-1', 20, 'normal');
    const b = cpuPlan('bean-1', 20, 'normal');
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('gives each bean, and each pace, its own plan', () => {
    const one = cpuPlan('bean-1', 20, 'normal');
    expect(cpuPlan('bean-2', 20, 'normal')).not.toEqual(one);
    expect(cpuPlan('bean-1', 20, 'fast')).not.toEqual(one);
  });

  it('produces one move per question, numbered in order', () => {
    const plan = cpuPlan('bean-1', 12, 'easy');
    expect(plan).toHaveLength(12);
    expect(plan.map((m) => m.index)).toEqual([...Array(12).keys()]);
  });

  it('never answers instantly and never answers outside the window', () => {
    for (const pace of ['easy', 'normal', 'fast'] as const) {
      for (const move of cpuPlan(`bean-${pace}`, 50, pace)) {
        expect(move.ms).toBeGreaterThanOrEqual(0.05);
        expect(move.ms).toBeLessThanOrEqual(0.95);
        const ms = cpuMoveMs(move, PER_QUESTION_MS);
        expect(ms).toBeGreaterThan(0);
        expect(ms).toBeLessThan(PER_QUESTION_MS);
      }
    }
  });

  it('always picks a real chest', () => {
    for (const move of cpuPlan('bean-1', 60, 'normal')) {
      expect([0, 1, 2]).toContain(move.chest);
    }
  });

  it('gets more right the faster the pace', () => {
    const count = (pace: 'easy' | 'normal' | 'fast') =>
      cpuPlan('bean-shared', 400, pace).filter((m) => m.correct).length;
    expect(count('fast')).toBeGreaterThan(count('normal'));
    expect(count('normal')).toBeGreaterThan(count('easy'));
  });
});

