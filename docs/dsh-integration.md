# DSH integration: installed plugin, not a temporary extension

Target: DSH **0.1.2-rc.1**, Cordis **4.0.2**, Schemastery **3.18.2**. Compatibility with other releases is not yet claimed. No installer in this package changes the running Harness or edits a shipped preset.

## Three owners

- `index.js`: process-level `paperDirector` Cordis Service. Owns one `PaperDirectorCore`, its persistence/media lifetime, authenticated HTTP routes and the optional Agent creation callback. No model tools are registered in the Host layer.
- `src/tools.js`: only the dedicated Agent preset loads this entry. It consumes `paperDirector`, calls `tools.restrict({ allow: [] })` to mask inherited global tools, then contributes eight media tools. It never provides a shared service.
- `lib/client.js`: a small classic-script ModuleLoader factory, requiring only the Harness's React seed. It appends a link to `sidebar.footer.action`. The independent studio at `/paper-director/` is ordinary HTML/CSS/JS, not a copy of the DSH shell.

## Package protocol

The package exports its Host at `.`, Agent entry at `./tools`, and Client artifact at `./client`. Its `files` whitelist must include `lib/client.js`, `cordis.patch.yml`, `presets/`, the media core and studio. Required declaration:

```json
{
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "inject": ["@deepseek-ai/dsh-client-ui-sidebar"],
      "external": ["react"]
    }
  }
}
```

`dsh.client.inject` names **packages**; the exported Client `inject: ['slots']` names **services**. Do not invent a `dsh.host` entry. The Host is selected by the ordinary Cordis row's `name` and package exports. The bundle patch inserts only that Host row.

**Registry availability is a separate release gate:** during initial development, the parent build observed npm `ETARGET` for `@deepseek-ai/cordis@4.0.2`, although the actual installed DSH SDK contains that version. Do not silently substitute 4.0.1 or advertise clean-registry installation as verified. Development must explicitly select the local installed SDK (or a verified matching SDK distribution), without committing machine-specific paths. The schema tests accept `DSH_ADAPTER_SDK_ROOT`; a separate repository-owned bootstrap may link those SDK packages for full integration tests.

DSH 0.1.2-rc.1's new-profile template already declares `nodeLinker: hoisted` and `autoInstallPeers: false` in `pnpm-workspace.yaml` (`dsh-app-boot/lib/index.js:365–397`). `dsh plugin` forwards pnpm arguments in that profile and reconciles bundle layers only after success (`dsh/lib/plugin-F7ZVfRyo.js:101–122`). Existing profile settings are not overwritten; inspect their actual settings instead of assuming the template. Runtime peer resolution and a clean packed install still require explicit testing; turning off peer installation does not manufacture a missing SDK.

After verifying a tarball in an isolated installation, an adult can install the published package with `dsh plugin --profile <profile> add dsh-paper-director`, then restart that Profile. Use the profile that actually serves the existing application. Building a separate Vite shell or launching another server does not update the current DSH GUI. This repository's checked-in minimal Client artifact needs no shell build or HMR promise.

## Authentication and HTTP

Every request to `/paper-director` or `/paper-director/…`, including HTML, JS, thumbnails and media Range requests, must first call:

```js
const status = ctx.connection.requestRejection(req)
if (status !== undefined) {
  res.writeHead(status)
  res.end()
  return
}
await handleRequest(core, req, res)
```

`webServer.register()` itself does **not** authenticate. The actual `connection` service checks Host/Origin/Fetch-Metadata and signed browser-session cookies. Use its policy, not a copied older plugin's Host-only fence. The installed Desktop's explicit skip-auth policy is also owned by that service; this plugin does not enable it or read cookie secrets. Without `connection`, no route is mounted (fail closed).

Unauthenticated visitors first open the normal authenticated DSH root. Only `/` accepts DSH's launch-token exchange; the studio does not mint or extract credentials. The common Handler retains responsibility for JSON content type, bounded uploads, domain validation, asset ownership, traversal protection and CSRF-safe mutation semantics. Authenticated does not mean that model-controlled text is authority to create sessions or enable cloud processing.

## Dedicated preset installation

The packaged `presets/paper-director/` directory is an **installation resource**, not automatically discovered by npm installation. An adult must explicitly copy that directory into a new user-owned preset directory supplied by the active roster. The usual destination is `${DSH_HOME:-~/.dsh}/.agent-presets/paper-director/`; configured roots may override it, so inspect the actual roster before writing. Refuse an existing destination instead of overwriting it. Do not modify the shipped preset package or use an npm `postinstall` script to change user configuration.

