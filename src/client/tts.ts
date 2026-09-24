// Tap-to-hear audio, as a ladder from cheapest to best-sounding.
//
//   0  the device's own REAL Mandarin voice via the Web Speech API. Free,
//      offline, instant. "Real" matters: macOS 26 ships eight novelty
//      character voices (Eddy, Flo, Grandma, Grandpa, Reed, Rocko, Sandy,
//      Shelley) tagged zh-CN alongside Tingting, and reading vocabulary to a
//      class in Grandpa's voice is worse than no device voice at all.
//   1  the worker's `GET /api/tts`, which runs its own server-side ladder
//      (Azure Neural, then MeloTTS). Used when this device has no real
//      Mandarin voice, or when the teacher has turned "Better voice" on.
//   2  nothing plays and the word still shows its pinyin.
//
// Either way the speaker button does something.
//
// Nothing here ever plays on its own: `speak()` is only called from a tap.
//
// Two iPad facts shape this file. (1) iOS only lets an <audio> element play
// after that same element has been played inside a real tap, so one element is
// unlocked on the first gesture and reused for every clip. (2) A blocked
// autoplay rejects with NotAllowedError, which is NOT a server problem: it
// must never latch `serverFailed` and tell the class audio is unavailable.

export type AudioSource = 'device' | 'server' | 'none';

const VOICE_PREF_KEY = 'bvg.voice.v1';

let voicesLoaded = false;
let userGestured = false;
let serverFailed = false;
let sharedAudio: HTMLAudioElement | null = null;
const serverClips = new Map<string, string>(); // zh -> object URL

// One frame of silence. Playing it inside a tap unlocks the element for the
// rest of the session; every later clip reuses the same element.
const SILENCE =
  'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA=';

function audioElement(): HTMLAudioElement | null {
  if (typeof Audio === 'undefined') return null;
  if (!sharedAudio) sharedAudio = new Audio();
  return sharedAudio;
}

/** Plays and immediately pauses one silent frame, inside the user's gesture. */
function unlockAudio(): void {
  const audio = audioElement();
  if (!audio) return;
  try {
    audio.src = SILENCE;
    const started = audio.play();
    if (started && typeof started.then === 'function') {
      void started.then(() => audio.pause()).catch(() => undefined);
    } else {
      audio.pause();
    }
  } catch {
    // Nothing to do: the first speaker tap will try again.
  }
}

/** True for the browser saying "not from a tap", which is not a failure. */
function isPlaybackBlocked(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name;
  return name === 'NotAllowedError' || name === 'AbortError';
}

/**
 * Recorded on the first tap or key press anywhere in the app. Nothing speaks
 * before that, so a shared link never makes noise on its own.
 */
export function noteUserGesture(): void {
  if (userGestured) return;
  userGestured = true;
  unlockAudio();
}

export function hasUserGesture(): boolean {
  return userGestured;
}

function synth(): SpeechSynthesis | null {
  return typeof window !== 'undefined' && 'speechSynthesis' in window
    ? window.speechSynthesis
    : null;
}

// Real Mandarin voices, best first. Everything else in a zh-CN list on macOS 26
// is a novelty character voice (Eddy, Flo, Grandma, Grandpa, Reed, Rocko, Sandy,
// Shelley). Verified live 2026-09-08: the old tie-break returned "Eddy". Edge
// exposes the Azure neural voices (Xiaoxiao, Yunxi) through Web Speech for free,
// Chrome exposes "Google 普通话", Apple ships Tingting / Meijia / Sinji.
//
// An allowlist beats a novelty-voice denylist: Apple adds character voices every
// release, so a denylist rots, while an allowlist that misses a new real voice
// only degrades to "ask the server", which is the better-sounding path anyway.
const TIERS: string[][] = [
  ['xiaoxiao', 'yunxi', 'xiaoyi', 'yunyang', 'online (natural)'],
  ['google', '普通话'],
  ['tingting', 'meijia', 'sinji', 'li-mu', 'yu-shu'],
];

/** Index into TIERS, or -1 for a zh voice we do not recognise as a real one. */
function voiceTier(voice: SpeechSynthesisVoice): number {
  const name = voice.name.toLowerCase();
  return TIERS.findIndex((names) => names.some((n) => name.includes(n)));
}

/**
 * Chinese voices, best first: named real voices before unrecognised ones, then
 * zh-CN, then zh-TW / zh-HK, then anything else whose language starts with `zh`.
 */
function chineseVoice(): SpeechSynthesisVoice | null {
  const speech = synth();
  if (!speech) return null;

  const voices = speech.getVoices().filter((voice) => voice.lang.toLowerCase().startsWith('zh'));
  if (voices.length === 0) return null;

  const rank = (voice: SpeechSynthesisVoice): number => {
    const lang = voice.lang.toLowerCase().replace('_', '-');
    const tier = voiceTier(voice);
    const langScore = lang.startsWith('zh-cn') ? 0 : lang.startsWith('zh-tw') || lang.startsWith('zh-hk') ? 1 : 2;
    // Named real voices (tiers 0..2) always beat unnamed ones (tier 3), then by language.
    return (tier === -1 ? 3 : tier) * 10 + langScore;
  };
  return voices.slice().sort((a, b) => rank(a) - rank(b))[0];
}

/** The device voice we would actually be willing to read a lesson in. */
function realMandarinVoice(): SpeechSynthesisVoice | null {
  const voice = chineseVoice();
  return voice && voiceTier(voice) !== -1 ? voice : null;
}

/** True when this device has a Mandarin voice good enough to use as-is. */
export function hasRealMandarinVoice(): boolean {
  return realMandarinVoice() !== null;
}

