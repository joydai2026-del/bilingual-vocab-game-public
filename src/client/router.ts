// Hash router. Routes look like `#/play/climb/<enc>?pace=fast`, so the
// query is split off the hash itself (not the page URL).

export interface Route {
  /** Path parts, e.g. ['play', 'climb', '<enc>']. Empty array for `#/`. */
  parts: string[];
  query: URLSearchParams;
  /** The raw hash, without the leading `#`. */
  raw: string;
}

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#/, '');
  const questionMark = raw.indexOf('?');
  const pathPart = questionMark === -1 ? raw : raw.slice(0, questionMark);
  const queryPart = questionMark === -1 ? '' : raw.slice(questionMark + 1);

  const parts = pathPart
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean);

  return { parts, query: new URLSearchParams(queryPart), raw };
}

export function currentRoute(): Route {
  return parseHash(window.location.hash);
}

export function navigate(hash: string): void {
  const next = hash.startsWith('#') ? hash : `#${hash}`;
  if (window.location.hash === next) {
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    return;
  }
  window.location.hash = next;
}

/** Calls `render` now and on every hash change. */
export function startRouter(render: (route: Route) => void): void {
  const run = (): void => {
    if (!window.location.hash) {
      window.location.replace('#/');
      return;
    }
    render(currentRoute());
  };
  window.addEventListener('hashchange', run);
  run();
}

