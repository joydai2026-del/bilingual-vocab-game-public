// Small DOM helpers. No framework: every screen builds elements with `h`.

type Handler = (event: Event) => void;
type AttrValue = string | number | boolean | Handler | undefined | null;
export type Attrs = Record<string, AttrValue>;
export type Child = Node | string | null | undefined | false;

/**
 * Creates an element. Keys starting with `on` become listeners, `class`
 * becomes className, `text` becomes textContent, everything else is an
 * attribute. Values that are null/undefined/false are skipped.
 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  children: Child[] = []
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);

  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value as Handler);
    } else if (key === 'class') {
      node.className = String(value);
    } else if (key === 'text') {
      node.textContent = String(value);
    } else if (key === 'value' && node instanceof HTMLInputElement) {
      node.value = String(value);
    } else if (value === true) {
      node.setAttribute(key, '');
    } else {
      node.setAttribute(key, String(value));
    }
  }

  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }

  return node;
}

export function clear(node: HTMLElement): void {
  node.replaceChildren();
}

/** A page shell: back link, title, and a content area the screen fills. */
export function screen(title: string, opts: { back?: string; subtitle?: string } = {}): {
  root: HTMLElement;
  body: HTMLElement;
} {
  const body = h('div', { class: 'screen-body' });
  const root = h('div', { class: 'screen' }, [
    h('header', { class: 'screen-head' }, [
      opts.back ? h('a', { class: 'back', href: opts.back, text: '← Back' }) : null,
      h('h1', { text: title }),
      opts.subtitle ? h('p', { class: 'subtitle', text: opts.subtitle }) : null,
    ]),
    body,
  ]);
  return { root, body };
}

/** Copies text, falling back to a temporary textarea on older Safari. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

/**
 * A button that copies a URL and says so for two seconds. Keeps the label
 * width stable so the layout does not jump.
 */
export function copyButton(label: string, getUrl: () => string): HTMLButtonElement {
  const button = h('button', { class: 'btn btn-ghost', type: 'button', text: label });
  button.addEventListener('click', async () => {
    const ok = await copyText(getUrl());
    const previous = button.textContent;
    button.textContent = ok ? 'Copied' : 'Press and hold to copy';
    button.classList.add(ok ? 'copied' : 'copy-failed');
    window.setTimeout(() => {
      button.textContent = previous;
      button.classList.remove('copied', 'copy-failed');
    }, 2000);
  });
  return button;
}

/** A short message strip. `kind` picks the colour. */
export function notice(message: string, kind: 'info' | 'warn' | 'error' = 'info'): HTMLElement {
  return h('p', { class: `notice notice-${kind}`, role: 'status', text: message });
}

export function absoluteUrl(hash: string): string {
  const base = window.location.origin + window.location.pathname;
  return base + (hash.startsWith('#') ? hash : `#${hash}`);
}

/**
 * True when a card's meaning is a Chinese SENTENCE rather than a short gloss.
 *
 * A Chinese-taught teacher's set has no English in it: the meaning is the
 * definition she wrote. At the size a two-word gloss is drawn at, that sentence
 * came out one character per line on a Memory tile and was cut mid-clause by an
 * ellipsis on a Tone Catcher gate (round 1 review, at 390 px). Both give it a
 * smaller size and let it wrap instead. Five characters is where a definition
 * starts and a word like 苹果 or 图书馆 ends.
 */
export function isCjkSentence(meaning: string): boolean {
  const m = meaning.trim();
  return /[㐀-䶿一-鿿豈-﫿々〇]/.test(m) && Array.from(m).length > 5;
}