function readPref(): string | null {
  try {
    return window.localStorage.getItem(VOICE_PREF_KEY);
  } catch {
    // Private browsing, or storage disabled. The default is fine.
    return null;
  }
}

/**
 * "Better voice": send every word to the server even when this device has a
 * usable Chinese voice of its own. Off by default, because the device path is
 * free, instant and works with no network.
 */
export function preferServerVoice(): boolean {
  return readPref() === 'on';
}

export function setPreferServerVoice(on: boolean): void {
  try {
    window.localStorage.setItem(VOICE_PREF_KEY, on ? 'on' : 'off');
  } catch {
    // The choice just will not survive a reload. Not worth telling anyone.
  }
  // A voice change must not replay clips recorded by the other path.
  releaseServerClips();
}

/** Drops the cached object URLs so the next tap re-fetches. */
function releaseServerClips(): void {
  for (const url of serverClips.values()) {
    try {
      URL.revokeObjectURL(url);
    } catch {
      // Already revoked, or no URL API. Nothing to clean up.
    }
  }
  serverClips.clear();
  serverFailed = false;
}

/**
 * Voice lists load asynchronously on Chrome and Safari. Call this once at
 * start-up; `onChange` fires when the list arrives so the audio status line
 * can update itself.
 */
export function watchVoices(onChange: () => void): void {
  const speech = synth();
  if (!speech) {
    voicesLoaded = true;
    onChange();
    return;
  }
  const update = (): void => {
    voicesLoaded = true;
    onChange();
  };
  if (speech.getVoices().length > 0) voicesLoaded = true;
  speech.addEventListener('voiceschanged', update);
  // Safari sometimes never fires voiceschanged; poll briefly as a backstop.
  let tries = 0;
  const timer = window.setInterval(() => {
    tries++;
    if (speech.getVoices().length > 0 || tries > 10) {
      window.clearInterval(timer);
      update();
    }
  }, 300);
}

/** Where audio is coming from right now, for the small status line. */
export function audioSource(): AudioSource {
  if (preferServerVoice()) return serverFailed ? (hasRealMandarinVoice() ? 'device' : 'none') : 'server';
  if (hasRealMandarinVoice()) return 'device';
  if (!voicesLoaded) return 'device'; // optimistic until the list has loaded
  return serverFailed ? 'none' : 'server';
}

export function audioStatusText(): string {
  switch (audioSource()) {
    case 'device':
      return 'Audio: this device reads Chinese aloud.';
    case 'server':
      return preferServerVoice()
        ? 'Audio: words are read by the better online voice.'
        : 'Audio: no Chinese voice on this device, so words are read by the server.';
    default:
      return 'Audio: not available right now. The words still show pinyin.';
  }
}

async function speakOnServer(zh: string): Promise<void> {
  const cached = serverClips.get(zh);
  const url =
    cached ??
    (await (async (): Promise<string> => {
      const response = await fetch(`/api/tts?text=${encodeURIComponent(zh)}`);
      if (!response.ok) throw new Error(`tts failed with status ${response.status}`);
      const type = response.headers.get('content-type') ?? 'audio/mpeg';
      const buffer = await response.arrayBuffer();
      const objectUrl = URL.createObjectURL(new Blob([buffer], { type }));
      serverClips.set(zh, objectUrl);
      return objectUrl;
    })());

  // The clip fetch succeeded, so the server is fine from here on. Anything
  // that goes wrong below is playback, not the server.
  serverFailed = false;

  const audio = audioElement();
  if (!audio) throw new Error('This browser cannot play audio.');
  audio.pause();
  audio.src = url;
  audio.currentTime = 0;
  await audio.play();
}

/**
 * Says one Chinese word. Resolves once playback has started (or been handed
 * to the speech engine); rejects only if nothing could play at all.
 */
/**
 * Silent mode: `?silent=1` in the URL (remembered in localStorage) or
 * `localStorage['vocab-silent'] = '1'`. Every automated run on a real machine
 * must use it: speechSynthesis plays through the system speakers even when the
 * browser is headless or muted, and on 2026-09-08 it read the vocab aloud
 * while the owner was working.
 */
export function silentMode(): boolean {
  try {
    if (/[?&]silent=1/.test(location.search) || /[?&]silent=1/.test(location.hash)) {
      localStorage.setItem('vocab-silent', '1');
      return true;
    }
    return localStorage.getItem('vocab-silent') === '1';
  } catch {
    return false;
  }
}

export async function speak(zh: string): Promise<void> {
  const text = zh.trim();
  if (!text) return;
  if (silentMode()) return;

  const speech = synth();
  const device = realMandarinVoice();

  // The server is asked first only when it is meant to be better than what is
  // on this device: either there is no real Mandarin voice here, or the teacher
  // turned "Better voice" on.
  if (!device || preferServerVoice()) {
    try {
      await speakOnServer(text);
      serverFailed = false;
      return;
    } catch (error) {
      if (isPlaybackBlocked(error)) {
        // The browser refused to start audio outside a tap. The clip is fine and
        // the next tap will play it, so audio stays reported as available.
        throw new Error('Tap the speaker to hear this word.');
      }
      serverFailed = true;
      // A device voice is worse, not useless. Never go silent while one exists.
      if (!device) throw new Error('No Chinese audio is available on this device.');
    }
  }

  if (speech && device) {
    speech.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.voice = device;
    utterance.lang = device.lang;
    utterance.rate = 0.85; // a touch slower: these are learners
    speech.speak(utterance);
    return;
  }

  throw new Error('No Chinese audio is available on this device.');
}

