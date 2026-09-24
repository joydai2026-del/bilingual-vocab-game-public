// A tab that stayed open across a deploy keeps running the old code (the
// teacher saw a pre-deploy screen on 2026-09-08). On every visit to Home the
// app asks the server which build is live and reloads once if it differs.

declare const __BUILD_ID__: string;

const RELOADED_KEY = 'vocab-reloaded-for';

export async function reloadIfStale(): Promise<void> {
  try {
    const res = await fetch('/version.json', { cache: 'no-store' });
    if (!res.ok) return;
    const live = (await res.json()) as { id?: string };
    if (!live.id || live.id === __BUILD_ID__) return;
    if (sessionStorage.getItem(RELOADED_KEY) === live.id) return;
    sessionStorage.setItem(RELOADED_KEY, live.id);
    location.reload();
  } catch {
    // Offline or a blocked fetch: keep the page the user has.
  }
}

