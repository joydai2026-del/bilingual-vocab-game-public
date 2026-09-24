// The two calls the smart input box makes to the worker.
//
// Both hand back either text or a plain-language message. Neither ever throws
// at the caller: a teacher standing in front of a class needs a sentence she
// can act on, not an exception.

import { readExtractBody, type ExtractedItem } from './extract';

export type RemoteText =
  | { ok: true; text: string; items?: ExtractedItem[]; notes?: string[] }
  | { ok: false; message: string };

const OFFLINE = 'Could not reach the internet just now. Check the connection and try again.';

async function readMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    return typeof body.error === 'string' && body.error.trim() ? body.error : fallback;
  } catch {
    return fallback;
  }
}

/** Fetches a shared Google Sheet as CSV text. */
export async function loadSheet(url: string): Promise<RemoteText> {
  let response: Response;
  try {
    response = await fetch(`/api/sheet?url=${encodeURIComponent(url)}`);
  } catch {
    return { ok: false, message: OFFLINE };
  }
  if (!response.ok) {
    return { ok: false, message: await readMessage(response, 'Could not read that sheet.') };
  }
  try {
    const body = (await response.json()) as { text?: unknown };
    const text = typeof body.text === 'string' ? body.text : '';
    return text.trim()
      ? { ok: true, text }
      : { ok: false, message: 'That sheet looks empty. Add some words and paste the link again.' };
  } catch {
    return { ok: false, message: 'Could not read that sheet.' };
  }
}

/**
 * Sends one photo to the worker and gets the words back. The worker reads the
 * photo AND pulls the words out of it, so `items` is the same shape
 * `/api/extract` answers with and can go straight into the pipeline. Older
 * workers answer with the text alone, which still works.
 */
export async function readPhoto(file: File): Promise<RemoteText> {
  let response: Response;
  try {
    response = await fetch('/api/ocr', {
      method: 'POST',
      // The file's own type is the Content-Type; the worker checks it against
      // the list it accepts before it spends anything.
      headers: { 'Content-Type': file.type },
      body: file,
    });
  } catch {
    return { ok: false, message: OFFLINE };
  }
  if (!response.ok) {
    return { ok: false, message: await readMessage(response, 'Could not read that photo.') };
  }
  try {
    const body = (await response.json()) as { text?: unknown };
    const text = typeof body.text === 'string' ? body.text : '';
    const extracted = readExtractBody(body);
    const items = extracted && extracted.items.length > 0 ? extracted.items : undefined;
    if (!text.trim() && !items) {
      return { ok: false, message: 'No words were found in that photo. Try a clearer picture.' };
    }
    // THE NOTES RIDE WITH THE WORDS. They are the worker's, the photo path
    // never asks `/api/extract` again, and dropping them here is how a
    // photographed list that folded a duplicate said nothing about it (round 6
    // fix list, item 5).
    const notes = items && extracted && extracted.notes.length > 0 ? extracted.notes : undefined;
    return { ok: true, text, items, notes };
  } catch {
    return { ok: false, message: 'Could not read that photo.' };
  }
}

