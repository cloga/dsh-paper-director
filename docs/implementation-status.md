# Implementation status / continuation checkpoint

## Goal and repository

- Product: 纸上小导演 / `dsh-paper-director`.
- Fixed workflow: child’s idea → ordered photographs → dialogue/action notes per image → ONE complete recording → agent enrichment → review/edit/export. No mandatory per-scene recording.
- Repository: https://github.com/cloga/dsh-paper-director
- Tracking issue: https://github.com/cloga/dsh-paper-director/issues/1
- Branch: `feature/issue-1-paper-director-mvp`; discovered default branch `main`.
- Round 1 checkpoint `7e944c1` is published on the feature branch. This document now records round 2. **Overall goal remains ACTIVE; not a final release.**
- No family photos, real child recordings, private films, credentials or machine-user paths in source. Fixtures are anonymous generated geometry/tones; data/artifacts/dependencies ignored.

## Implemented through round 2

### Application core and real HTTP

- `src/core/model.js`, `store.js`, `timeline.js`: stable IDs, author-controlled content, SQLite revisions/CAS/restore, project-scoped immutable assets, protected pause proposals/ripple edits, inserted magic/time/action scenes, shared authoritative timeline.
- `src/core/service.js` is now implemented (it was missing at round-1 checkpoint): full public dispatch facade, scope validation, trusted Session bindings, readiness, binary imports with probe, durable bounded queue, alignment/render/narration jobs, cancellation, restoration and stale-result handling.
- `src/http.js`: real project/assets/align/render/narration/edits/jobs/agent routes and static app. Auth remains `index.js` → `connection.requestRejection()` for EVERY route. Additional strict Origin/method/MIME/body/query/schema/path checks; Range/HEAD support; no private path/config DTO fields.
- Upload budget is acquired **before reading request bodies**: at most 2 per Core, 1 per project, each reserves maxAssetBytes even without Content-Length. Core independently caps direct imports at 2.
- SQLite runtime lease prevents a second live owner of the same dataDir from interrupting active jobs. On a real restart, queued/running jobs become interrupted, never silently reissued.
- Queue slots reserved before async admission; per-project job cap and request-key dedupe are transactional. Session-bound tools cannot select another project; an empty/extra-field scope is rejected.
- Successful alignment/render/narration result and project mutation commit in ONE SQLite transaction via `finishJobInMutation`. Cancellation before commit makes no project mutation; cancellation after commit cannot label the completed job cancelled.
- All job initialization lies inside error handling; fixed safe diagnostics, sanitized progress/warnings, terminal states. Temp job outputs removed after settlement. Generated files are size-checked and read bounded before asset import. Historical asset quota uses ALL persisted assets, not the restored revision’s current array.

### Media runtime, sound, recording clocks

- `src/core/worker.js`: fixed Python `-I` entry, no shell/credential environment, serial semaphore including health/import calls, bounded tasks/timeouts/result/progress, trusted test-only spawn DI.
- Output monitor checks only owned movie/frame/result files every 100ms, default media 100MiB/result8MiB. TERM→2s KILL→bounded fail-closed if no acknowledgement. This is a **soft resource cap**, not an OS sandbox/disk quota; native unkillable behavior was stub-tested, not claimed physically impossible.
- Independent Python: safe probe/full bounded validation; supplied-segment alignment; optional local Whisper/Vosk (no auto-download/cloud voice upload); Pillow paper/comic frames; shared frame/video painter; H.264/AAC limited-range BT.709.
- `maxDuration` overlays are now truly limited and faded; reused sound prefixes decode once and release. Actual cue images only, LRU4 output-sized rasters, thumbnail before full-size copies. Single composed-frame reuse for static video states; dynamic magic/fade repaint.
- Chinese titles/outros show director AND voice credits and “完 / 谢谢观看”; last frame fades black without shortening configured outro. English projects retain English labels/font requirements.
- Browser MediaRecorder exposed a real intermittent Opus timestamp/sample mismatch under full test load. Fixed probe’s authoritative audio-only duration to the decoded-sample clock (same order used by alignment/mixer); preserve container/timestamp duration metadata for diagnostics. Tests encode an Opus timestamp gap and AAC padding explicitly. No real decoded audio samples are dropped to match container metadata.
- Built-in original synthesized magic/time effects in `src/core/sounds.js`; generated sound data CC0-1.0. Explicit imported effects override them; `style.soundEffects:false` disables SFX. No Internet sound downloads needed.
- Preview actually scales down while using the same painter/timeline; full export uses project size. Renderer clipping/padding/fade warnings now propagate as fixed safe DTO diagnostics.

### Narration, tools and DSH

