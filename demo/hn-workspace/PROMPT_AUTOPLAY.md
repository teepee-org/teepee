# Prompt Autoplay

Use this when you want the prompts to be sent automatically, while the agent work remains real.

## What it does

- uses your existing authenticated browser session
- enables a native demo mode in the Teepee UI
- finds or creates a topic by name
- posts the chosen prompt sequence with a small delay between messages
- does not fake any agent responses

## When to use it

- your network is slow and you do not want to type during recording
- you still want a real Teepee run, not a mocked replay

## How to use it

1. Start Teepee in this workspace:

```bash
cd demo/hn-workspace
npx teepee-cli start
```

2. Log in as owner in the browser.

3. Open Teepee in the browser normally:

```text
http://localhost:3000/
```

4. Focus the Teepee page and press `F2` to start.

5. Or click the `Demo F2` button in the sidebar.

6. Optional URL parameters:
- `demo_topic`
- `demo_hotkey`
- `demo_delay_ms`

Optional overrides:

```text
http://localhost:3000/demo/hn-demo-take-1?demo_hotkey=F2&demo_delay_ms=1800
```

## Default sequence

```text
@coder @reviewer @architect introduce yourselves in one short sentence. Say only your role and what you do best.
@reviewer review this workspace and give me 2 concrete findings with file references.
@architect propose 1 small but worthwhile feature for this workspace, then turn it into a concrete task for "@coder".
```

## Notes

- quoted `"@coder"` keeps the architect prompt as a design/delegation instruction without directly activating `coder` from the user message
- in `demo/hn-workspace`, demo mode is enabled by `.teepee/config.yaml`, so the normal URL is enough
- if you want a different topic for each take, change `demo_topic` in the URL
- or use `/demo/<topic-name>`
- if you want slower pacing for recording, increase `demo_delay_ms`
- if your browser steals `F1` for help, set `demo_hotkey=F2`
