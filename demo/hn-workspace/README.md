# HN Demo Workspace

This folder is a disposable project used to demo Teepee on Hacker News.

What it gives you:
- a small but real codebase that agents can read, edit, test, and review
- a local `.teepee/config.yaml` with broad permissions for fluid demos
- prompt ideas in `HN_PROMPTS.md`
- a recording runbook in `HN_DEMO_CAPTURE.md`
- a browser-side prompt sender in `PROMPT_AUTOPLAY.md`
- a reusable reset script in `scripts/reset-demo-state.sh`

Safety:
- agents in this workspace are intentionally configured with broad local access
- do not put secrets or important files here
- launch Teepee from this directory so agents stay scoped to this demo project

Start here:

```bash
cd demo/hn-workspace
npx teepee-cli start
```

Manual checks:

```bash
npm test
npm start

# Filter by ticket status (open, closed, or all):
npm start -- --status closed
```

Project layout:
- `src/report.js` summarises support tickets
- `src/index.js` is a tiny CLI
- `data/tickets.json` is the sample dataset
- `test/report.test.js` covers the current behaviour

Good demo tasks:
- ask `@reviewer` for a code review with concrete findings
- ask `@architect` to design a feature and explicitly tag `@coder`
- ask `@coder` to implement a feature and run tests
- tag multiple agents in parallel and compare outputs

Reset between takes:

```bash
./scripts/reset-demo-state.sh
```

Native prompt autoplay:

```text
http://localhost:3000/
```

Then press `F2` or click the `Demo F2` button in the UI.
Then press `F2` or click the `Demo F2` button in the UI.

Replay a real recorded sequence under a new topic name:

```bash
./scripts/prepare-hn-replay.sh hn-replay
```
