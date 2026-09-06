# Child studio browser verification

The application is `web/index.html`, `web/studio.css`, `web/studio.js`: plain HTML/CSS/ES
modules, no CDN, npm runtime dependency, inline executable HTML or replacement server.
The real host must serve `/paper-director/` and `/paper-director/static/*`, and provide
the same-origin API described in `docs/contracts.md`.

## Run browser tests

From the repository root, install the isolated test dependency (nothing is added to
root package.json):

```sh
npm install --prefix tests/ui/.deps --cache tests/ui/.npm-cache --no-save --ignore-scripts playwright
node --check web/studio.js
node --test tests/ui/studio.test.mjs
```

Windows tests use already installed Microsoft Edge. On other platforms, install a
Playwright-supported Chromium separately or set `PAPER_DIRECTOR_BROWSER` to an already
installed Chromium executable. No browser download is performed by the tests.

All page and API requests are intercepted with Playwright routes at a loopback origin.
**No HTTP server is started**, and no requests reach the real DSH instance, cloud API,
private recording, microphone, remote website, or filesystem API. The synthetic PNG
puppets and oscillator tones are generated locally and dedicated to CC0-1.0.

The browser MediaRecorder test uses the **real browser MediaRecorder**, but replaces
getUserMedia with a generated Web Audio oscillator stream. It never requests real
microphone permission or records a person. A deliberately failed upload retains the
same Blob, exposes a retry control, and successfully reuses the recorded bytes.

## Recorded verification

Latest local Windows/Edge run: `node --check web/studio.js` succeeded and all **3/3
browser journeys passed** (10.805 seconds, zero failed/skipped). Desktop and mobile
screenshots were opened and visually inspected. The mobile overflow assertion passed.

## Verified scenarios

- New project, title/story/credits, ordered photo binary uploads and revision headers.
- Stable scene/dialogue IDs through reordering; dialogue/action/thought-bubble editing.
- One complete audio upload and recordingAssetId association, never per-scene recording.
- Explicit manual start/end markers and extra speech; `engine: "segments"`, no invented
  ASR claim. Automatic alignment omits engine so the host selects configured local ASR.
- Job polling/cancellation, result refresh, relative same-origin movie asset URL.
- True Agent requests for creation and natural-language changes; direct render never
  masquerades as Agent work. Missing Agent/model/worker readiness disables unavailable
  actions and shows honest explanations.
- Missing/null dialogue times block render; stale PATCH returns 409, refreshes the
  project and does not retry an overwrite. History restore supplies expectedRevision.
- Script-like author text is rendered as text, not HTML; internal server error paths
  are not displayed. Audio/video play events pause the other player.
- Real MediaRecorder with synthetic stream, upload failure preservation and retry.
- Desktop 1440px and mobile 390px screenshots; mobile has no horizontal page overflow;
  no browser pageerror events in all test journeys.

Outputs are ignored under `tests/ui/.artifacts/`: `studio-desktop.png`,
`studio-desktop-top.png`, `studio-mobile.png`. They show a **mock-API UI**, not a deployed
DSH application. The movie source assignment is tested, but the mock does not provide
an encoded movie: real H.264/AAC playback/ASR/Agent completion is not claimed by this
UI suite. Independent actual media encoding evidence lives in the Python tests.

## Integration contract

Health is `{render:{ready}, alignment:{configured,engine}, agent:{configured},
narration:{configured}, worker:{available,missing}, version}`. Jobs endpoints return
an array / job directly inside the normal `{ok:true,data}` envelope. POST assets returns
`{project,asset}`; PATCH returns Project. Agent POST returns `{sessionId}`. Completed
render jobs return `{assetId,preview,inputRevision,applied}` and the project exports list
contains movie entries with `assetId`. The browser only refreshes successful-job results
when no unsaved edits, operation or recording would be overwritten.

The UI deliberately does not expose local paths, API keys, model selectors or shell.
Manual markers are a collapsed adult-help fallback. Received warning text uses
textContent; path/key-looking configuration warnings are replaced with a child-safe
message. No raw server error stack/message is displayed.

## Known limits / host responsibilities

- A real host must enforce auth, project scope, source/asset ownership, job budgets,
  revision consistency and immutable media. UI controls are not a security boundary.
- Agent submission returns only sessionId. The UI can truthfully report submission and
  observe subsequent jobs, but cannot display asynchronous Agent chat/failure details
  without an additional host event/status contract. It never reports submission as a
  completed movie.
- Manual timing maps entered author text to explicit supplied transcript segments.
  Adults must verify what was actually said; this is not automatic recognition.
- Microphone recording requires a secure browser context (localhost or HTTPS). A local
  pending recording survives upload failure only while this page remains open; navigation
  is guarded, but it is not persisted across browser crashes.
- Tests use mocked API responses, not live DSH HTTP deployment. The parent-owned host
  still needs same-origin deployment and real end-to-end integration verification.