The installed roster's `list()` and `resolve(id)` report absolute composition paths; `copy(from,id,name)` returns void, so follow it with `resolve(id)` when copying a base. The resource here is intentionally narrower than `minimal`, which still includes general shell and filesystem capabilities. `agentPresets.standingKeyFor('paper-director')` is a **real mount**, not a read-only parse; validate it only in an explicitly authorized test/deployment context. Test two sessions as well as one to catch accidental shared-service registration.

The tools entry can accept administrator-only `config.projectId`. By default it resolves `paperDirector.bindingForSession(exec.agent.session.id)`. Missing binding rejects; no tool accepts `projectId`, file paths, commands, URLs, cloud credentials or permission overrides. Each dispatch carries `{ projectId }` as a separate trusted scope, and the core must enforce this again for job and asset identities.

## UI → dedicated Agent bridge

When `agents`, `agentPresets` and `agentDefaultModel` are available, Host initialization installs `core.setAgentStarter(...)`. Only an authenticated **human UI** endpoint may invoke it. The callback:

1. Validates project identity and bounded prompt, and proves the project exists.
2. Creates a fresh session with fixed `meta.agentPreset: 'paper-director'` and the adult's current model selection.
3. Uses `setup(agentCtx)` to mount that exact preset before publication. There is no fallback to a privileged preset if mounting fails.
4. Persists the trusted session-to-project binding, then calls `agent.followup(createUserMessage(...))` with plugin provenance.
5. Returns `{ sessionId }`; failed binding/delivery disposes the new Agent.

Agent creation is owned through Cordis's `agents.create()` lifecycle. Host unload removes the starter and routes and closes the media core. The adapter neither resumes cold production sessions nor automatically retries a failed creation/delivery. Follow-up conversation discovery/resumption and real model-provider behavior require an integration acceptance test; successful contract doubles are not proof of a full DSH turn.

## Tool surface

`paper_project`, `paper_update_story`, `paper_align`, `paper_render`, `paper_jobs`, `paper_pause_propose`, `paper_pause_apply`, `paper_narration`.

Writing tools require `expectedRevision`. The story patch string is parsed into owned JSON and checked against allowed top-level fields before core validation. Pause application reconstructs the operation and forces `allowUnmatchedSpeech: false`; only the authenticated human UI may offer explicit unmatched-speech authorization. Narration passes approved text with fixed voice profile, never recordings or key names. Core results must remain sanitized DTOs without internal file paths or settings.

## Verification and limits

Run `node --test tests/dsh-adapter.test.mjs`. These dependency-free contract tests cover Host init/cleanup, auth rejection before business dispatch on every URL class, fixed-preset Agent creation and binding order, failed delivery cleanup, two session scopes, privileged argument stripping, pause protections, and the small Client factory. They execute the adapter against explicit doubles; they do not install plugins, open a port, call a model or mutate the current Harness.

Optional SDK verification uses `DSH_ADAPTER_SDK_ROOT` pointing to an installed `node_modules/@deepseek-ai` directory. It loads only Cordis/Schemastery/tool definition code to check schemas and registrations, never the active application composition. Without that path it is explicitly skipped.

Release acceptance additionally needs: tarball contents; fresh-profile plugin resolution; actual two-session preset mount and disposal; authenticated and unauthenticated browser navigation; Origin/cookie failure matrix; authenticated media seek; restart persistence/job recovery; and an actual UI-triggered production Agent turn. Do not describe these as passed until exercised. Python codec/font/ASR readiness and genuine listening/visual review are separate from adapter tests.

## Source evidence for the target version

Paths below are relative to an installed `node_modules/@deepseek-ai/`:

- `dsh-app-boot/lib/index.js:847–869`: profile bundle resolution and `dsh.bundle.patch`.
- `dsh-client-modules/lib/index.js:139–165,618–647`: Client metadata and export resolution.
- `dsh-host-webserver/lib/index.js:176–183,227–259`: route ownership and unauthenticated raw dispatch.
- `dsh-client-connection/lib/index.js:178–191,511–539`: trust fence and public `requestRejection` API.
- `dsh-client-ui-sidebar/lib/client.js:242–249,300–326`: footer slot props and list registration.
- `dsh-client-ui-renderer/lib/client.js:333–339`: registration `inject` is not ordinary slot props; this Client needs no inject callback.
- `dsh-tools/lib/index.js:837–882,2769–2805`: definition, scope registration and inherited-tool restriction.
- `dsh-agent-loop/lib/index.js:395–403,1309–1334`: followup and setup-before-publication.
- `dsh-agent-presets/lib/index.js:1240–1248,1300–1309,1609–1614`: roster roots and copy behavior.
