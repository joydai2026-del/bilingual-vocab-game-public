// Pure CC-CEDICT parsing and gloss selection.
//
// Used twice, which is why it lives here rather than inside the build script:
// `scripts/build-cedict.mjs` runs it over the 125k-line CC-CEDICT dump to
// produce `public/cedict.json`, and `tests/worker.test.ts` runs it over small
// inline samples so the selection rules are pinned by tests instead of by
// eyeballing the output.
//
// Nothing here touches the filesystem, the network, or any Cloudflare type, so
// it typechecks under both tsconfig.json and tsconfig.worker.json.
//
// CC-CEDICT line format:
//   <traditional> <simplified> [<pin1 yin1>] /sense one/sense two/
// Lines starting with `#` are comments.

/** One raw dictionary line, split into its four fields. */
export interface CedictLine {
  trad: string;
  simp: string;
  /** Numbered pinyin exactly as the dump writes it, e.g. `ping2 guo3`. */
  pinyinNum: string;
  /** The `/`-separated senses, unprocessed. */
  senses: string[];
}

/** The compact asset shape the worker reads: `[pinyin, gloss]` per headword. */
export interface DictAsset {
  v: 1;
  e: Record<string, [string, string]>;
}

/** A gloss longer than this is unusable on a bingo square or a game card. */
export const MAX_GLOSS_CHARS = 40;
/**
 * When the first sense blows the cap, a later sense shorter than this is
 * preferred over truncating the first one. Deliberately well under the cap: a
 * 39-character alternative is no better than a trimmed 40.
 */
export const SHORT_GLOSS_CHARS = 25;

const LINE_RE = /^(\S+)\s+(\S+)\s+\[([^\]]*)\]\s+\/(.*)\/\s*$/;

/** Parses one dump line. Returns null for comments and anything malformed. */
export function parseLine(line: string): CedictLine | null {
  if (!line || line.startsWith('#')) return null;
  const m = LINE_RE.exec(line);
  if (!m) return null;
  const senses = m[4].split('/').map((s) => s.trim()).filter((s) => s !== '');
  if (senses.length === 0) return null;
  return { trad: m[1], simp: m[2], pinyinNum: m[3], senses };
}

// --- pinyin -------------------------------------------------------------------

const TONE_ROWS: Record<string, string> = {
  a: 'āáǎà',
  e: 'ēéěè',
  i: 'īíǐì',
  o: 'ōóǒò',
  u: 'ūúǔù',
  'ü': 'ǖǘǚǜ',
};

/**
 * Which vowel carries the mark: `a` if present, else `o`, else `e`, else the
 * last vowel (so `iu` marks the u and `ui` marks the i). The standard rule.
 */
function toneTarget(base: string): number {
  const lower = base.toLowerCase();
  for (const v of ['a', 'o', 'e']) {
    const i = lower.indexOf(v);
    if (i !== -1) return i;
  }
  for (let i = lower.length - 1; i >= 0; i--) {
    if (TONE_ROWS[lower[i]]) return i;
  }
  return -1;
}

/** `ping2` -> `píng`. Tokens that are not syllables pass through unchanged. */
export function syllableToneMarks(token: string): string {
  const m = /^([A-Za-zü:]+)([1-5])$/.exec(token);
  if (!m) return token.replace(/u:/g, 'ü').replace(/v/g, 'ü');
  const base = m[1].replace(/u:/g, 'ü').replace(/v/g, 'ü');
  const tone = Number(m[2]);
  if (tone === 5) return base;
  const at = toneTarget(base);
  if (at === -1) return base;
  const ch = base[at];
  const row = TONE_ROWS[ch.toLowerCase()];
  if (!row) return base;
  const marked = row[tone - 1];
  return base.slice(0, at) + (ch === ch.toUpperCase() ? marked.toUpperCase() : marked) + base.slice(at + 1);
}

/** `ping2 guo3` -> `píng guǒ`. */
export function toneMarks(pinyinNum: string): string {
  return pinyinNum.trim().split(/\s+/).filter(Boolean).map(syllableToneMarks).join(' ');
}

/**
 * True when this entry reads as a proper noun. CC-CEDICT capitalises the
 * pinyin of names, brands, places and surnames, which is the only machine-
 * readable signal it gives. Used to rank, not to exclude: `中国 [Zhong1 guo2]`
 * is the ONLY entry for that word and a classroom still wants "China".
 */
export function isProperNoun(pinyinNum: string): boolean {
  const first = pinyinNum.trim()[0];
  return first !== undefined && first === first.toUpperCase() && first !== first.toLowerCase();
}

// --- sense cleaning -----------------------------------------------------------

/** Senses that only point at another entry are never a usable gloss. */
const REDIRECT_RE =
  /^(?:old\s+|erhua\s+|japanese\s+)?variant\s+of\b|^see\b|^also\s+written\b|^abbr\.\s+for\b|^surname\b|^used\s+in\b|^(?:also|Taiwan|Tw)\s+pr\.?\b/i;

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

/**
 * Turns one raw CC-CEDICT sense into zero or more usable classroom glosses.
 *
 * Order of operations matters: the classifier note goes first (it is dictionary
 * apparatus, not meaning), then the register and usage parentheticals, then the
 * `;` split, because `good; fine` is two glosses and we want the shorter first
 * one, not a 40-character run-on.
 */
