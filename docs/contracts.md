# MVP internal contracts (implementation target)

This document is the shared contract for independently implemented modules. It describes proposed package APIs, not existing DSH APIs. The target host tested first is DSH 0.1.2-rc.1 / Cordis 4.0.2. Inspect actual SDK contracts before writing the adapter.

## Storage model

`Project` is owned JSON, never a live DSH Session object:

```js
{
  id, revision, createdAt, updatedAt,
  title, story, credits: { director, voice },
  characters: [{ id, name, color }],
  scenes: [{ id, imageAssetId, action, dialogue: [{ id, characterId, text, mode }],
             transition: 'cut' | 'magic' | 'time', timeLabel: '' }],
  recordingAssetId: null,
  assets: [{ id, name, kind, mime, bytes, sha256, metadata }],
  alignment: null, // or { duration, utterances, speechRanges, unmatchedSpeech, method }
  edits: [], // source-recording cuts: { id, start, end, reason, allowUnmatchedSpeech }
  style: { width:1280,height:960,fps:25,introSeconds:3,outroSeconds:4,
           comic:true, narrationAssetId:null, narrationText:'', travelSoundAssetId:null,
           timeSoundAssetId:null },
  exports: []
}
```

IDs are UUIDs or safe ASCII slugs (1–64 characters, `[A-Za-z0-9_-]`, no dots/slashes). `characterId` can be a character id, `both` (two-character simultaneous speech) or `narrator`. `mode` is `normal`, `thought`, `small`, or `burst`. No source paths, cloud keys or arbitrary code in a project.

All update calls supply `expectedRevision`. A stale update is HTTP 409 / `REVISION_CONFLICT`. Author scenes and dialogue are not overwritten by ASR. Restore makes a new revision. Media blobs never overwrite originals.

`Asset.metadata` is a bounded probe result: duration/sampleRate/channels/width/height/codec/audioStreams/videoStreams as relevant. Assets are scoped to their project; the core resolves internal file paths only after checking asset ownership. Uploaded SVG/HTML/executables are rejected. Derived output videos and PNG previews use the same asset table.

## Core module exports (parent-owned)

`src/core/store.js`: `ProjectStore({ dataDir })`, async `init()`, `create(input)`, `list()`, `get(id, revision?)`, `update(id, expectedRevision, patch)`, `mutate(id, expectedRevision, fn)`, `history(id)`, `restore(id, expectedRevision, revision)`, `addAsset(id, expectedRevision, {name,kind,mime,buffer,metadata})`, `asset(id, assetId)` (returns internal `{...record,path}`), `close()`.

`src/core/timeline.js`: `validateAlignment(project, alignment)`, `proposePauseEdit(project,{afterDialogueId,beforeDialogueId,targetSeconds})`, `applyPauseEdit(project, proposal,{allowUnmatchedSpeech:false})`, `compileTimeline(project)`.

`compileTimeline` outputs owned renderer JSON (source seconds; authoritative, centralized ripple mapping):

```js
{
 width,height,fps,duration,sampleRate:48000,
 title,credits,characters,
 cues:[{id,sceneId,imageAssetId,start,end,kind:'scene'|'magic'|'time',timeLabel?}],
 subtitles:[{id,dialogueId,sceneId,characterId,text,mode,start,end}],
 audioSegments:[{sourceStart,sourceEnd,start}], // preserve recording except approved cuts
 introSeconds,outroSeconds,
 audioOverlays:[{assetId,start,gainDb}],
 warnings:[]
}
```

Need a usable timeline before export: imported timestamped transcript or real local ASR, or explicit manual per-scene markers. Estimates must be marked `needs_review`, never reported as recognized speech. Silent/action scenes remain visible. Transitions insert time rather than overlap known speech. Intro/outro add time. Edits protect speech/unmatched ranges unless user explicitly confirms the latter.

## Python media worker (delegated ownership: python/**, tests/python/**)

No DSH imports. Python 3.11+, PyAV, NumPy, Pillow. Optional local faster-whisper or Vosk adapters; no silent model download or cloud recording upload.

CLI: `python python/worker.py --request <owned-job-request.json>`.

