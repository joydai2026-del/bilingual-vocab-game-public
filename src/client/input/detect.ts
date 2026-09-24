// What did the teacher just paste?
//
// Three answers, and only three, because only three are worth telling apart:
//   - a Google Sheets link, which the worker can fetch (verified live; see
//     section 7 of docs/research/2026-09-08-quizlet-extraction.md);
//   - a Quizlet link, which NOTHING server-side can fetch (Cloudflare managed
//     challenge plus PerimeterX, verified live, section 1 of the same report),
//     so the only useful answer is to show the teacher the three clicks that
//     get the words onto the clipboard;
//   - anything else, which goes straight to the parser.

export type DetectedInput =
  | { kind: 'sheet'; url: string }
  | { kind: 'quizlet' }
  | { kind: 'text' };

/**
 * True only when the whole box holds one link and nothing else. A word list
 * that happens to mention a URL is still a word list.
 */
function soleUrl(text: string): URL | null {
  const trimmed = text.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  try {
    const url = new URL(trimmed);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

export function detectInput(text: string): DetectedInput {
  const url = soleUrl(text);
  if (!url) return { kind: 'text' };

  const host = url.hostname.toLowerCase();
  if (host === 'docs.google.com' && url.pathname.startsWith('/spreadsheets/')) {
    // The worker validates the id strictly; this only decides where to send it.
    return { kind: 'sheet', url: url.toString() };
  }
  if (host === 'quizlet.com' || host.endsWith('.quizlet.com')) {
    return { kind: 'quizlet' };
  }
  return { kind: 'text' };
}

/**
 * What to show when a Quizlet link is pasted. Three lines, each one thing to
 * do, because the alternative is a dead end. Both paths are from Quizlet's own
 * help centre (section 4 of the research report): Export works only for sets
 * the teacher created, so select-and-copy is listed first.
 */
export const QUIZLET_HELP: readonly string[] = [
  'Quizlet does not let other apps read a set, so copy the words across yourself.',
  '1. Open the set on quizlet.com and scroll to the list of terms.',
  '2. Select the whole list and copy it. For a set you made, the ... menu has Export, then Copy text.',
  '3. Come back here and paste. Chinese and English on separate lines is fine.',
];

