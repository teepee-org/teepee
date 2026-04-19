# Changelog

This project now keeps a forward-maintained release history here and on GitHub Releases.

## v0.3.1

Fixes

- Added enforced idle-timeout handling for agent providers, plus live stream-activity signals in the UI, closing `#1` and `#8`.
- Fixed streamed agent output rendering so Claude/Codex prose is surfaced as text instead of raw provider JSON, with stderr isolation and final-text de-duplication in the parser pipeline.
- Fixed fail-closed execution preflight drift by unifying job start/resume validation under `validateJobRunPreconditions`, closing `#6`.
- Hardened HTTP body parsing with explicit size caps, invalid-JSON handling, and safer request-stream cleanup, closing `#2`.
- Fixed the AgentSlot streaming tail so active messages keep the animated typing dots instead of switching to a blinking cursor mid-stream.

Improvements

- Split the server HTTP route monolith into per-domain handler modules under `packages/server/src/http/api/`, keeping the same behavior while making the surface area easier to reason about and maintain.
- Refreshed the release landing page copy on `teepee.org` to match the current product surface.

Notes

- This is a patch release on top of `v0.3.0`: no new config migration, no package renames, no new publish targets.

## v0.3.0

Features

- Added a Filesystem Explorer sidebar tab (Files) with a read-only lazy tree across all configured filesystem roots, typed file preview (Markdown, syntax-highlighted code, images, PDFs), and a right-click context menu that copies markdown-link references and ready-made `@coder` / `@architect` review prompts to the clipboard.
- Added an `edit` op to the artifact protocol that applies small targeted `find` / `replace` (with optional `replace_all`) edits server-side against the current artifact head. Reduces agent output from full-body rewrites (thousands of tokens) to ~50 tokens for typical edits — dramatically faster and cheaper for small updates.
- Rewrote the compose-box file picker as a dropdown component (`FileDropdown`, `useFileSelector`) backed by a new `/api/files` endpoint with `fs` / `tp` / `all` source filters, unified file and topic navigation, and markdown-link insertion.
- Surfaced live system messages: `onSystemMessage` now carries the persisted message id and the server broadcasts `message.created`, so rate-limit, permission-denied, cancel, and other system announcements appear immediately in the topic (previously visible only after reload).
- Added `agent.job.round_started` events with a phase label between artifact-op rounds. The AgentSlot now resets between rounds and shows a subtle phase indicator (e.g. `processing artifact read results (round 1)`), closing the UX gap where the sidebar spinner kept spinning while the topic was silent.
- Added provider sandbox path extensibility: CLIs installed outside the default sandbox-visible directories (`/usr/local/bin`, `/usr/bin`, `/bin`, `/sbin`) — for example in `~/.local/bin` or `~/.npm/bin` — are now detected and mounted into the sandbox. The starter config generation warns on Linux when a provider is installed outside these paths.
- Added filesystem access APIs (`/api/fs/roots`, `/api/fs/entries`, `/api/fs/file`, `/api/fs/download`) with ACL-scoped multi-root access.
- Added config v2 schema with role-agent access matrix.
- Added Copy buttons on artifact viewer and message bubbles to grab the markdown source.

Improvements

- Rewrote the `[artifacts/v2]` prompt block with concrete JSON examples (read-current, edit, update, create) and an explicit "do not inspect source code to verify the protocol" directive. Agents now stop wasting 30-60s exploring the repo to reverse-engineer the format.
- Artifact-focused context builds now trim topic history and truncate long non-trigger messages, shrinking typical prompts from ~35k to ~10k characters for small-edit scenarios.
- The artifact-ops parser now auto-generates `op_id` when missing (`auto-N`), making the protocol tolerant to a common agent mistake.
- `onSystemMessage` in the Orchestrator now routes through a unified `insertSystemMessage` helper — six duplicated call sites consolidated.
- Forward `OPENAI_*` environment variables through the sandbox for providers that need them.
- Split the web bundle into `highlight`, `markdown`, `react-vendor` chunks for better repeat-visit caching.

Fixes

- Fixed a black-screen crash in the Filesystem Explorer preview caused by a race between selection changes and the `useEffect` that syncs the preview state (`Cannot read properties of undefined (reading 'content')`). A defensive render-time guard now shows a brief loading state until the effect catches up.
- Fixed layout collapse of the preview panel (flex-based sizing that could allocate 0 height in some browser configurations) by switching to `height: 100%` and adding minimal per-token syntax colors scoped to the preview.
- Fixed `/api/files` navigation after entering a filesystem root: the endpoint previously only accepted `rootId:subpath` with a colon separator, while the client inserts tokens like `|workspace/` after directory selection. The endpoint now accepts slash-form paths too.
- Fixed topic-level writer locking gap: writer jobs in unrelated topics no longer block each other via global chain locks when they shouldn't.

Notes

- Three RFCs archived in `docs/spec/`: `rfc-fs-explorer.md` (live with this release), `rfc-workspace.md` (parked, post-M1), `rfc-kb-mode.md` (parked, post-PMF). Each has explicit unpark criteria.
- The Codex CLI now runs with `--skip-git-repo-check` to work in non-repo directories.
- Pre-existing test failures remain unaddressed in this release: 39 in `packages/core` (config role-matrix, permissions role-matrix, topic-move, commands/registry, one flaky orchestrator-user-input) and 5 in `packages/web` (drawer state, delivery state, `/topic new`, ArtifactViewer render). These are unrelated to new features and scheduled for a follow-up hygiene release.
- Bumped all workspace packages from `0.2.12` to `0.3.0`. Cross-package dependencies updated accordingly.

## v0.2.12

Features

- Added canonical child-topic creation with `/topic new <name>` while preserving `/new <name>` for root topics.
- Added local `/focus` and `/unfocus` view mode with a visible focus banner and subtree filtering.
- Added live human presence with a sidebar `Online now` panel, `/who`, explicit active topic tracking, and idle/active state updates.

Fixes

- Broadcast `topics.changed` consistently for collaboration-safe topic creation and topic hierarchy mutations.
- Blocked observers from topic creation at the client entry points and surfaced API create-topic failures correctly.
- Completed presence role/state rendering and idle transition coverage.

Notes

- Presence remains in server memory only and is tracked per connected browser session.
- Focus state remains local to the browser and does not persist across restarts.

## v0.2.11

Features

- Added insecure local evaluation flow with `serve --insecure` for fast first-run setup.

Fixes

- Documented the security tradeoff of insecure mode and clarified local-eval guidance.

## v0.2.10

Features

- Added execution policy sandboxing for safer shared use.

Fixes

- Improved release packaging around secure execution defaults.

## v0.2.9

Features

- Improved compose history and onboarding flows.

Notes

- Earlier milestones are preserved in git history; GitHub Releases are being backfilled from tagged versions forward.
