// Can this device draw the 3D look, and does this URL want it?
//
// Two separate questions, deliberately kept apart:
//   hasWebGL()      capability. Probe a throwaway canvas for a WebGL 2 context.
//   flatRequested() intent. `?flat=1` anywhere in the URL, page query or hash.
//   wantsFlat()     the answer a game asks for: flat if either says so.
//
// The intent half takes a plain `{ search, hash }` so it is testable without a
// DOM, which is what keeps this file inside the node-environment test suite.

export interface UrlLike {
  search: string;
  hash: string;
}

function currentUrl(): UrlLike {
  if (typeof window === 'undefined' || !window.location) return { search: '', hash: '' };
  return { search: window.location.search || '', hash: window.location.hash || '' };
}

/** True when `flat=1` is in the page query or in the hash's own query. */
export function flatRequested(url: UrlLike = currentUrl()): boolean {
  const onPage = readFlag(url.search.replace(/^\?/, ''));
  if (onPage) return true;

  const hash = url.hash.replace(/^#/, '');
  const mark = hash.indexOf('?');
  if (mark === -1) return false;
  return readFlag(hash.slice(mark + 1));
}

function readFlag(query: string): boolean {
  if (!query) return false;
  try {
    return new URLSearchParams(query).get('flat') === '1';
  } catch {
    return false;
  }
}

/**
 * True when a WebGL 2 context can actually be created. The probe canvas is
 * never attached and its context is released immediately, so calling this is
 * cheap enough to do on every mount.
 */
export function hasWebGL(): boolean {
  if (typeof document === 'undefined') return false;
  try {
    const probe = document.createElement('canvas');
    const gl = probe.getContext('webgl2');
    if (!gl) return false;
    // Hand the context back rather than waiting for the GC: browsers cap how
    // many live WebGL contexts a page may hold, and a game may probe twice.
    const lose = gl.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext();
    return true;
  } catch {
    return false;
  }
}

/** The one call a game makes: run the CSS twin instead of the 3D scene? */
export function wantsFlat(url?: UrlLike): boolean {
  if (flatRequested(url ?? currentUrl())) return true;
  return !hasWebGL();
}

