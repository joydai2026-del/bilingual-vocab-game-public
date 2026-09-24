import { describe, expect, it } from 'vitest';
import { parseLine, pickGloss } from '../src/shared/cedict';

const gloss = (line: string) => pickGloss(parseLine(line)!.senses);

describe('card-friendly gloss choice', () => {
  it('prefers the short everyday sense over a verb form', () => {
    expect(gloss('謝謝 谢谢 [xie4 xie5] /to thank/thanks/thank you/')).toBe('thanks');
  });
  it('prefers a short sense over a long first one', () => {
    expect(gloss('還有 还有 [hai2 you3] /there still remain(s); there is (or are) still/in addition/')).toBe('in addition');
  });
  it('keeps a verb when no short non-verb sense exists', () => {
    expect(gloss('跑步 跑步 [pao3 bu4] /to run/to jog/(military) to march at the double/')).toBe('to run');
    expect(gloss('喜歡 喜欢 [xi3 huan5] /to like; to be fond of/')).toBe('to like');
  });
  it('keeps plain first senses', () => {
    expect(gloss('高興 高兴 [gao1 xing4] /happy/glad/willing (to do sth)/')).toBe('happy');
    expect(gloss('什麼 什么 [shen2 me5] /what?/something; anything/')).toBe('what');
    expect(gloss('老師 老师 [lao3 shi1] /teacher/')).toBe('teacher');
  });
});

