// The words the free-text extractor throws away.
//
// WHY THIS FILE EXISTS
// A teacher who pastes `今天我们学习水果。苹果很好吃。` wants 水果 and 苹果 on the
// game cards, not 今天, 我们, 学习 or 的. Nothing in CC-CEDICT says which of its
// 125k headwords is a classroom vocabulary word and which is grammar, so the
// judgement has to be written down somewhere. It is written down here, as data,
// so it can be edited without touching the extractor.
//
// WHERE IT APPLIES
// ONLY on the free-text path (src/shared/extract.ts): a word the segmenter found
// inside a chunk, or a lone word the teacher separated with punctuation. It is
// NEVER applied to a row the teacher wrote as a pair (`的 possessive particle`),
// because a teacher who typed the gloss herself meant it, and a grammar-point
// list is a real thing to want.
//
// THE ONE RULE THAT DECIDES EVERYTHING: IS THIS PROSE OR A LIST?
// In PROSE the grammar words are the glue between the teacher's real words, so
// they go. On a BARE LIST every word she separated is a word she chose, so it
// stays. JJ set that on 2026-09-08, after `你好谢谢再见什么为什么还有` came back
// with half of it missing.
//
// THE TIERS
//   SINGLE  one-character function words. Deliberately tight. Single characters
//           that the segmenter produced from inside a longer chunk are dropped
//           anyway, so this tier only decides what happens to a character the
//           teacher listed on its own line or between separators. A teacher who
//           writes `去` alone wants 去, so verbs and nouns stay out of it.
//   PHRASE  multi-character function words, pronouns and demonstratives.
//   PAPERWORK  the words a teacher writes AROUND her list. These are NOT all
//           the same kind of word, so they are kept in two lists:
//
//     STRUCTURAL  never a vocabulary word, whatever the paste looks like: the
//             list headers (生词, 单词, 词语), the instruction word 请, the ways
//             of pointing at a list (如下, 以下, 如上), 同学们, and the sign-offs
//             a WeChat message ends with (谢谢老师, 老师好). The sign-offs are
//             matched as a WHOLE RUN and nothing else, so that a bare `谢谢`
//             inside a beginner's word list is still her word (fixture 40).
//     ORDINARY  a real CC-CEDICT word a teacher could well be teaching: 学习,
//             练习, 复习, 作业, 课文, 今天, 下周, 注意, 记得, 完成. In PROSE it is
//             the sentence around the list and it goes. On a BARE LIST it is a
//             card like any other word she separated, UNLESS this particular
//             occurrence is being used as a marker: a colon straight after it
//             (`作业：`) or 请 straight in front of it (`请复习`). That is the
//             round-2d fix. `学习 练习 复习 考试 作业 上课` used to come back
//             holding two of its six words, and fixture 47 silently lost 学习.
//
// KNOWN JUDGEMENT CALLS, listed so a future edit is a decision and not a
// surprise: 今天, 学习 and 练习 are real words that some teachers do teach. They
// are ORDINARY, so a bare list keeps them and only prose drops them.

/** One-character function words. See the SINGLE tier note above. */
export const STOPWORD_SINGLE: readonly string[] = [
  // structural particles and aspect markers
  '的', '地', '得', '了', '着', '过', '们',
  // sentence-final and interjection particles
  '吗', '呢', '吧', '呀', '啊', '嘛', '啦', '哦', '嗯', '哈',
  // pronouns and demonstratives
  '我', '你', '您', '他', '她', '它', '这', '那', '谁', '哪',
  // the copula, the existentials, the negations
  '是', '有', '在', '不', '没', '无',
  // the highest-frequency adverbs and conjunctions
  '也', '很', '都', '就', '还', '再', '又', '只', '才', '更', '太', '最',
  '和', '或', '但', '而', '且', '并', '则', '与', '及', '因', '所',
  // coverbs, prepositions and classical leftovers
  '把', '被', '于', '以', '为', '由', '从', '向', '之', '其', '者', '等', '些',
  // numeral one and the general classifier, which pair up in front of a noun
  '一', '个',
  // classroom instruction
  '请',
];

/** Multi-character function words and classroom instruction. See above. */
export const STOPWORD_PHRASE: readonly string[] = [
  // pronouns
  '我们', '你们', '您们', '他们', '她们', '它们', '咱们', '自己', '大家',
  // demonstratives and question words
  '这个', '那个', '这些', '那些', '这里', '那里', '这儿', '那儿',
  '什么', '怎么', '怎样', '为什么', '哪里', '哪儿', '哪个', '多少',
  '这样', '那样', '这种', '那种',
  // quantifiers that ride in front of a noun
  '一个', '一些', '一点', '一下', '一起', '一样', '一直', '一定',
  // high-frequency verb and adverb phrases that are grammar, not vocabulary
  '不是', '没有', '可以', '能够', '应该', '需要', '已经', '正在',
  '因为', '所以', '但是', '可是', '然后', '还有', '而且', '如果',
  '很好', '非常', '真的', '一般', '比较',
  // the sentence a teacher writes AROUND the list
  '今天', '这周', '本周', '下周', '上周', '生词', '生字', '单词', '詞語', '词语',
  '学习', '練習', '练习', '复习', '複習', '作业', '作業', '課文', '课文',
  '同学们', '注意', '记得', '完成', '如下', '以下', '如上',
];

/**
 * Paperwork that is NEVER a vocabulary word: the list headers, the instruction
 * word 请, the ways of pointing at a list, and the way a teacher addresses her
 * class. Dropped in every mode, declared or not, because nobody lists 生词 as
 * vocabulary.
 */
export const STRUCTURAL_PAPERWORK: readonly string[] = [
  '请', '生词', '生字', '单词', '詞語', '词语',
  '同学们', '如下', '以下', '如上',
];

