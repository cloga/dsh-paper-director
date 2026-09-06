# Agent loop integration contract (implementation target for resumed work)

This extends the existing application contracts, not the DSH SDK. Main owns Core/store. Adapter worker owns index/tools/preset. UI worker owns HTTP/Web.

## Trusted scopes

Core dispatch scope may be `{projectId}` (administrator-fixed tool) or `{projectId,sessionId}` (studio agent). A provided sessionId MUST already have the same persisted studio binding. No other scope keys. Studio tool execution supplies exec.agent.session.id, never a model parameter. Admin-fixed project tools stay project-only, receive no automatic notifications and their existing chat history must not enter the child UI.

`core.bindSession(sessionId,projectId)` remains Host-only for a freshly created dedicated studio Agent. `core.bindingForSession()` returns the project id. New `core.isStudioSession(sessionId,projectId)` is a readonly boolean gate.

## Host callbacks owned by the Fiber

- `core.onAgentNotice(callback)` returns disposer; a single active callback receives OWNED `{id,projectId,sessionId,kind,status}`. kind is align/narration/render/review; id is the jobId or proposalId. It returns `{delivery:'queued'|'cold'|'rejected'|'stopped'}`. Notification is claimed once before the callback, never automatically retries an uncertain delivery. No automatic cold agent resume/create.
- Job notices only for align/narration completion and render FAILURE. Successful render is displayed by the UI and does not wake another render loop. Review accepted/dismissed notices allow the originating Agent to continue/stop.
- Subscribers are recorded before a queued job can run. If a duplicate job is already terminal, its inline result suffices; no wakeup.
- `core.setAgentStatusReader(fn|undefined)`: fn(sessionId) returns owned `{liveStatus:'running'|'idle'|'cold',lastTurnReason:null|string,messages:[{id,seq,text,interrupted}]}`. Max10 text messages, max8000 chars total. No reasoning/tool/user/plugin content. Main checks studio binding before reader access. Use current effective session surface when available; do not dump shared DSH objects.
- `makeAgentStarter.ready()` readonly checks exact preset exists and !broken, model selection has provider/model. This is configured, not proof of authentication/inference.

Adapter must recheck binding/live Agent after awaits, use actual agents.get(sid), followup(createUserMessage plugin provenance), and stop delivery after Fiber disposal. All callbacks are Core-defined; there is no DSH SDK subscribeLifecycle API.

## Core review API / HTTP

- `core.review(projectId)` -> `{projectId,revision,agent:{sessionId|null,liveStatus,lastTurnReason,messages},proposals:[...]}`.
- `GET /paper-director/api/projects/:id/review` calls core.review (authenticated human studio only).
- `POST /paper-director/api/projects/:id/reviews/:proposalId` body `{expectedRevision,decision:'apply'|'dismiss'}` calls `core.decideReview(projectId,proposalId,body)`, returns updated Project. No generic scope/tool endpoint for author approval.
- `timeline.propose` persists a non-empty owned proposal (same deterministic id deduped). `timeline.apply` also saves the proposal before rejecting confirmation-required. Proposal fields include id/projectId/baseRevision/request/currentSeconds/targetSeconds/removedSeconds/cuts/warnings/requiresConfirmation plus `sourceRange:{start,end}` for playback of the ORIGINAL complete recording. It is not a preview of the edited result.
- Core review lists only pending proposals for the current revision; stale approval returns409, does not apply anything. Apply recalculates proposal with current revision and grants unmatched-speech deletion only for this explicitly chosen review. Original recording remains immutable. Dismiss leaves content/revision alone, records decision and suppresses the card. Both decisions notify only their originating studio Agent.

UI polling should show bounded last replies and accurate idle/running/cold state, but movie completion comes from actual exports. Polling cannot overwrite dirty inputs or microphone state. Approval UI: show old/new pause duration + warning, “试听原段” (recording player seek into sourceRange), “确认剪短” and “保留原样”. Explicit user confirmation before POST apply. Never expose JSON editing or require a generic DSH chat to see a clarification.

## Render-time lookup

Each new render stores a compact timelineIndex in the JOB result only: `{duration,introSeconds,outroSeconds,cues:[{sceneId,start,end,kind}],subtitles:[{dialogueId,sceneId,start,end}]}`. Project export entries retain jobId/inputRevision/assetId/outputRevision; no duplicate full timeline in every project snapshot. Public job DTO omits timelineIndex.

- Model tool `paper_locate` parameters `{assetId,time}` -> dispatch `movie.locate`, scoped to current project. Core validates asset belongs to a render of this project; uses the persisted index and original input revision, not a recomputed current timeline. Returns bounded `{assetId,inputRevision,currentRevision,stale,time,kind,scene,activeDialogueIds,nearbyDialogueIds}`. Missing old index gives an explicit error; never guesses seconds.
- UI `send-feedback` includes the currently watched movie assetId, inputRevision and currentTime in the author prompt. Core status/confirmation API never accepts arbitrary Session ids.

## Validation

Use real Core + lightweight controlled Agent callbacks to verify fast-job subscription races, dedupe, failure/idle/cold status, disposed callbacks, approval conflicts, wrong project/session rejection, and no reasoning/admin-history leaks. Actual SDK adapter checks are separate from live model inference; no paid cloud calls or private media are needed.