export function cleanSense(raw: string): string[] {
  if (/^CL:/.test(raw)) return [];
  // The parenthesised form first: `cat (CL:隻|只[zhi1])` must lose the brackets
  // too, not just their contents, or the gloss comes out as "cat (".
  let s = raw.replace(/\s*\(\s*CL:[^)]*\)/g, ' ').replace(/\bCL:[^/]*/g, ' ');
  // `remain(s)` is one word with an optional plural, not a parenthetical.
  s = s.replace(/\(s\)/g, 's').replace(/\(es\)/g, 'es');
  // Strip parentheticals: register marks ((coll.), (literary), (fig.), (idiom)),
  // usage notes ((before a verb)), and domain tags. Repeated for nesting.
  let prev = '';
  while (prev !== s) {
    prev = s;
    s = s.replace(/\([^()]*\)/g, ' ');
  }
  s = s.replace(/\bsb's\b/g, "someone's").replace(/\bsth's\b/g, "something's");
  s = s.replace(/\bsb\b/g, 'someone').replace(/\bsth\b/g, 'something');

  const out: string[] = [];
  for (const part of s.split(';')) {
    const g = part.replace(/\s+/g, ' ').replace(/^[\s,;:.!?…]+|[\s,;:.!?…]+$/g, '').trim();
    if (g === '') continue;
    // A gloss has to be English and has to start like a word. This drops the
    // leftovers of a stripped parenthetical, e.g. "(after a name) ... River".
    if (!/^[A-Za-z]/.test(g)) continue;
    if (CJK_RE.test(g)) continue;
    if (REDIRECT_RE.test(g)) continue;
    out.push(g);
  }
  return out;
}

/** Every usable gloss for an entry, in dictionary order. */
export function usableSenses(senses: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of senses) {
    for (const g of cleanSense(raw)) {
      const key = g.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(g);
    }
  }
  return out;
}

/**
 * The one gloss a headword gets. The first sense wins; when it is over the cap
 * a genuinely shorter later sense is preferred to a truncated first one, and
 * only if there is none does the first get trimmed at a word boundary.
 */
export const CARD_GLOSS_CHARS = 14;

export function pickGloss(senses: string[]): string | null {
  const usable = usableSenses(senses);
  if (usable.length === 0) return null;
  const first = usable[0];
  // A flashcard wants the short everyday sense. Among the first three senses:
  // a verb-form first sense yields to a short non-verb one (谢谢: "to thank" ->
  // "thanks"), and a long first sense yields to a short one (还有: "there still
  // remains" -> "in addition"). Otherwise dictionary order stands.
  const early = usable.slice(0, 3);
  const plain = early.find((g) => g.length <= CARD_GLOSS_CHARS && !/^to /.test(g));
  if (/^to /.test(first) && plain) return plain;
  if (first.length > CARD_GLOSS_CHARS) {
    const shortOnes = early.filter((g) => g.length <= CARD_GLOSS_CHARS);
    if (shortOnes.length > 0) {
      return shortOnes.reduce((best, g) => (g.length < best.length ? g : best));
    }
  }
  if (first.length <= MAX_GLOSS_CHARS) return first;
  const short = usable.find((s) => s.length < SHORT_GLOSS_CHARS);
  if (short) return short;
  const cut = first.slice(0, MAX_GLOSS_CHARS);
  const space = cut.lastIndexOf(' ');
  return (space > 12 ? cut.slice(0, space) : cut).replace(/[\s,;:.!?…]+$/, '');
}

// --- index building -----------------------------------------------------------

interface Candidate {
  pinyinNum: string;
  gloss: string;
  /** Raw sense count, the tie-breaker for "the fullest common-word entry". */
  senseCount: number;
  proper: boolean;
  /** File order, so ties resolve the same way on every run. */
  order: number;
}

/**
 * Ranks two entries for the same headword. Common words beat proper nouns
 * (`苹果 [ping2 guo3] /apple/` beats `苹果 [Ping2 guo3] /Apple .../`), then the
 * entry with the most senses wins, then the earlier line. Returns true when
 * `a` should replace `b`.
 */
function better(a: Candidate, b: Candidate): boolean {
  if (a.proper !== b.proper) return !a.proper;
  if (a.senseCount !== b.senseCount) return a.senseCount > b.senseCount;
  return a.order < b.order;
}

/**
 * Builds the shipped asset from the dump's lines.
 *
 * Simplified headwords are authoritative. A traditional headword that differs
 * from its simplified form is added afterwards pointing at the same value, so a
 * teacher pasting a traditional list gets the same answer, and never overwrites
 * a simplified headword that happens to spell the same.
 */
export function buildDict(lines: Iterable<string>): DictAsset {
  const simp = new Map<string, Candidate>();
  const trad = new Map<string, Candidate>();
  let order = 0;

  for (const line of lines) {
    const parsed = parseLine(line);
    if (!parsed) continue;
    const gloss = pickGloss(parsed.senses);
    if (gloss === null) continue;
    const cand: Candidate = {
      pinyinNum: parsed.pinyinNum,
      gloss,
      senseCount: parsed.senses.length,
      proper: isProperNoun(parsed.pinyinNum),
      order: order++,
    };
    const cur = simp.get(parsed.simp);
    if (!cur || better(cand, cur)) simp.set(parsed.simp, cand);
    if (parsed.trad !== parsed.simp) {
      const curT = trad.get(parsed.trad);
      if (!curT || better(cand, curT)) trad.set(parsed.trad, cand);
    }
  }

  const e: Record<string, [string, string]> = {};
  for (const [word, c] of simp) e[word] = [toneMarks(c.pinyinNum), c.gloss];
  for (const [word, c] of trad) {
    if (word in e) continue;
    e[word] = [toneMarks(c.pinyinNum), c.gloss];
  }
  return { v: 1, e };
}

