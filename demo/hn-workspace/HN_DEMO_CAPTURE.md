# HN Demo Capture

This runbook is for recording a short Teepee demo for LinkedIn or Hacker News.

## Goal

Show three things quickly:
- multiple agents respond in parallel
- one agent hands work to another with an explicit tag
- `@coder` edits the workspace and runs tests

## Best Format

- preferred: MP4 screen recording, 45 to 90 seconds
- optional teaser: short GIF cut from the MP4

MP4 is better than GIF for terminal text and browser detail. Use GIF only for a short teaser clip.

## Before Recording

From this directory:

```bash
cd demo/hn-workspace
rm -f .teepee/db.sqlite .teepee/db.sqlite-shm .teepee/db.sqlite-wal .teepee/pid
npm test
npm start -- --json
npx teepee-cli start
```

Then:
- open the owner login link
- create a fresh topic like `hn-demo`
- keep `HN_PROMPTS.md` open in another window for copy/paste

## Recommended Recording Sequence

### Scene 1: agents in parallel

Paste:

```text
@reviewer find two weaknesses in the current code. @architect propose one small but worthwhile next feature for this workspace.
```

Goal:
- two agents reply independently
- no accidental handoffs

### Scene 2: explicit handoff

Paste:

```text
@architect design a `--owner <name>` CLI filter for the report and explicitly tag @coder to implement it.
```

Goal:
- `architect` produces a concrete implementation plan
- `architect` explicitly hands off to `@coder`

### Scene 3: real implementation

Paste:

```text
@coder implement the `--owner <name>` filter, run tests, and report exactly what changed.
```

Goal:
- `coder` edits files
- `coder` runs tests
- the final answer says what changed and what was verified

## Recording Tips

- start recording only after the Teepee UI is already open
- zoom browser text slightly if needed
- keep the topic narrow: one feature, one review, one handoff
- if a run looks noisy, delete the topic and start a new one
- do not show secrets, API keys, or unrelated local files

## After Recording

- trim dead time at the start and end
- if you need a GIF, cut only the most interesting 10 to 20 seconds
- for LinkedIn, pair the clip with a short caption
- for HN, use the clip as supporting material, not as the only explanation