- Azure text-only adapter implemented in `src/core/tts.js`: adult opt-in, fixed validated regional Microsoft host, no redirects, escaped SSML, 500-char requests, PCM24k mono verification, no POST retry.
- Core reserves a persistent 5000-char/day safety budget before a request. Remote-attempt stage persists; after a POST, any ambiguous transport OR local persistence/cancellation failure becomes `TTS_UNCERTAIN`, blocking duplicate charges. Definite auth/rate-limit refusals remain distinct. Completed narration blobs can be relinked after a restore without paying again. This budget does NOT cover normal DSH model calls.
- `index.js` Host Service, restricted `src/tools.js`, tiny React ModuleLoader sidebar entry, bundle and preset are implemented. Agent starter fixes preset `paper-director`, mounts and binds BEFORE followup; no privileged fallback or model-exposed starter.
- Formal Core API range contracts aligned: pauses .25–3 seconds, 500-char narration, reserved character IDs rejected, 2048 dialogue maximum, raw audio metadata max600s vs derived videos max900s; FLAC supported consistently.
- Preset installer / real tarball checker / CI and install documentation implemented. `files` now explicitly whitelists Python SOURCE files: prior broad `python` rule incorrectly packed pycache despite gitignore; this is fixed.

### Studio / evidence

- Child Web studio implemented (story/characters/photo-dialogue/action/whole-recording/recording retry/manual markers/jobs/movie/feedback/history). UI field updates use changed fields only; user strings use textContent/value. No public/CDN dependency.
- Honest privacy notice: raw audio remains local, but story/dialogue/transcription text goes to the adult-configured DSH model after choosing the Agent (which may be cloud). A restricted Agent is NOT a child-account/OS/browser sandbox; same DSH login retains host permissions. Initial version requires adult-supervised single-family/local use.
- `scripts/demo.mjs` + `demo-media.mjs`: genuine Node Core→Python import/align/render/edit/re-render demo. Generated tones with explicitly provided marker text, not ASR inference. Latest run produced 7.8s→6.6s films, removed1.2s; artifacts in ignored `.test-output/demo`.

## Verification actually completed

Latest complete round-2 run:
- `npm test` with actual linked SDK: **98 tests, 97 passed, 0 failed, 1 explicit Windows file-symlink EPERM skip**. Includes real Cordis Host lifecycle, 19 HTTP contracts/budget tests, real Core pipeline, security regression tests, actual SDK schema/bundle parsing, installer/tarball and worker kill/output-limit tests.
- Python `unittest discover -s tests/python -p 'test*.py'`: **36/36 passed** (original16 + audio resource11 + presentation7 + audio clock2).
- `npm run check`: real package tarball **37 regular files**, resources/exports/ModuleLoader/privacy checks pass. Do not pin archive hash while sources change.
- Real browser HTTP test **NO Playwright API route mocks**: actual PNG/WAV uploads and probe, explicit markers, real render, native MP4 playback, protected pause confirmation/edit/re-render, 206 Range, actual MediaRecorder oscillator recording→real WebM/Opus upload/probe/align/render. Actual browser CSP had zero errors. Fixture cookie auth, NOT real DSH cookie cryptography. Evidence `tests/ui/.artifacts/real-http/evidence.json`, screenshot `movie.png`.
- `tests/dsh-live.test.mjs`: real installed Cordis mounts the actual Host class (not a stripped stub), real SQLite works, registered routes reject unauthenticated requests via delegated test connection, dispose unregisters service/routes and releases DB lease. Carrier/auth implementations are test doubles; no production DSH was changed.
- UI mock journeys were previously 3/3; rerun after final UI changes. Generated MediaRecorder stream uses no microphone.
- Root SDK direct dev installation: Node24.19, DSH0.1.2-rc.1, Cordis4.0.2, Schemastery3.18.2, React19.2.8. Cordis4.0.2 registry install returned ETARGET; explicit version-checked `scripts/link-sdk.mjs` links only ignored local node_modules, no downgrade/mirror.
- CI now has Node22.19/24 contracts, Python/CJK anonymous media, and browser+realHTTP job using pinned Playwright1.63.0. CI remote execution is NOT yet observed; check after push.

## NEXT — finish the Agent product loop before final release

### A. Asynchronous jobs must wake the correct Agent

Current tools return custom Core jobs; UI polls them, but **there is no completion notification to the producing DSH Agent yet**. Without it, an Agent may stop after paper_align and never schedule render, or busy-poll and waste model calls.

Implement Core job→trusted originating Session subscriptions before jobs can finish, then a Fiber-owned Host callback that wakes only the bound live Agent on relevant completion. Never let models supply Session IDs. Suggested tool-side scope extension: trusted `exec.agent.session.id`, validated against project binding; keep admin-fixed project tools separate from studio-created sessions. Dedupe (jobId,sessionId) notices. No automatic cold resume/create or more powerful preset. Avoid a render-success→render-again notification loop: message must describe kind/status and stop after completed export, or do not wake for successful render (UI can report it).

Actual SDK facts (installed module paths below are relative to `node_modules/@deepseek-ai`):
- `dsh-agent/lib/index.js:684–691`: `ctx.agents.get(sessionId)` returns live Agent|undefined, NOT handle. create/resume return handle.
- `dsh-agent-loop/lib/index.js:395–403`: `agent.followup(message)` queues next turn and wakes driver. Construct via `createUserMessage({content:[{type:'text',text:boundedStatus}],source:{kind:'plugin',plugin:'dsh-paper-director'}})`.
- Check binding before AND after awaits; only minimal jobId/kind/status in notification, no path/error or entire live objects.
- `ctx.on` is Fiber-owned; custom Core listeners should return disposer and be owned by `ctx.effect`. No SDK `subscribeLifecycle` exists.

