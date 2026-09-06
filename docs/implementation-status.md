# Implementation status / continuation checkpoint

## Goal and repository

- Product: 纸上小导演 / `dsh-paper-director`.
- Fixed child workflow: idea → ordered photographs → per-photo dialogue/action notes → ONE complete voice recording → agent enrichment → review/edit/export.
- GitHub repository: https://github.com/cloga/dsh-paper-director
- Tracking issue: https://github.com/cloga/dsh-paper-director/issues/1
- Working branch: `feature/issue-1-paper-director-mvp`; default branch discovered from GitHub is `main`.
- This is an implementation checkpoint, **not a finished/installed/released plugin**. Do not mark the overall completion goal done yet.
- No private reference-family photos, recordings, personal movie outputs or credentials are included. All media tests use generated geometric pictures and synthetic tones.

## Implemented and verified in round 1

1. `src/core/model.js`: bounded author fields, stable IDs, controlled palette, asset references, immutable original intent. Presentation/name changes preserve alignment; recording/dialogue/order changes invalidate it.
2. `src/core/store.js`: Node built-in SQLite (Node 22.19+), immutable revisions, optimistic revision checks, restore-as-new-version, immutable project-scoped assets, basic durable job records and interrupted-job recovery.
3. `src/core/timeline.js`: alignment validation (author identity separate from ASR), missing/null lines block rendering, explicit unmatched-speech confirmation, protected pause proposals and ripple edits, conservative source-audio-preserving compiler with inserted magic/time/silent scenes.
4. `src/core/worker.js`: fixed Python CLI bridge, `-I`, no shell, bounded timeout/output, stripped credential environment, offline model flags, cancellation, safe result-path resolution. Added trusted local package path in `python/worker.py` so `-I` works without inheriting caller PYTHONPATH.
5. Python worker: probe, provided-segment alignment, optional fully local Whisper/Vosk, render/frame using same Pillow painter, comic speaker captions, paper framing, magic/time cards, intro/outro, sample-accurate mixed timeline, H.264/AAC limited-range BT.709. `requirements.txt` and optional ASR requirements provided.
6. DSH adapter: `index.js`, `src/tools.js`, `lib/client.js`, bundle patch, restricted preset resources. Real Host HTTP fence delegates to `connection.requestRejection()` for every static/API/media request. No Host-global model tools. Dedicated tools restrict inherited global tools and use trusted session→project binding (or administrator-fixed projectId); models cannot select arbitrary projects or permit unmatched-speech deletion.
7. Host Agent-start callback: fixed `paper-director` preset, actual agents.create/setup.mount APIs, trusted binding before followup, disposal on delivery failure. Not yet connected to real HTTP Core service or exercised in a real model turn.
8. Child Web studio: `web/index.html`, `studio.css`, `studio.js`. Ordered photo cards, character/dialogue/action fields, full file/MediaRecorder audio, optional manual per-line markers, real Agent endpoint intent, jobs/video/version/conflict UI, no secret or shell UI. All API behavior currently browser-tested with route mocks, not an integrated server.
9. `scripts/link-sdk.mjs`: explicit version-checked development link to an installed DSH node_modules. Only ignored repo node_modules is changed.

### Test evidence

- `npm test` with actual installed SDK root configured: **26/26** pass (10 core, 13 DSH contracts, 2 actual SDK schema tests, 1 real isolated Python bridge health test).
- `node --test tests/ui/studio.test.mjs`: **3/3** mocked browser journeys pass, including real MediaRecorder over a generated oscillator (no microphone), failed upload retry, XSS/conflict/cancel/restore.
- Repository `.venv` prepared with `requirements.txt`; `python -m unittest discover -s tests/python -p test_worker.py -v`: **16/16** pass.
- Anonymous Python CLI demo renders an actual MP4 (640×480, 12fps, 66 frames, 5.5s), probes and decodes it, checks frame equivalence and color metadata. This is a media-worker demo, **not yet a Node/HTTP/DSH end-to-end demo**.
- `.venv`, `node_modules`, `tests/*/.deps`, screenshots/test movies and test data are ignored. Do not accidentally add them.
- A scan of intended source/docs found no reference-family names, private project title, machine user path or GitHub token pattern.

## Compatibility facts (do not guess or downgrade)

- Actual deployment packages: DSH **0.1.2-rc.1**, Cordis **4.0.2**, Schemastery **3.18.2**, React **19.2.8**.
- `npm install` failed with **ETARGET for @deepseek-ai/cordis@4.0.2**, not TLS/network failure. Do not switch to 4.0.1 silently. Explicit local SDK linkage succeeded and all actual schema tests passed.
- New DSH profiles set `nodeLinker: hoisted` and `autoInstallPeers: false`; old profiles may differ. Actual package installation/peer resolution still needs a temporary-profile smoke test.
- `dsh.bundle.patch` + a Cordis Host row activates the package. There is no verified `dsh.host` shortcut.
- Client is a tiny ModuleLoader CJS factory requiring runtime React, registered in `sidebar.footer.action`. No replacement server or DSH shell bundle.
- Custom webServer routes are NOT automatically authenticated; current `connection.requestRejection()` includes cookie and Host/Origin defenses. Never copy the weaker old cron fence.
- Preset resources inside the npm package are NOT auto-discovered. Need explicit safe installer or documented user-root copy, no postinstall and no shipped-preset edits.