/**
 * Paperwork that is ALSO an ordinary word a teacher could be teaching. Dropped
 * in PROSE (`今天我们学习水果` is not teaching 学习); kept on a BARE LIST
 * (`学习 练习 复习 考试 作业 上课` is a whole unit on school words), unless this
 * occurrence is being used as a marker. See isStopword.
 */
export const ORDINARY_PAPERWORK: readonly string[] = [
  '今天', '这周', '本周', '下周', '上周',
  '学习', '練習', '练习', '复习', '複習', '作业', '作業', '課文', '课文',
  '注意', '记得', '完成',
];

/** Both kinds together. What isPaperwork answers about. */
export const STOPWORD_PAPERWORK: readonly string[] = [
  ...STRUCTURAL_PAPERWORK,
  ...ORDINARY_PAPERWORK,
];

/**
 * Sign-offs, matched against a WHOLE RUN of Chinese and nothing else. `谢谢`
 * on its own is a beginner's first vocabulary word (fixture 40), while
 * `谢谢老师` on the end of a WeChat message is how she said goodbye. 老师 stays
 * teachable: it is a card whenever she wrote it as a word of its own.
 */
const SIGN_OFF_RUN = new Set<string>(['谢谢老师', '谢谢老師', '老师好', '老師好']);

/**
 * True when this ENTIRE run of Chinese is a sign-off rather than vocabulary.
 * The caller must pass a whole run, never a piece cut out of one by the
 * segmenter, or a word list that happens to contain 谢谢 loses it.
 */
export function isSignOffRun(zh: string): boolean {
  return SIGN_OFF_RUN.has(zh);
}

/** Every stopword, as a set. */
const STOPWORDS = new Set<string>([...STOPWORD_SINGLE, ...STOPWORD_PHRASE]);
const STRUCTURAL = new Set<string>(STRUCTURAL_PAPERWORK);
const ORDINARY = new Set<string>(ORDINARY_PAPERWORK);

/**
 * True when this word is one of the words a teacher writes AROUND her list
 * rather than on it. The caller needs this to decide whether a word in front
 * of a colon is a declaration or a label. See isDeclaredHeadword.
 */
export function isPaperwork(zh: string): boolean {
  return STRUCTURAL.has(zh) || ORDINARY.has(zh);
}

/**
 * True when this word is paperwork of the kind that INTRODUCES A LIST: 生词：,
 * 单词：, 词语：. The caller needs the narrower question, not isPaperwork, to
 * decide whether a colon opens a list.
 *
 * `生词：学习 练习 复习` and `注意：复习。` are the same shape and opposite
 * things. 生词 is a list header, so everything after its colon is the list she
 * introduced and gets read as a list. 注意 is a notice marker, so everything
 * after its colon is the notice, and reading it as a list put 复习 on a card
 * (measured 2026-09-08). Structural-versus-ordinary is the split that already
 * exists in this file and it answers exactly this.
 */
export function isStructuralPaperwork(zh: string): boolean {
  return STRUCTURAL.has(zh);
}

/**
 * True when this word must not become a game card on the free-text path.
 *
 * `prose` says whether the paste reads as sentences (a paragraph, a lesson
 * text) or as a bare list. In PROSE the grammar words are the sentence glue
 * and are dropped. In a LIST every word is one the teacher chose, so 什么,
 * 为什么, 还有, 我们 stay: a beginner's first list is exactly those words
 * (JJ pasted `你好谢谢再见什么为什么还有` on 2026-09-08 and lost half of it).
 *
 * STRUCTURAL paperwork is dropped in both modes. ORDINARY paperwork follows the
 * same prose-or-list rule as everything else, so `asMarker` is what still takes
 * it off a list: this occurrence has a colon straight after it (`作业：`) or 请
 * straight in front of it (`请复习`), which makes it an instruction and not a
 * word she is naming. The caller works that out; only it can see the neighbours.
 */
export function isStopword(
  zh: string,
  prose = true,
  fromSegment = false,
  declared = false,
  asMarker = false
): boolean {
  // Never a word, in any mode.
  if (STRUCTURAL.has(zh)) return true;
  if (ORDINARY.has(zh)) {
    // She wrote it in front of a colon and earned it (see isHerWord).
    if (declared) return !TEACHABLE_PAPERWORK.has(zh);
    if (prose) return true;
    // A bare list: her word, unless THIS occurrence is a marker.
    return asMarker;
  }
  if (prose) return STOPWORDS.has(zh);
  // A list: only a counter phrase the SEGMENTER peeled off a longer chunk is
  // dropped (`一个苹果` lists 苹果, not 一个). A word the teacher separated
  // herself is always hers.
  return fromSegment && COUNTER.has(zh);
}

/**
 * The paperwork words that are ALSO ordinary vocabulary, so a teacher who
 * declares one (writes it in front of a colon, `学习：我每天学习中文。`) gets it
 * back. Reproduced live 2026-09-08: 学习 vanished from that paste.
 *
 * The rest of PAPERWORK stays dropped even when declared, because `生词：`,
 * `作业：` and `今天：` introduce the list rather than being on it.
 */
const TEACHABLE_PAPERWORK = new Set<string>([
  '学习', '練習', '练习', '复习', '複習', '完成', '注意', '记得',
]);

/** Number-plus-classifier phrases that ride in front of a noun. */
const COUNTER = new Set<string>([
  '一个', '一些', '一点', '一下', '一起', '一样', '一直', '一定', '一', '个',
  '两个', '三个', '几个', '一本', '一只', '一条', '一张', '一杯', '一件',
]);

/** How many words the list holds. Used by tests and by the README table. */
export const STOPWORD_COUNT = STOPWORDS.size;