### B. Show Agent replies and explicit edit confirmations in the child page

Current `/agent` POST returns only sessionId; page cannot show a later assistant clarification/failure if no media job appears. Add bounded read-only Agent status/reply endpoint and UI polling that does not overwrite dirty edits.

SDK read contracts:
- `agent.status` is ONLY idle|running (loop:385–393); idle is NOT movie completion.
- `sessionPersistence.inspect(id,signal?)` in this exact SDK returns `{meta,inheritedEventCount,events}`; supports live/cold readonly view, may synthesize interrupted closures IN MEMORY. No `session.getSnapshot()` method.
- Relevant events: `assistant/message` → `e.data.message`; keep role==='assistant' AND m.source.kind==='model'; take ONLY content blocks type==='text', bounded e.g.8k chars. Do not expose reasoning/chunk/tool/result/user/plugin prompt. Read leaf seq/id/text/interrupted only; NEVER serialize view/events/Message/Session wholesale.
- To exclude replaced/compacted historical surfaces, use live `session.surface.nodes` + eventAt, or official `foldSurface(view.events).nodes` then leaf selection. `deriveMessages()` also returns shared internals, not dumpable.
- `turn/end` e.data.reason.kind includes completed/aborted/blocked/error/max-tokens/interrupted. Read reason kind, not raw error payload. Waiting-human comes from Core pending proposals; movie complete from Core exports/jobs.
- `agentPresets.resolve('paper-director')` and defaultModel.currentSelection are readonly health checks, BUT resolve can return preset.broken; check it. This proves configured only, not real mount/auth. Do not use standingKeyFor in health (it mounts).

Do not expose ordinary administrator session history to the child UI. Only sessions newly created by the studio and bound by the Host should be readable in that UI; an admin-fixed tool binding is not blanket permission to publish that session’s previous conversation.

All actual alignment methods (`provided_segments`, `local_whisper`, `local_vosk`) currently require explicit human confirmation for gap deletion because transcript gaps alone do not verify silence. HTTP supports `allowUnmatchedSpeech:true`, model tools always false. **There is no pending-proposal confirmation UI yet**: add persisted proposal/review metadata and a small playback+confirm interaction (or equivalent) so the Agent can request review without telling children to craft HTTP JSON.

Add a compact rendered-time index or a scoped scene-at-time tool for natural feedback. UI movie time includes intro/insertions/edits, while project.alignment is source-recording time; do not make the model guess. Use the actual viewed export revision/asset identity. Silent action scenes currently insert2s; consider optional hold/scene markers for adjustments, but do not expand into a full multitrack editor.

### C. Remaining installation and release validation

- Actual tarball+installer+DSH bundle resolver are verified; **not yet a real profile pnpm install with packed entry loaded under the production module resolver**, nor a full restricted model turn. Verify in isolated/temp profile only, do not change current GUI/DSH/shipped presets. Parent actual Cordis test uses explicit SDK links; do not pretend that proves fresh profile dependency resolution.
- New profiles have autoInstallPeers:false/nodeLinker:hoisted. Existing profiles may differ. Current SDK dev deps unpublished; do not downgrade. Check install instructions against actual CLI.
- Real ASR inference/accuracy untested without administrator-provided weights; only adapter/readiness and provided-marker path verified. If validating real ASR, use public existing model weights and newly synthesized anonymous speech, not private family audio; no unauthorized cloud call.
- General scene-bound Azure narration is not yet linked; style.narrationAssetId currently means INTRO narration only. A simple sceneNarrations association/time-card duration extension is possible. Do not promise time-card speech if not implemented.
- `makeAgentStarter.ready` preflight not wired yet, although Core supports a ready callback. Update it to avoid UI claiming configured when preset missing/broken.
- Re-run full tests, actual HTTP browser flow, package and install/preset checks; review source/privacy before final publication. Open PR fixing #1 after complete scoped verification, observe CI, address review, merge via normal workflow and verify exact remote SHA. Default branch currently still initialization; feature branch holds development checkpoints.
- Final README must clearly state supported environments/limits and supervision scope; remove WIP only after complete loop is actually verified.

## Boundaries and operations

- No current DSH server/profile, shipped preset or deployment source modified. Test servers are ephemeral loopback fixtures and are always closed; they do not replace the existing GUI.
- Public sources have no developer-machine absolute paths or private media. Do not stage .venv/node_modules/.deps/.artifacts/.test-output/SQLite/media outputs. Exact npm files whitelist is necessary; a broad python directory whitelist previously leaked pycache.
- All child agents completed assigned tasks; all their background jobs were collected. Main owns continuation integration and GitHub delivery.
- Credential instructions remain user-level: only designated GH_TOKEN file, process-local official HTTPS headers, verify cloga before writes, TLS on/redirects off, no default-branch push. Delivery helper scripts are outside this repo.
