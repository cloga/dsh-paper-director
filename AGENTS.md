# Paper Director engineering rules

Product: 纸上小导演. The author workflow is fixed: story idea → ordered photos → dialogue/action notes per photo → ONE complete recording → agent post-production → review and natural-language edits. Never replace this with mandatory per-scene recording or AI-authored stories.

## Boundaries
- This repository is public. Never copy family photos, real child recordings, generated private movies, .env files, keys, access tokens, absolute developer-machine paths, or project databases here.
- Demo media must be generated, anonymous and explicitly licensed; do not use the private reference project as a fixture.
- Original media is immutable. All edits create a revision. Jobs render immutable revisions; late results cannot silently replace newer work.
- The media core is independent of DSH. The Host owns shared persistence/jobs/credentials; a dedicated Agent preset only contributes restricted tools and instructions. Never modify shipped DSH presets.
- Child-facing tools must not expose arbitrary shell commands, local file reads, credentials, arbitrary network fetches or unscoped project access.
- Author intent and supplied dialogue remain separate from image/ASR observations. Unmatched speech is not silence. Never silently delete it or claim scripted text was recognized.
- No automatic cloud upload of recordings. Azure narration sends approved text only and is disabled until the adult configures it.
- Playback/semantic confidence must be reported honestly. Technical tests do not mean anyone listened to audio.

## Delivery
Work on a feature branch, run tests and package verification, scan intended files for secrets/private media, and deliver by PR. Never push the default branch directly. Keep implementation checkpoints in docs/implementation-status.md so autonomous rounds can resume from evidence.
