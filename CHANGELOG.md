# Changelog

This project now keeps a forward-maintained release history here and on GitHub Releases.

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
