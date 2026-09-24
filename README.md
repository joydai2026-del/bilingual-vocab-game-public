# Bilingual Vocab Game

A bilingual (Chinese-English) vocabulary game generator: paste a word list, get playable games. TypeScript, Cloudflare Workers.

## Demo videos

- **Bilingual Vocab Game (44s, voiceover + music)** - this repo: [docs/demo/bilingual-vocab-game-demo.mp4](docs/demo/bilingual-vocab-game-demo.mp4)

More products by the same builder:

- Caption Wars party game (44s): https://github.com/joydai2026-del/little-games/blob/main/caption-wars/docs/demo/caption-wars-demo.mp4
- IC Bot / Idea Companion (45s): https://github.com/joydai2026-del/idea-companion/blob/master/docs/idea-companion-demo.mp4
- Sponsor Mission Control (56s): https://github.com/joydai2026-del/sponsor-ops-case-study/blob/main/docs/sponsor-ops-demo.mp4
- Spend Detector (18s): https://github.com/joydai2026-del/spendetector/blob/master/docs/spendetector-demo.mp4
- News Curator (58s): https://github.com/joydai2026-del/news-curator/blob/main/docs/news-curator-demo.mp4

---


A teacher pastes a Chinese vocabulary list. The app fills in pinyin and an English
gloss where they are missing, the teacher reviews and edits, and three games are
ready to play. Shareable links, no accounts, no ads, no tracking.

Plan and contract: `docs/plans/2026-09-07-mvp-plan.md`.

## The games are templates, not generated code

This matters, so it is stated plainly: **the language model never writes game code.**
The three games are fixed, hand-written templates. The only thing the model does is
fill in an English gloss for a Chinese word when the teacher did not supply one, and
that gloss goes into an editable review table before any game is made. Everything
else (pinyin, shuffling, scoring, timing, chest outcomes) is deterministic code.

| Game | What it does |
|---|---|
| Memory Match | Pairs Chinese with English. 6 pairs per round for little kids, 8 for big kids and adults. |
| Race Quiz | Every word once in each direction, 4 choices, 12s per question for little kids and 8s for big kids. Solo, or head-to-head in a room. |
| Cloud Climb | Every player is a bean on a shared tower of pastel platforms. A correct answer hops you up one platform, a wrong one is a stumble and nothing more. The tower IS the live ranking. |
| Treasure Dash | Answer, then open one of three chests. Most hold points; rare ones Swap your score with the leader or Steal half of theirs. Neither invents or destroys a point. |

Every game reads the same question list on the same fixed schedule. What differs
is one small reducer: race turns a scored answer into points, climb into a step,
dash into a chest pick. Adding a game is a renderer plus a reducer, not a new
timing model.

## Run it locally

```
npm install
npm run cf:dev        # builds the client, then serves worker + assets on http://localhost:8787
```

`npm test` runs the unit tests, `npm run typecheck` runs TypeScript over the client
and the worker separately.