## NEXT: integration work still required

### 1. Core facade and HTTP API — highest priority

**`src/core/service.js` and `src/http.js` do not exist yet.** Thus the package entry cannot be installed/run as a complete plugin today. Implement the interfaces in `docs/contracts.md` and expected by `index.js`/`src/tools.js`/Web UI.

`PaperDirectorCore(config)` must expose:
- async init(), idempotent async close() (also safe after partial init);
- setAgentStarter(fn | undefined);
- async bindSession(sessionId, projectId), async bindingForSession(sessionId) → projectId string;
- dispatch(operation,args,scope?) → sanitized owned DTO, never asset internal paths/config/keys;
- health() / equivalent for HTTP.

Dispatch names and arguments already used by tools:
- project.get `{}` with scope.projectId;
- project.update `{expectedRevision,patch}`;
- recording.align `{expectedRevision,engine?,segments?}`;
- movie.render `{expectedRevision,preview?}`;
- job.list `{}` / job.get `{jobId}` / job.cancel `{jobId}`;
- timeline.propose/apply `{expectedRevision,operation:{type:'shorten_pause',afterDialogueId,beforeDialogueId,targetSeconds}}`; apply recalculates proposal and tool-side allowUnmatchedSpeech is always false;
- narration.generate `{expectedRevision,text,voiceProfile?}`.

HTTP is fixed `/paper-director/` and `/paper-director/api/...`; return envelopes exactly as contracts. `GET health` shape expected by UI:
```js
{ version:'0.1.0', render:{ready}, alignment:{configured,engine}, agent:{configured}, narration:{configured}, worker:{available,missing:[]} }
```
UI auto-align omits engine (Host chooses), manual uses `segments`. POST authenticated human `/projects/:id/agent` `{expectedRevision,prompt}` calls registered starter, returns sessionId. Tool dispatch must NEVER expose this starter or binding mutation. File upload is raw bytes + headers; no filesystem path argument. All static and media routes flow through DSH fence before this handler; still enforce method/content-type/body limits/project ownership and safe static paths, Range media.

### 2. Jobs, import and narration

- Durable bounded single-worker queue, proper progress/cancel/timeout/disposal, restart state and stale-revision handling. SQLite currently marks queued/running jobs interrupted at init; investigate single-dataDir ownership/live parallel profile safeguards before claiming robust multi-process use.
- `MediaWorker.run()` receives unique outputDir and returns worker `result`; probe metadata has actual `kind,mime,format,...`, never trust uploaded extension (including audio in mp4 containers).
- Strip empty dialogue placeholders from align request scenes; Node validateAlignment author list excludes empty text, whereas Python align includes all supplied lines.
- Worker health returns dependencies/codecs/fontReady/cjkReady/modelReady/models/ready; project UI only gets whitelisted booleans and safe error codes. Chinese render needs cjkReady, not just fontReady.
- Render/frame worker result is `{path:'movie.mp4'|'frame.png',...}`; validate and register derived assets under project before exposing.
- Align result is full alignment plus `path:'alignment.json'`; preserve author text, bounded warnings, and unmatchedSpeech. Real ASR adapters implemented but inference/quality NOT yet tested; only existing administrator model paths are allowed, no silent download/cloud voice upload.
- Azure text-only narration is not yet implemented in core. Disabled by default; server env credential only, region validation, bounded text/day limits, request idempotency/uncertain-call handling. Do not read another private repository’s .env in this product.
- Currently style.narrationAssetId is interpreted by compiler as intro narration; general scene-bound narration/time-card placement needs a clear extension if included in first release. Do not promise automatic time-card speech if not implemented.
- Add curated/generated licensed sound catalogue/service; do not point children at arbitrary Internet downloads.

### 3. Integrated acceptance and distribution

- Add real Node→Python synthetic project E2E (import → author scenes → align → render → edit → render revised movie), actual HTTP upload/Range, concurrency/security/unknown-speech tests.
- Exercise actual Cordis service mounting/unmounting and a real restricted preset scope. Existing adapter tests use contracts/stubs plus real SDK schema, not a full live Host.
- Add explicit user-preset installer tested only in temporary roots, package inspection (`scripts/check-package.mjs` currently missing), demo CLI (`scripts/demo.mjs` missing), CI and complete install instructions.
- Verify npm pack whitelist and local temporary-profile installation without altering current DSH or shipped presets.
- Review source for credentials/private content; commit intended files, push feature branch, open/review/merge PR under normal safeguards, and verify GitHub delivery. Repository currently has only initialization on default branch; release is pending.
- Update README to remove WIP warning ONLY after the complete workflow is actually verified.

## Session continuation notes

- Main session owns core facade, HTTP, packaging/CI and GitHub delivery. All implementation subagents have completed their tasks; no shared-file writes should still be running.
- Current workspace is separate from this repository; always pass explicit workdir for Git/build commands.
- GitHub account was verified as cloga. Use only the designated user credential file via process-local headers; never put credential files in this repo. Session-local delivery helpers are outside the repository.
- Git clone initially reset during upload-pack; one bounded retry succeeded. No TLS bypass, mirror, VPN loop or global Git config change was used.
- No current GUI server, profile, shipped preset or deployment source was modified. Keep that boundary.