Request JSON:
- `{action:'probe', inputPath, outputDir}` → metadata, sniff real file format, enforce max duration/dimensions.
- `{action:'align', inputPath, outputDir, scenes, characters, engine:'whisper'|'vosk'|'segments', modelPath?, segments?}` → `{duration, utterances:[{id,dialogueId,sceneId,characterId,start,end,recognizedText,matchStatus}], speechRanges:[{start,end}], unmatchedSpeech:[{start,end,text}], method}`. `segments` are explicitly provided ASR words/segments for deterministic testing/manual import, not fabricated transcription. Dialogue ids are supplied by the storyboard. A misrecognized spelling must not replace author text. Signal uncertainty.
- `{action:'render', outputDir, timeline, assets:{[assetId]:{path,kind,mime,metadata}}, recordingAssetId, fontPath?, preview?:boolean}` → real H.264/AAC MP4 with comic captions, speaker highlighting, paper framing, magic/time transitions, intro/outro. Source recording pieces and overlay assets obey compiled timeline; no arbitrary shell execution or subprocess commands from input. Exact preview and full export share drawing functions. Use limited-range BT.709 and CJK font readiness checks. `preview` can choose smaller output size but same timeline.
- `{action:'frame', outputDir, timeline, assets, time, fontPath?}` → PNG drawn by the same renderer.
- `{action:'health', outputDir, fontPath?, modelPath?}` → actual dependencies/codecs/fonts/models readiness; no keys.

Write one `result.json` in outputDir. Success `{ok:true,result:{...}}`; failures `{ok:false,error:{code,message}}` without stack/keys or external file contents. Progress stdout JSONL `{progress:0..1,stage,message}`. Result contains only worker-owned relative output names (`movie.mp4`, `frame.png`, `alignment.json`); Node must validate result paths before registering assets. Commands are spawned using fixed args, no shell. Worker must reject bad requests and malformed media. Tests use synthetic fixtures only.

## HTTP surface / studio (parent coordination)

Dedicated same-origin app at `/paper-director/`, assets at `/paper-director/static/`.
JSON envelope `{ok:true,data}` or `{ok:false,error:{code,message}}`.
- `GET /paper-director/api/health`
- `GET/POST /paper-director/api/projects`
- `GET/PATCH /paper-director/api/projects/:id` (PATCH `{expectedRevision,patch}`)
- `GET /paper-director/api/projects/:id/history`
- `POST /paper-director/api/projects/:id/restore` `{expectedRevision,revision}`
- `POST /paper-director/api/projects/:id/assets` raw bytes with `X-File-Name` (URI-encoded), `X-Asset-Kind:image|audio`, `X-Project-Revision`; no local path parameter.
- `GET /paper-director/api/projects/:id/assets/:assetId` (Range supported for media)
- `POST /paper-director/api/projects/:id/align` `{expectedRevision,engine,segments?}` starts job
- `POST /paper-director/api/projects/:id/render` `{expectedRevision,preview?:true}` starts job
- `POST /paper-director/api/projects/:id/narration` `{expectedRevision,text,voiceProfile?:'narrator'}` starts an explicitly configured Azure job; disabled by default.
- `POST /paper-director/api/projects/:id/edits` `{expectedRevision,operation:{type:'shorten_pause',afterDialogueId,beforeDialogueId,targetSeconds},apply?:false,allowUnmatchedSpeech?:false}`
- `GET /paper-director/api/jobs?projectId=...`
- `GET /paper-director/api/jobs/:id`
- `POST /paper-director/api/jobs/:id/cancel`

Studio first version: project picker; idea/title/credit fields; characters; ordered photo cards with dialogue/action inputs; upload or record ONE complete audio track; alignment/preview/export jobs; real player/history; optional manual marker fallback. No generic DSH shell/debugging UI. Show readiness and unresolved alignment warnings rather than pretend success.

## Job / capability boundaries

JSON project data and durable job records are private under host-configured dataDir, not the repository. Job states include queued/running/succeeded/failed/cancelled/interrupted. On restart, running jobs become interrupted, never silently resumed with duplicate cloud calls. Each job snapshots an input revision; stale completion is not applied over newer author work. Host secrets are configuration or credential references, not tool/model/UI arguments.

Local-only deployment first; exact DSH Web authentication requirements must be checked against current source. Independently enforce same-origin/Host checks and request limits; token protection is mandatory before remote exposure. Agent tools must bind project scope through host configuration or session-owned binding, not expose unrestricted files/projects. No installer edits to shipped presets.