Workers AI has no local emulation: `/api/enrich` and `/api/tts` call Cloudflare's
real inference service even during `wrangler dev`, so those two routes need a
logged-in Cloudflare session (they were exercised that way, see "Live-verified
facts"). Everything else, including rooms and Durable Objects, runs locally.

## Deploy

```
npm run deploy        # vite build, then wrangler deploy
```

One Worker serves both the static client and the API. There is nothing else to
provision: the Durable Object namespace and the AI binding are declared in
`wrangler.jsonc` and created on first deploy.

## Dictionary

English glosses come from a dictionary first and from Workers AI only as a last
resort. `/api/enrich` tries three sources in this order:

1. **The gloss cache** in `QuotaDO`. Anything a previous request already
   translated, plus anything the teacher typed herself, costs nothing.
2. **CC-CEDICT**, a 125,025-entry offline Chinese-English dictionary shipped as
   a static asset. It answers most classroom vocabulary instantly, offline, and
   for zero AI spend.
3. **Workers AI**, for the words the first two did not know.

This order exists because of a real outage. On 2026-09-07 the free Workers AI
allocation of 10,000 neurons a day ran out (error 4006), Workers AI was the only
gloss source, and every English column came back blank. Now a 4006 costs the
teacher only the handful of words CC-CEDICT does not carry, and she is told how
many: `The AI helper has used up its daily budget. N words were filled from the
dictionary; please type the rest.`

### Building the asset

```
npm run build:dict    # data/cedict.txt.gz -> public/cedict.json
```

`npm run build` runs this first, so a deploy always ships a current asset. Vite
copies `public/` into `dist/client`, which is the `assets.directory` in
`wrangler.jsonc`, so the Worker reads it back through `env.ASSETS` and parses it
once per isolate.

The generated `public/cedict.json` is about 8 MB and is **not** committed; the
3.8 MB gzipped source at `data/cedict.txt.gz` is, and the asset is regenerated
at build time. `scripts/build-cedict.mjs` is pure IO; every parsing and
selection rule lives in `src/shared/cedict.ts` so the tests can pin it.

The selection rules, in short: prefer a common word over a proper noun (the
dump lists `苹果 [Ping2 guo3] /Apple (American tech company)/` before
`[ping2 guo3] /apple/`), then prefer the entry with the most senses; drop
classifier notes (`CL:...`) and register parentheticals (`(coll.)`,
`(literary)`, `(fig.)`, `(idiom)`); expand `sb` and `sth`; skip redirect senses
(`variant of`, `see`, `abbr. for`, `surname`, `Taiwan pr.`) in favour of the
next one; cap a gloss at 40 characters, preferring a shorter sense over a
truncated long one. Traditional headwords that differ from their simplified
form are indexed too, so a traditional paste works.

### Attribution

The dictionary data is **CC-CEDICT**, published by MDBG and licensed
[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).
Source: <https://www.mdbg.net/chinese/dictionary?page=cc-cedict>

`public/cedict.json` is a derivative work of CC-CEDICT and carries the same
licence. The attribution is repeated in the page footer so it reaches anyone
using the app, not just anyone reading this file.

## Getting words in

One box on the home screen takes everything, and the app works out which it is.

### Reading a paste that has no shape at all

A teacher does not write a spreadsheet. She writes `苹果，香蕉，老师，学生` on one
line, or a whole paragraph, or a WeChat message with the list buried in the
middle of it. Until 2026-09-08 every one of those produced ONE enormous "word",
because `src/shared/parse.ts` reads ROWS: one word per line, optionally with a
gloss beside it. That is the right reader for a Quizlet export and the wrong one
for how a list actually gets written.

`src/shared/extract.ts` is the layer above it. It decides between two paths:

| Path | When | What happens |
|---|---|---|
| **structured** | The paste has columns (a tab, a `\|`), or two or more rows already carry a gloss or a reading | `parse.ts` is authoritative. The teacher wrote the pairs herself, so her gloss wins over any dictionary one |
| **free** | Everything else | Every run of Chinese is cut out (all punctuation, Chinese and ASCII, plus bullets, numbering, brackets, Latin text and whitespace are separators), and each run is either a dictionary headword or is segmented by forward maximum matching over CC-CEDICT, longest match first, at most 4 characters |

TWO glossed rows are needed for `structured`, not one. A two-column table
flattened by the copy (all the Chinese, then all the English) arrives as N items
with exactly one wrong gloss attached, so one glossed row is the signature of a
paste that must go down the free path, not evidence the teacher wrote pairs.

Then: function words and the sentence a teacher writes AROUND a list (`这周的生词`,
`请复习`) are dropped, from `src/shared/stopwords.ts`, and only on the free path,
because a teacher who typed `的 possessive particle` herself meant it. Single
characters the segmenter produced are dropped; a single character she listed on
its own line is kept. Duplicates collapse to the first occurrence, because a
repeat breaks Memory Match pairing. The list is capped at 200.

Two shapes are handled by name because they are what the real world hands us:

- **Paperwork.** `Unit 3 Vocabulary`, `Homework: page 12`, `Name:` are removed
  BEFORE the pairing runs and reported as skipped. That order is the point:
  `parse.ts` reads a line with no Chinese as the gloss of the line above it, so a
  paste ending `Homework: page 12` used to hand that string to 香蕉 as its
  English meaning. Every pattern requires punctuation or a digit, so a real gloss
  (`teacher`, `test`, `page`) can never be eaten. The Chinese half of the same
  paperwork (`第一课生词`, `生词表`, `第三单元词汇`) goes the same way, and only
  ever as a WHOLE line: `这周的生词：苹果 香蕉` has a list on it and is read as
  one.
- **An email signature.** Everything after `--`, `____` or `Sent from my iPhone`
  is signature, which beats guessing whether `Ms. Chen` is a name or somebody's
  gloss. A closing WORD needs its punctuation (`Best,` `Thanks.` `Regards!`) or
  has to be the last non-empty line of the paste. A bare `Thanks` used to be
  trusted anywhere, and a `Thanks` typed in the middle of a word list sent every
  line under it to skipped: four of the teacher's words, gone, with no error to
  say so (fixture 37). Two rules now stop that. The bare word is only a sign-off
  where there is nothing left to lose, and a signature NEVER swallows a line with
  Chinese on it: a line with Chinese is a word she typed, so it ends the
  signature instead of disappearing into it.
- **A word an OCR space cut in half.** `香 蕉` off a photo of a board is rejoined,
  but only on a line that also carries Latin text. A teacher drilling `人 口 手 大
  小` writes characters and nothing else, and 人口 is a dictionary word, so an
  ungated join would destroy that list.

Why maximum matching and not a model: it needs no network, no budget and no
latency, the same paste always makes the same game, and the dictionary that
scores it is the same asset that already ships for glosses.

**Paste anything.** Tab, comma, semicolon, `|`, a dash, a plain space, quoted
CSV, numbered lists, bullets, pinyin in brackets (`苹果 (píng guǒ) apple`), and
the alternating-lines shape you get by selecting the terms on a Quizlet set page
and copying (Chinese on one line, English on the next). Every line is split at
its FIRST delimiter, so a definition with commas in it stays in one piece. The
rules and the shapes they came from are in `src/shared/parse.ts`, and the
evidence is section 6 of `docs/research/2026-09-08-quizlet-extraction.md`.

**Paste a Google Sheets link.** The Worker fetches
`https://docs.google.com/spreadsheets/d/<id>/gviz/tq?tqx=out:csv` and hands the
CSV to the same parser. No auth, no API key, no Google login: the sheet only has
to be shared as "Anyone with the link". This is the one genuinely zero-step URL
path the app has. A private sheet answers with a sign-in page, and the teacher
is told: *This sheet is private. In Google Sheets choose Share, then Anyone with
the link, then paste again.*

**Paste a Quizlet link and you get instructions, not an error.** Quizlet cannot
be fetched by anything server-side: it runs a Cloudflare managed challenge plus
PerimeterX, and every non-browser request returns 403, including `robots.txt`.
This was tested directly rather than assumed (section 1 of the research report).
So a Quizlet URL shows the three clicks that get the words onto the clipboard
instead. There is deliberately no Quizlet fetcher in this codebase.

**Add a photo or screenshot.** The photo button opens the camera on a phone and
the file picker on a laptop, sends the image to `/api/ocr`, and puts the words
it read into the same box for the teacher to check. **No account and no key are
needed**: on a fresh checkout this runs on Cloudflare Workers AI through the same
`AI` binding that already powers the English helper and the spoken audio.

Reading is a ladder, set by the `OCR_PROVIDER_ORDER` var (default
`"azure,workersai"`), and the first provider that produces text wins:

| Provider | What it is | Needs |
|---|---|---|
| `azure` | Azure AI Vision Read (Image Analysis 4.0, the `read` feature). A purpose-built OCR engine, so it goes first when it is there | `AZURE_VISION_KEY` + `AZURE_VISION_ENDPOINT`. Skipped silently when either is missing |
| `workersai` | `@cf/meta/llama-3.2-11b-vision-instruct` on Workers AI, asked to transcribe every line exactly | nothing |

So the shipped default means Workers AI today, and Azure first the day someone
creates the resource. That is a config change plus a redeploy, never a code edit:

```
npx wrangler secret put AZURE_VISION_KEY
npx wrangler secret put AZURE_VISION_ENDPOINT     # e.g. https://<name>.cognitiveservices.azure.com
```

An unknown provider name is ignored with a log, and an order that names nothing
recognisable falls back to `azure,workersai`, so a typo cannot switch photo
reading off. The one way to turn it off is to pin a provider this install cannot
run (`OCR_PROVIDER_ORDER=azure` with no Azure secrets); then `/api/ocr` answers
`501 { "error": "Photo reading is not set up yet." }` and the button says so
rather than failing silently.

Each rung is one paid call, so the route reserves one per planned provider
against the daily `ocr` budget and refunds the rungs it never reached. A photo
over `OCR_MAX_BYTES` (4 MB) gets a 413 and anything that is not a JPG, PNG or
WebP gets a 400, both before a penny is spent.

Note on Workers AI: the free plan allows 10,000 neurons a day across every AI
route in this app. When that is spent, `/api/ocr` answers `502` with *"Could not
read that photo"* until the daily reset. The model is real and the route reaches
it (verified live on 2026-09-08 through `wrangler dev`; the service answered
`4006 you have used up your daily free allocation`, where a model that does not
exist answers `5007 No such model`), but no end-to-end photo has been read live
yet, so the transcription quality itself is not yet measured.

The optional `OCR_LANGUAGE` var forces one Azure Read language (`zh-Hans` for
Simplified Chinese) and does not affect the Workers AI rung. It is **empty on
purpose**. Microsoft's own language-support page says of Read: *"Do not provide
the language code as the parameter unless you are sure about the language...
Otherwise, the service may return incomplete and incorrect text."* A vocab list
is Chinese and English on the same line, which is exactly what the unforced
universal model is for.

### When the dictionary cannot read it at all

Almost always it can, and then `/api/extract` spends nothing: a static asset and
a table lookup, no model, no quota, no network.

THE ONE EXCEPTION is a paste with real Chinese in it (four characters or more)
that produced fewer than TWO words. Two words already make a game, so a paste
that produced two is finished. Below that, the dictionary has failed on something
that plainly has words in it, and asking a model beats handing the teacher an
empty screen. That call is charged to the same daily `enrich` budget as every
other paid call in the app, and being out of budget skips it in silence: whatever
the dictionary found is still a better answer than an error.

The model proposes; it never decides. Every word it returns has to pass five
tests before it can reach a card, and they are the same bar the dictionary path
holds itself to:

| Test | What it stops |
|---|---|
| all Chinese | `IP`, `3Q`, `88`, `A`: what a model answers when it has nothing to say |
| at least 2 characters | a lone character is a piece of a word |
| not a stopword | 的, 了, 一个: grammar, not vocabulary |
| present in the teacher's own paste | a word she did not ask for |
| a CC-CEDICT headword with an English meaning | an invented word, and any gloss the model wrote |

So the reading and the meaning on the card come from the dictionary, never from
the model. The reply carries `rescued: <n>` when this happened and added
something, and the dictionary's own words keep their place at the front of the
list.

A paste that has already been through the rescue in this isolate does not go
again. The answer is remembered (200 pastes, keyed by a hash of the normalised
text), the EMPTY answer included, and the memory is read BEFORE the budget is
reserved: a teacher whose paste did not work is a teacher who presses the button
again, and the second press must not buy the answer she already has.

The photo path does NOT rescue. `/api/ocr` reads the words out of the photo's
text with the same dictionary reader, so the two paths agree on everything the
dictionary can do, but a photo has already spent an `ocr` call and the text it
produced is returned whatever happens. A photo of a list the dictionary cannot
read comes back with its text and few or no words.

## API

Everything under `/api/`. Every JSON response is `Cache-Control: no-store`; only the
audio route is cacheable. Anything not under `/api/` is served from the built client
with single-page-app fallback.

| Method | Path | Body / query | Returns |
|---|---|---|---|
| POST | `/api/enrich` | `{ items: [{ zh, en? }] }`, max 40, every `zh` must contain a Chinese character | `{ items: [{ zh, en }], warning? }`. Gloss cache, then CC-CEDICT, then Workers AI (see "Dictionary") |
| GET | `/api/tts` | `?text=<Chinese>`, max 60 chars, optional `&voice=azure\|melotts` to force one rung | audio bytes with the container sniffed from the response, plus `x-tts-voice: azure\|melotts` and `X-Tts-Cache: HIT` or `MISS` |
| GET | `/api/sheet` | `?url=<a docs.google.com spreadsheet link>` | `{ text }`, the sheet as CSV. 400 with a plain sentence when the link is not a Sheets link or the sheet is not shared |
| POST | `/api/extract` | `{ text }`, max 64 KB of text | `{ items: [{ zh, pinyin, en }], skipped, mode, counts, rescued? }`. The dictionary reads it: no model, no quota, no network. THE ONE EXCEPTION is a paste that plainly holds Chinese and produced fewer than two words, which reserves the daily `enrich` budget and asks a model (see "When the dictionary cannot read it at all"). `rescued` is present only when that happened and added something. `skipped` carries at most 50 lines |
| POST | `/api/ocr` | raw image bytes, `Content-Type: image/jpeg\|image/png\|image/webp`, max 4 MB | `{ text, items, skipped, mode, counts }`: the photo's text AND the words read out of it by the SAME dictionary reader, so the two paths agree on the dictionary half. They differ in one place: the photo path never rescues (see "When the dictionary cannot read it at all"), so a photo of a list the dictionary cannot read comes back with its text and few or no words. One line per line of the photo. Workers AI by default, Azure Vision first when its secrets are set. 501 only when `OCR_PROVIDER_ORDER` names nothing this install can run |
| POST | `/api/rooms` | `{ set, teacher: true }`, optional `perQuestionMs` | `{ code, hostKey, createdAt }`. The host key is returned once and never again; `createdAt` is the room's identity, and the teacher's device stores it WITH the key so the key is bound to this room and not to the next one handed the same four letters |
| POST | `/api/rooms` | `{ set, questions, perQuestionMs }`, max 200 items (legacy "Race a friend") | `{ code, createdAt }` |
| POST | `/api/rooms/:code/join` | `{ name }`, max 24 chars | `{ playerId, memberKey, state, version, nextPollMs, serverNow }`. The member key is returned once and never again |
| POST | `/api/rooms/:code/round` | `{ hostKey \| playerId, kind: race \| climb \| dash, perQuestionMs?, questionsPerRound? }`. `questionsPerRound` is 6 to 30, and 12 when absent | `{ state, version, nextPollMs, serverNow }` |
| POST | `/api/rooms/:code/start` | `{ playerId }` (legacy alias for `kind: "race"`, host only, needs 2 players) | `{ state, version, nextPollMs, serverNow }` |
| POST | `/api/rooms/:code/answer` | `{ playerId, memberKey, index, choice }` | `{ ..., accepted, correct, correctChoice, pick? }`, or 403 when the member key does not match |
| POST | `/api/rooms/:code/pick` | `{ playerId, memberKey, index, chest }` (Treasure Dash) | `{ ..., accepted, outcome? }`, or `{ accepted: false, refusal }`, or 403 when the member key does not match |
| POST | `/api/rooms/:code/end` | `{ hostKey \| playerId }` ("end this round now") | `{ state, version, nextPollMs, serverNow }`. Ends the running round with the scores as they stand and moves to results. Non-destructive, unlike `close` |
| POST | `/api/rooms/:code/lobby` | `{ hostKey \| playerId }` ("pick another game") | `{ state, version, nextPollMs, serverNow }` |
| POST | `/api/rooms/:code/close` | `{ hostKey \| playerId }` ("finish") | `{ state, version, nextPollMs, serverNow }` |
| GET | `/api/rooms/:code` | `?v=<version>` | `{ state, version, nextPollMs, serverNow }`, or `{ unchanged: true, ... }` when the version matches |

`nextPollMs` tells the client how often to poll: 2000 in the lobby, 1000 during a
round, **2000 on the results screen**, 0 once the room is closed (stop polling).
Results polling is the one cadence that changed in the room model v2: a device
sitting on the results screen has to keep asking, or it never learns the teacher
started the next game. An unknown room code returns 404
`{ "error": "room not found" }`.

Which credential a route needs is not uniform, and that is deliberate. `round`,
`lobby` and `close` are the teacher's controls and take the host key **or** the
legacy player-host's id; `answer` and `pick` are things a player does and need a
`playerId` **and** the `memberKey` that proves it is really that player; `join`
needs neither, because it is how you get both. Requiring a `playerId` everywhere
would lock a teacher, who is not a player, out of her own room.

**A player id is a name badge, not a password.** The roster is public, so every
device in the room can read every player's id. `join` therefore also hands back a
private `memberKey`, which the client keeps next to the `playerId` in
localStorage and sends with every answer and pick. A mismatch is a 403 with a
plain sentence. Without it, any student could answer as another student, or open
(and waste) somebody else's Treasure Dash chest. The key never appears in any
`state` response: it lives in its own Durable Object storage slot, like the
teacher's host key. A legacy "Race a friend" room (`model: 1`) still accepts a
bare `playerId`, because a week-1 client has no member key and a race running
across the deploy has to finish; a `model: 2` room never does.

**`state` never contains the answer key, and never contains enough to rebuild
it.** Every room response is stripped of `questions[].answer`. In a `model: 2`
room it is also stripped of `questions[].itemId` and of `set.items`, because
those two together WERE the answer key: look up the item a question points at,
read its English or Chinese, and the right choice is whichever one matches. The
v2 wire sends `set` as `{ v, title, level, count }` and each question as
`{ index, dir, prompt, promptPinyin, choices }`, and nothing else. A player who
opens devtools during a round sees the prompts and choices but not which one is
right. The correct choice comes back one question at a time as `correctChoice`
in the reply to that player's own answer, and only for an answer the server
actually recorded (`-1` means withheld).

On the answer route, `accepted` is false when the server ignored the answer (the
window had closed, the question was already answered, the player is not in the
room), and `correct` is only ever true when `accepted` is also true. A client
should unlock the question and resync on `accepted: false` rather than show a
result.

A room is created with its questions checked against its set: every question
must point at an item that exists, carry 2 to 4 choices with no repeated label,
number itself 0, 1, 2 and so on in order, and its answer must be the right word
for that item in that direction. Anything else is a 400 with a plain sentence
saying which rule failed.

### Class rooms

A room hosts a **sequence of rounds**, not one race:

```
lobby --(teacher starts a round)--> round --(schedule ends, or teacher:
  ^                                          "end this round now")--> results
  |                                                                     |
  +--------------------(teacher: "pick another game")-------------------+

                          lobby --(30 min idle)--> closed
                        results --(15 min idle)--> closed
                  any phase --(teacher: "finish")--> closed
```

A round is **12 questions** by default, and the teacher may ask for anywhere
between 6 and 30. It is not the whole set: a 30-word list can produce 60
questions, which is a quarter of an hour of one game. Consecutive rounds work
through the set before repeating any of it, so round 2 asks what round 1 did not.

A room holds **40 students** by default (`ROOM_MAX_PLAYERS_TEACHER`), and the
number is on the wire, so a full room says so for the right reason. A legacy
two-player "Race a friend" room keeps its own cap of 8.

The teacher opens a set, taps "Start a class room", and gets a 4-letter code on a
projectable screen. No account, for her or for the students. Students type the
code and a name and appear as named beans in the lobby. The teacher picks a game
and starts it; everyone plays the same one; a shared board shows the live
ranking; results at the end; then "pick another game" and the **same** students
play again without rejoining.

The teacher is not a player. A room created with `{ teacher: true }` returns a
**host key**, which the teacher's browser keeps and which is the only thing that
can start a round, return to the lobby, or finish the room. That key is written
to its own Durable Object storage slot and is never part of the room state, so
there is no path by which it could reach a student's screen.

The roster freezes the moment a round starts and thaws again between rounds, so
a latecomer joins at the next gap rather than mid-question. Cumulative totals and
wins carry across rounds; per-round scores are zeroed at each start.

Questions are built **on the server** at every round start, from that round's own
secret seed. The create payload no longer carries a question list at all, every
round gets a fresh shuffle, and the answer key never leaves the server.

### Treasure Dash chests

All three chests already hold a card before anybody picks: the card is a pure
function of the round seed, the player, the question and the chest number.
Picking chooses which one you get, it does not roll one, so there is nothing to
re-roll by retrying and nothing to read ahead by inspecting the wire.

| Card | Weight | What it does |
|---|---|---|
| +50 / +100 / +200 | 40 / 35 / 15 | Points, straight up |
| Swap | 4 | Exchange your score with the current leader's |
| Steal | 6 | Take `floor(leader score / 2)` from the current leader |

Weights are relative rather than percentages, and they live in the round's config
so they can be retuned without a code change. Swap and Steal are **zero-sum**:
the total of every score in the room is identical before and after, which is
asserted in the tests and is the property that makes them safe to apply
concurrently. If the picker is already the leader, both pay 100 instead, so no
chest is ever a dud.

A chest may be opened only on a question you got **right**, only once, and only
inside the pick window (`pickMs` after the question closes, 3s by default), which
is why a dash slot is wider than a race slot: `perQuestionMs + pickMs + 1500`. A
refused pick returns no `outcome` field at all, so probing all three chests
teaches a client nothing.

### How the race stays fair

The server owns the clock. Question `i` is open from `startsAt + i * slotMs` for
`perQuestionMs`, where `slotMs = perQuestionMs + 1500` (the feedback gap). The
Durable Object computes how fast an answer was from its own clock, not from
anything the client sends, so a client cannot claim it answered instantly.
Answers before the window opens or more than 1.5s after it closes are ignored.
The first answer a player sends for a question wins; later ones are dropped.

When a round ends, the room writes an immutable result row into `history` once
and never recomputes it, so every device sees the same winner. Highest score wins, then
lowest time. If the top two match on both, `tie` is true, `winnerId` is null,
and both are shown as winners.

**The time used for ranking charges you for questions you skipped.** Every
question a player never answered counts as the full per-question budget. Without
that, a player could win by answering fewer questions: on a 4-question race, one
player answering all four (two right at 4s, two wrong at 0.1s) scores 300 in
8.2s, while a player answering only two, both right at 4s, also scores 300 but
in 8.0s and would have won having played half the game. Charging the skipped
questions at full budget makes that 24.0s and the honest result comes back.
`RankingEntry.totalMs` carries this adjusted number, so what the client shows
and what the sort uses cannot drift apart.

A round finishes when everyone has answered everything (and, in dash, opened
every chest they earned), or when the schedule runs out, or after 60 seconds with
nobody joining, starting, answering or picking. The teacher can also end a round
outright ("end this round now"), which banks the scores as they stand and shows
the results: that is the non-destructive counterpart to "finish", which ends the
lesson and cannot be undone. A room left on the results screen for 15 minutes
closes itself, and so does one left in the lobby for 30. All of those, plus the 2h delete, are backed by a
single Durable Object alarm aimed at whichever comes first, and that alarm is
re-aimed after every accepted move, so an abandoned round really does end 60
seconds later instead of running its schedule out. A legacy two-friend race needs
two players before the host can start it; a teacher room needs one, because the
teacher is not one of them. Both rules are enforced in the server, not just the
screen. Rooms delete themselves 2 hours after creation.

### What a student cannot do

- read the answer key: every response is built from `publicState`, which strips
  `questions[].answer`;
- read the round seed, which would regenerate the key and preview every chest:
  `publicState` rebuilds the round field by field without it, and a test walks
  the serialized state recursively asserting no `seed` and no `answer` key
  anywhere;
- claim to have answered instantly: elapsed time is computed from the Durable
  Object's own clock;
- answer twice, or outside the window, or with a choice the question does not
  offer;
- open a chest they did not earn, open one twice, or learn what a refused chest
  held;
- re-roll a chest by retrying, since the card was fixed by the seed before the
  pick;
- join mid-round, or start, reset or finish a round without the host key.

### Deploying over a live class

A room created before this deploy has no room-model field. It is upgraded on read
and keeps emitting the **v1 wire shape**, so a tab still holding week-1 JavaScript
finishes its race instead of dying on a phase it has never heard of. A room
becomes v2 only when a teacher creates one or a v2 round is started. Belt and
braces all the same: **deploy between classes.** Rooms are 2h TTL and a lesson is
under an hour.

Clients carry a `ROOM_MODEL` guard: on a mismatch they show one "this game was
updated, tap to reload" notice and stop polling, which turns a confusing dead
screen into a tap.

## Live-verified facts

Grades: **A** = proven live against the real service, **B** = proven in source or
vendor documentation, **C** = not verified. Everything below was checked on
2026-09-07 through `wrangler dev`, which calls the real Workers AI service
(Workers AI has no local emulator).

| Fact | Evidence | Grade |
|---|---|---|
| `@cf/meta/llama-3.3-70b-instruct-fp8-fast` is a live, working model id | Called it; it returned glosses | A |
| `@cf/meta/llama-3.1-8b-instruct-fast` is a live, working model id | Called it; it returned glosses. The response reports the served model as `@cf/meta/llama-3.1-8b-fast-v2`, so the documented id is an alias | A |
| A 10-item Chinese-only list comes back with 10 non-empty glosses | Ran it: 苹果/香蕉/老师/学校/朋友/下雨/高兴/跑步/图书馆/星期三 returned apple, banana, teacher, school, friend, rain, happy, run, library, Wednesday | A |
| `@cf/myshell-ai/melotts` is a live, working model id | Called it; it returned audio | A |
| MeloTTS accepts `lang: "zh"` for Chinese | `lang: "zh"` returns audio for Chinese text, while the same text with `lang: "en"` fails with `3043: Internal server error` and with `lang: "fr"` fails with `8002: Invalid input`. So the language parameter is honoured and Chinese has a working path | A |
| MeloTTS output actually sounds like correct Mandarin | **Nobody has listened to it yet.** The bytes are the right shape (44.1 kHz 16-bit mono, 1.19s for the three syllables of 你好吗, which is the right length), but shape is not pronunciation | C |
| MeloTTS returns MP3 | **False as documented.** Cloudflare's model page says MP3; the live service returned RIFF/WAVE PCM. The worker sniffs the magic bytes and sets the header from what actually arrived, so this stays correct either way | A |
| MeloTTS is the only multi-lingual TTS model in the catalogue | The other TTS models are Deepgram aura-1, aura-2-en, aura-2-es (English and Spanish only) | B |
| Azure Neural TTS is wired in and would be tried first | The ladder, the SSML body, the headers, the 401/403/429/5xx fallback, the quota budget and the cache keying are all covered by `npm test`. **No Azure resource exists yet**, so not one byte has been exchanged with the live service: every test drives it through an injected `fetch` | B |
| The Azure call shape is the one Azure documents | Endpoint, `Ocp-Apim-Subscription-Key`, `X-Microsoft-OutputFormat` and the required `User-Agent` all come from the Azure REST reference, and the same body shape returned 401 rather than 400 from the live endpoint during research (which means it parsed) | B |
| A missing Azure key changes nothing | With neither secret set, `plannedProviders` returns `['melotts']` and the reserved budget is 3, exactly as before Azure existed. Covered by `npm test` | B |
| Full room lifecycle works over HTTP | Ran create, two joins, host-only start (a non-host got 409), an answer rejected before its window opened, a correct answer scored 197 with 259ms credited from the server clock, a duplicate answer rejected, both questions answered, phase `done`, `nextPollMs` 0, immutable `result` identical across repeated polls, a late answer and a late join both rejected | A |
| The Durable Object alarm finishes an abandoned room | Started a race, answered nothing, and did not poll. The room was `done` when next read, and its `lastActivityAt` landed 4ms after the scheduled end, 8 seconds before the read. Only the alarm could have written that | A |
| Rooms delete themselves 2h after creation | The delete stamp is written and the alarm handler acts on it, but a 2h wait was not sat through | C |
| A repeated `/api/tts` word is served from the edge cache on the deployed worker, not the model | 2026-09-07, on the deployed `workers.dev` URL (not `wrangler dev`): fetched `/api/tts?text=图书馆` twice. The second response carried `cf-cache-status: HIT` and byte-identical audio. This is the row the whole TTS cost model rests on, and it had previously been graded A off a `wrangler dev` run, which proves the code path but not the edge | A |
| The per-IP daily cap returns 429 | Ran `wrangler dev --var TTS_PER_IP_PER_DAY:1 --var ENRICH_PER_IP_PER_DAY:1`. The second distinct word on each route returned 429 with the plain-language message | A |
| A daily cap now counts model calls, not requests | Reserve-then-refund, covered by unit tests (`npm test`): a first-try call nets 1, a call that burns every retry nets 3, an over-limit reservation is refused, and a refund can neither cross UTC midnight nor drive a counter below zero. **Not re-run live since this change**, and the 429 repro above now needs `--var TTS_MAX_ATTEMPTS:1 --var ENRICH_MAX_ATTEMPTS:1` as well, because a cap of 1 cannot fit a 3-call reservation and would refuse the very first call | B |
| A word already translated costs nothing after the budget is gone | With the enrich budget spent, a new word returned 429 while a repeat of 苹果 returned 200 `apple` from the server-side gloss cache | A |
| `/api/enrich` refuses text with no Chinese in it | `{"zh":"apple"}` and a batch containing `"translate this whole page"` both returned 400 `every word must be Chinese` | A |
| A body over the size cap is refused before it is parsed | A 309,383-byte body returned 413 | A |
| Room questions are checked against their set | Live 400s for: an answer pointing at the wrong word, an itemId not in the set, a 100,000-character itemId, and out-of-order indexes | A |
| A one-player room cannot start | A lone host got 409 `wait for a second player to join before you start`; the same call succeeded once a second player joined | A |
| Players are never sent the answer key | Every room response is built from `publicState`, which strips `answer` from every question; the correct choice reaches a player only in the reply to their own recorded answer, as `correctChoice`. Unit-tested in `tests/room.test.ts` (`publicState`, `revealedChoice`); not re-run live since the change | B |
| Players cannot REBUILD the answer key either | Stripping `answer` alone was not enough: until 2026-09-08, `questions[].itemId` plus `set.items` were both on the wire, and joining them recovered every answer. `tests/round.test.ts` now runs that exact attack against a v2 `publicState` and recovers 0 of 8, and runs the same reconstructor against a `model: 1` wire as a negative control, where it still recovers 8 of 8. Source-proven, not re-run live | B |
| A player id is not a credential | `join` issues a private `memberKey`; `answer` and `pick` refuse with 403 when it does not match the room's `members` storage slot. Unit-tested in `tests/worker.test.ts` (`isMemberAuthorized`, and the persistence pairing that stops a player existing without a key). The RoomDO HTTP shell that calls it needs a Workers runtime to test, same as the host-key path, so this is source-proven, not live | B |
| Cloud Climb's result order is the tower order | `buildRanking` ranks a climb round on `step` then `totalMs` and on nothing else; score used to sit between them, so the podium could disagree with the tower the class had just watched. `tests/round.test.ts` computes the tower order independently and asserts the result rows match it, including a case where the highest scorer finishes last | B |
| The answer route reports `accepted` and `correct` | Before the window: `accepted:false, correct:false`. Correct answer in the window: `true/true`, score 185. Wrong answer: `true/false`. Duplicate: `false/false` | A |
| ~~The 60s inactivity alarm finishes an abandoned room~~ **superseded 2026-09-08** | The run was real: an 8-question race (76s schedule), unpolled, was `done` with the finish stamped 60,004ms after the start, 19s before the schedule end. That behaviour has since been deliberately removed. The inactivity finish may no longer fire while a question or pick window is still open, because `perQuestionMs` goes up to 60s and the two deadlines collided: a class thinking hard about one slow question had the round closed underneath them, discarding an answer that was still in time. An abandoned round now runs to its schedule end instead (bounded by `questionCount * slotMs`), and the results screen still self-closes at 15 minutes and the room at 2h. See `tests/room.test.ts`, "the inactivity floor". Not re-run live | B |
| A class of 40 fits in one room | `join` reads the room's own `maxPlayers`, which a teacher room takes from `ROOM_MAX_PLAYERS_TEACHER` at create. `tests/round.test.ts` seats 40 and refuses the 41st, lets the 9th in (the exact student the old cap of 8 turned away), and holds a legacy room at 8. Source-proven and unit-tested; not re-run live | B |
| A round is 12 questions, not the whole set | `startRound` draws `questionsPerRound` (12 by default, 6 to 30 on request) rather than everything `buildQuestions` produced. `tests/round.test.ts` asserts a 30-word set now yields a 12-question round, that the band is honoured and out-of-band requests are pulled to the nearest end, and that the schedule is 12 slots long. The router refuses an out-of-band `questionsPerRound` with a 400. Not re-run live | B |
| Two rounds in a row do not ask the same questions | The room carries a cursor (`askedKeys`, kept off the wire) of every `itemId:direction` it has asked this cycle. `tests/round.test.ts` runs three rounds on a 20-word set (36 of the 40 possible questions) and asserts no key repeats, then runs a fourth and asserts it takes the 4 leftovers, restarts the cycle, and is still a full 12 questions. Not re-run live | B |
| A round the class never saw does not cost the set | The cursor advances at `endRound`, over the questions whose window had actually opened on the server clock at that instant, not at round start. A teacher who starts the wrong game and ends it loses nothing; ending it three questions in costs three words. `tests/round.test.ts` covers `/end` before `startsAt` (consumes nothing, and the next round redraws the same twelve), `/end` after 3 of 12 opened (consumes exactly those three), a full round (consumes all twelve), a recycle round ended inside its leftovers and again past the recycle boundary, and the legacy path, which never touches the cursor. Not re-run live | B |
| A teacher can end a round without destroying the room | `POST /api/rooms/:code/end` (host credential, same as `/round`) runs `endNow`, which writes the history row, banks the scores as they stand, and moves to `results`. `tests/round.test.ts` asserts the scores are banked unrecomputed, the roster survives, "pick another game" still works, and pressing it twice is a no-op, next to a `close` that is terminal. The RoomDO HTTP shell needs a Workers runtime to test, same as the host-key path, so the route itself is source-proven, not live | B |
| An abandoned lobby closes itself | `closeIfIdle` and `nextDeadline` now cover `lobby` at 30 minutes as well as `results` at 15. `tests/round.test.ts` asserts a lobby closes at the deadline and not a millisecond before, that a late join pushes it back, and that a lobby a finished round dropped the class into closes too. Not re-run live | B |
| The question list travels only during a round | `publicState` sends `questions` while the phase is `round` and an empty array otherwise, for a model 2 room; a model 1 room still sends them always. Measured in `tests/round.test.ts` for 30 players and 12 questions: 9,385 bytes mid-round, of which 7,522 is the player rows and 1,323 the question list. At the CONFIGURED MAXIMUM ROSTER of 40 players and 12 questions the same measurement is **11,895 bytes** mid-round (10,032 player rows, 1,323 question list), and the test pins an accepted ceiling of **12 KB (12,288 bytes)**. **The review asked for under 6 KB and that is not met**: a player row is ~250 bytes, so forty of them are ~10 KB whatever happens to the question list. Reaching 6 KB means slimming the player row (dropping `correctIndexes`, which no client reads, and sending `answeredIndexes` only for the polling device), which is a breaking wire change and a separate decision, not taken | B |
| Unanswered questions are charged at full budget for ranking | That abandoned room's ranking shows `totalMs` 64,000 for both players: 8 unanswered questions x the 8,000ms budget, with 0 time actually spent | A |
| Failing closed when the counter service is unreachable | The code path returns 503 rather than spending unmetered, but the failure was not forced live | C |

### The voice

Spoken audio is a ladder. Each rung is tried in turn and the first one that
produces sound wins, so the app is never silent because one provider is having a
bad day.

| # | Where the sound comes from | When it is used | Cost |
|---|---|---|---|
| 0 | This device's own **real** Mandarin voice (Web Speech API) | The device has one, and "Better voice" is off | free, offline, instant |
| 1 | **Azure Neural TTS**, `zh-CN-XiaoxiaoNeural`, from the worker | No real Mandarin voice here, or "Better voice" is on | free inside Azure's 500K-characters-a-month tier |
| 2 | **MeloTTS** (`@cf/myshell-ai/melotts`) via Workers AI | Azure has no key, is over quota, or is down | Workers AI neurons |
| 3 | Nothing plays; the word still shows its pinyin | Everything above failed | free |

**"Real" is doing work in rung 0.** macOS 26 tags eight novelty character voices
(Eddy, Flo, Grandma, Grandpa, Reed, Rocko, Sandy, Shelley) as `zh-CN` alongside
Tingting, and the browser hands them back first. The client keeps an allowlist of
voices worth reading a lesson in; a device that has only novelty voices is
treated as having none and goes to the server instead.

**Why Azure and not something newer.** Standard Neural voices accept full SSML,
which is the whole point for single words: `<prosody rate="-10%">` gives teacher
pacing, and a 120ms `<break>` on each side stops a one-word clip sounding
clipped. Azure's own HD voices, Google Chirp 3 HD and OpenAI TTS all drop
`<prosody>`. The full comparison, with grades and sources, is in
`docs/research/2026-09-08-natural-chinese-tts.md`.

#### Turning Azure on

Azure is **off until both secrets exist**. Nothing else has to change: with no
secrets set, the ladder simply starts at MeloTTS and the app behaves exactly as
it did before.

```
npx wrangler secret put AZURE_SPEECH_KEY      # Key 1 from the Speech resource
npx wrangler secret put AZURE_SPEECH_REGION   # the region short name, e.g. eastus
```

Create the resource first in the Azure portal (a "Speech" resource, pricing tier
**F0**, region `eastus`). The key is read from the environment, is never logged,
and never appears in a response. To turn Azure off again, delete the secrets
(`npx wrangler secret delete AZURE_SPEECH_KEY`) or set
`TTS_PROVIDER_ORDER` to `melotts`.

The voice, the pacing and the order are plain `vars` in `wrangler.jsonc`, so
changing any of them is a config edit and a redeploy, never a code change:

| Setting | Default | What it does |
|---|---|---|
| `TTS_PROVIDER_ORDER` | `azure,melotts` | Which rungs to try, left to right. An unknown name is ignored with a log; a list that names nothing usable falls back to the default, so a typo cannot switch audio off |
| `AZURE_TTS_VOICE` | `zh-CN-XiaoxiaoNeural` | Any **standard** Neural zh-CN voice. `zh-CN-YunxiNeural` is male, `zh-CN-XiaoyouNeural` is a child voice. HD voices reject `<prosody>`, so they would silence the pacing |
| `AZURE_TTS_RATE` | `-10%` | How much slower than natural. Learners hear one word with no sentence around it |

Changing the voice or the rate re-keys the clip cache, so no stale audio is
served after the change.

#### Listening to both

Compare the two voices on the same word without redeploying anything:

```
curl -o /tmp/azure.mp3   'http://localhost:8787/api/tts?text=苹果&voice=azure'
curl -o /tmp/melotts.wav 'http://localhost:8787/api/tts?text=苹果&voice=melotts'
open /tmp/azure.mp3 /tmp/melotts.wav
```

`voice=` only ever narrows what config already allows: it cannot call Azure
without a key, and an unrecognised value is ignored. Each variant is cached
separately, so an A/B listen never replays the other one's clip.

#### Still to do by ear

Nobody has listened to either voice yet. Before this goes in front of a class,
somebody should play a clip of each and confirm it sounds like Mandarin. Tones on
isolated words are the specific thing to listen for: a single word has no
sentence around it, so the model cannot use context to pick between readings of a
polyphone. If a word comes out wrong, Azure standard Neural voices accept
`<phoneme>` and `<lexicon>`, so that word's pronunciation can be pinned.

### A note on the local Cloudflare login

`wrangler ai models` fails on this machine with `Authentication error
[code: 10000]` because the stored OAuth token predates the `ai:write` scope.
That only affects the CLI listing command. The `env.AI` binding itself works
fine in `wrangler dev` and in production, as every A-grade row above shows.
Running `wrangler login` again refreshes the scope list if the CLI command is
wanted.

## Limits and costs

`/api/enrich` and `/api/tts` call Cloudflare's paid inference service and are
open to anyone with the URL, so they are metered. Nothing here is hardcoded in a
handler: every number lives in `vars` in `wrangler.jsonc`, is read by
`src/worker/policy.ts`, and can be changed and redeployed without touching code
(or overridden for one run with `wrangler dev --var NAME:VALUE`).

| Setting (`vars` name) | Default | What it does |
|---|---|---|
| `ENRICH_PER_IP_PER_DAY` | 30 | English-helper calls one device may make in a day |
| `ENRICH_GLOBAL_PER_DAY` | 600 | English-helper calls everyone together may make in a day |
| `TTS_PER_IP_PER_DAY` | 300 | Spoken-audio calls one device may make in a day |
| `TTS_GLOBAL_PER_DAY` | 4000 | Spoken-audio calls everyone together may make in a day |
| `ENRICH_MAX_ATTEMPTS` | 3 | Model calls one English-helper request may make before it gives up |
| `TTS_MAX_ATTEMPTS` | 3 | Model calls one spoken-audio request may make before it gives up |
| `MAX_ENRICH_ITEMS` | 40 | Words accepted in one English-helper request |
| `MAX_BODY_BYTES` | 262144 | Largest request the API will read at all (256 KB) |
| `GLOSS_CACHE_DAYS` | 30 | How long a translated word stays remembered |
| `MAX_GLOSS_ENTRIES` | 50000 | How many words the server remembers. At the cap the oldest are dropped |
| `ROOM_MAX_PLAYERS_TEACHER` | 40 | How many students fit in one class room. Read at create and carried by the room for its whole life. Never above 200, whatever is set here. A legacy "Race a friend" room ignores it and stays at 8 |
| `TTS_PROVIDER_ORDER` | `azure,melotts` | Which spoken-audio providers to try, in order (see "The voice") |
| `OCR_PROVIDER_ORDER` | `azure,workersai` | Which photo readers to try, in order. `azure` is skipped unless both its secrets are set, so this reads as Workers AI on an install with no Azure account (see "Add a photo or screenshot") |
| `OCR_PER_IP_PER_DAY` | 20 | Photo reads one device may make in a day |
| `OCR_GLOBAL_PER_DAY` | 300 | Photo reads everyone together may make in a day |
| `OCR_MAX_BYTES` | 4194304 | Largest photo the app will read (4 MB) |
| `OCR_TIMEOUT_MS` | 20000 | How long one photo reader has to answer before the app gives up on it |
| `AZURE_TTS_VOICE` | `zh-CN-XiaoxiaoNeural` | Which Azure standard Neural voice reads the words |
| `AZURE_TTS_RATE` | `-10%` | How much slower than natural Azure reads them |

A value that is not a positive whole number is ignored and the built-in default
is used instead, so a typo in config cannot switch a spending cap off.

**The daily caps count model calls, not requests.** One request is not one call:
the English helper tries the main model, retries it, then falls back to a smaller
model, and spoken audio retries a flaky model up to three times. A cap that
counted requests would therefore not be a cap on what the app can spend. So
before either route runs, it puts the worst case for that route
(`ENRICH_MAX_ATTEMPTS` or `TTS_MAX_ATTEMPTS` calls) on hold against both the
per-device and the shared budget, and gives back whatever it did not use as soon
as it is done. The normal case, where the model answers first time, costs exactly
one call. A request that burns every retry is charged for every retry. The one
visible side effect: a route is refused when fewer calls remain than its worst
case, so the last two or three of a day's budget may go unspent.

**A repeated word is free.** Audio is cached at the edge by the word itself, and
translations are cached on the server for 30 days. Both caches are checked
before anything is counted, so the second class to ask for 苹果 costs nothing and
does not use up anybody's daily turns. Only a genuinely new word is charged.

### What a 429 looks like to a teacher

When a daily limit is reached the API answers `429` with one plain sentence and
no jargon, and the app keeps working:

```
{"error":"You have used up today's English-helper turns on this device.
          Type the English in yourself, or try again tomorrow."}

{"error":"You have used up today's spoken-audio turns on this device.
          Your device's own voice still works, and audio comes back tomorrow."}
```

There is a matching pair for the shared daily limit ("...has hit today's limit
for everyone"). In both cases the games still generate and still play: the
English helper is a convenience over a review table the teacher can type in, and
server audio has this device's own voice underneath it wherever there is one.
If the counter service itself cannot be reached the API answers `503` and
refuses the call rather than spending unmetered.

Requests are also capped in size before they are read: a body over
`MAX_BODY_BYTES` gets a `413` and is never parsed, and a room whose set and
questions serialize past the same cap is refused.

## Free-plan limits

Cloudflare's free Workers plan allows 100,000 requests per day and Workers AI
allows 10,000 neurons per day. When either runs out:

- **Requests exhausted**: the Worker stops serving until the daily reset (UTC
  midnight). The whole site is down, including the games, not just the API.
- **Neurons exhausted**: only the two AI routes fail. `/api/enrich` returns every
  gloss as an empty string plus a `warning`, so the teacher types the English in
  the review table and the games still generate. `/api/tts` returns 502 and the
  client falls back to the browser's own voice. Nothing crashes.

**`/api/tts` retries a failed model call, but only a failure worth retrying.**
MeloTTS fails non-deterministically on a small fraction of otherwise-identical
calls (live-verified 2026-09-07: 2 of 20 identical `text=苹果` requests came back
502). A call that throws, or comes back empty, is tried up to `TTS_MAX_ATTEMPTS`
times (backing off 150ms then 400ms) before the route gives up and returns 502.
A call that comes back in a shape the worker cannot read is a different thing: the
same word would produce the same unreadable answer, so it stops after one call
instead of paying twice more for the same failure. Only a clip that actually comes
back is ever written to the edge cache, and only the attempts actually made are
charged (see "The daily caps count model calls, not requests" above).

**The audio cache can never cause an error.** The edge cache is an optimisation,
so its read and its write are guarded separately. If either fails, the request
degrades to a normal cache miss (one budgeted synthesis) and the teacher still
gets audio; a cache fault never turns into a 500.

The daily caps in the table above exist so that nobody on the internet can drain
the neuron allowance with a loop the morning of a lesson. The defaults are set
well under the free-plan allowance, and the two caches mean normal classroom use
barely touches them.

Polling is the main request consumer: one player polls once per second while
playing, so a 30-question race with 2 players costs a few hundred requests. A
classroom will not come close to the daily cap.

## Layout

```
src/shared/    types.ts, quiz.ts, room.ts (pure room reducer), round.ts (per-game
               rules: slots, climb, chest cards, picks), cpu.ts (seeded solo
               opponents), rng.ts, parse.ts (row reader), extract.ts (the layer
               above it: free text -> words), stopwords.ts (what the free path
               throws away), share.ts
src/client/    the SPA
src/shared/    ... plus cedict.ts (CC-CEDICT parsing + gloss selection, shared by the
               build script and the tests)
src/worker/    index.ts (router), enrich.ts, extract.ts (/api/extract, the
               dictionary-checked model rescue and its in-isolate cache),
               dict.ts (the CC-CEDICT asset, loaded once per isolate), tts.ts, room-do.ts (room Durable Object),
               persist.ts (room DO storage), quota-do.ts (the one spend-counter and
               gloss-cache Durable Object), quota.ts (its counting/caching logic),
               policy.ts (every limit, read from vars), pure.ts (validation, room
               codes, gloss parsing)
scripts/       build-cedict.mjs (data/cedict.txt.gz -> public/cedict.json)
data/          cedict.txt.gz, the committed CC-CEDICT source dump
tests/         vitest, no browser needed
tests/fixtures/teacher-pastes/
               36 real paste shapes, each a .txt beside a .expected.json
docs/evidence/ live runs, with what was proved and what was only assumed
```

All room rules live in `src/shared/room.ts` as a pure reducer. `RoomDO` is only
persistence, HTTP, and alarms wrapped around it, which is why the rules are
testable without a Workers runtime.

### What the tests do and do not cover

`tests/worker.test.ts` exercises the real validation, room-code, gloss-parsing,
policy-reading, quota-counting, gloss-caching, and storage code, including a room
surviving the Durable Object being evicted mid-race (an in-memory fake stands in
for DO storage in both cases). It does **not** exercise the Durable Objects' HTTP
shells, `blockConcurrencyWhile`, or their alarms: those need a Workers runtime
(Miniflare or `@cloudflare/vitest-pool-workers`), which would mean adding a
dependency. They are covered by the live `wrangler dev` checks in the table
above instead.

`tests/extract.test.ts` runs all 39 pastes in `tests/fixtures/teacher-pastes/`
against **the real `public/cedict.json`**, 177k headwords, not a fake. That is
deliberate: a stub dictionary would pass the file while the deployed extractor
kept failing, which is exactly the gap that let the one-giant-word bug ship. Each
fixture names the words that MUST come out (and must arrive WITH an English
meaning, because `src/client/build.ts` drops a word that has none) and the
strings that must NOT. Most fixtures pin no exact count, so a segmenter that
finds one extra real word is an improvement rather than a failure. Three of them
(37, 38, 39) do pin one with `maxItems`, because on those shapes an extra word is
the bug itself: a heading read as vocabulary, a repeated row kept whole.

Adding a shape is two files and no code: drop `my-shape.txt` and
`my-shape.expected.json` (`{ "why": "...", "must": [...], "mustNot": [...] }`,
plus optional `mode`, `minItems`, `maxItems`) into that folder. The suite picks
it up. Run it on its own with `npx vitest run tests/extract.test.ts`, which
prints a table of what every fixture produced.

The model rescue on `/api/extract` is pinned by tests but has **not** been fired
live: no paste in the 2026-09-08 run was poor enough to trigger it. What the
tests do pin is what it cannot do, and what it costs a second time. A word that
is not all Chinese, or is one character, or is a stopword, or is absent from the
teacher's own paste, or that CC-CEDICT does not know, is dropped: a model on this
path can propose but never invent, and cannot put grammar on a card either. The
same paste twice in one isolate is one model call, empty answers included.

