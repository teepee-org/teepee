# Teepee

**Coordinate AI agents in realtime with @mentions.**

Teepee is a self-hosted workspace where humans and AI agents collaborate in topics. Mention an agent, it runs. Mention two, they run in parallel. An agent can mention another — chaining happens automatically.

```
npx teepee start
```

## Quick start

**1. Create a config**

```yaml
# teepee.yaml
teepee:
  name: my-project

providers:
  claude:
    command: "claude --print"

agents:
  coder:
    provider: claude
  reviewer:
    provider: claude
```

**2. Start**

```bash
npx teepee start
```

Open the owner link printed in the terminal. Create a topic, start chatting.

**3. Tag agents**

```
@coder write a fibonacci function
```

```
@coder @reviewer what do you think about this approach?
```

Agents respond in real time with streaming output.

## Features

- **@mention driven** — Write `@coder` in chat. The agent activates. Quoted mentions like `"@agent"` are ignored.
- **Multi-agent parallel** — Tag multiple agents in one message. They run simultaneously with isolated context.
- **Agent chaining** — An agent's reply can mention another agent, triggering automatic follow-up. Configurable depth limits prevent loops.
- **Any CLI agent** — Works with Claude, Codex, Ollama, or any command that reads stdin and writes stdout.
- **Realtime streaming** — Agent output streams token-by-token via WebSocket.
- **Self-hosted** — Runs on your machine. Your code, your API keys, your control.
- **Markdown native** — All messages are Markdown with syntax-highlighted code blocks, tables, and copy buttons.
- **Web UI** — Clean dark-theme interface with topics, agent slots, and `@` autocomplete.
- **Auth built in** — Owner login via secret link. Invite users with magic links. Role-based permissions (owner/user/observer). Deny-by-default agent tagging.

## How it works

```
alice> @architect design an auth module
  → architect responds with spec

alice> @coder implement it
  → coder writes the code

alice> @coder @reviewer what do you think?
  → coder and reviewer respond in parallel

reviewer> Found a bug. @coder please fix the null check
  → coder triggered automatically (chaining)
```

## Configuration

```yaml
teepee:
  name: my-project
  language: en           # agent response language

providers:
  claude:
    command: "claude --print"
    timeout_seconds: 120
  codex:
    command: "codex exec"
  local:
    command: "ollama run codellama"

agents:
  coder:
    provider: claude
  reviewer:
    provider: claude
    prompt: "./agents/reviewer.md"    # custom prompt file
  architect:
    provider: codex

limits:
  max_agents_per_message: 5
  max_jobs_per_user_per_minute: 10
  max_chain_depth: 2
  max_total_jobs_per_chain: 10
```

## Chat commands

```
/help                     — list commands
/topics                   — list topics
/join <id>                — switch to topic
/new <name>               — create topic
/topic language <lang>    — set topic language
/topic rename <name>      — rename topic
/topic archive            — archive topic
/alias @agent @short      — create alias
/agents                   — list agents
```

## Admin

Click **Admin** in the sidebar (owner only) to:

- **Invite users** — Generate magic links with role and agent permissions
- **Manage permissions** — Allow/deny specific agents per user
- **Revoke access** — Instantly invalidate sessions and tokens

## Auth model

- **Owner**: Authenticated via secret link printed at startup. Works from any device.
- **Users**: Invited via magic link. Choose a handle on first access. Session cookie (30 days).
- **Observers**: Read-only access. Cannot post or tag agents.
- **Permissions**: Deny-by-default. Owner explicitly allows which agents each user can tag.

## Reverse proxy (HTTPS)

For public access, put Teepee behind a reverse proxy:

```bash
# Caddy (zero-config HTTPS)
caddy reverse-proxy --from teepee.example.com --to localhost:3000
```

Teepee reads `X-Forwarded-For`, `X-Forwarded-Proto`, and `X-Forwarded-Host` automatically.

## Architecture

```
Browser (Web UI)
    ↕ WebSocket
Teepee Server (Node.js)
    ↕ SQLite
    ↕ spawn
Agent CLI (claude --print, codex exec, ...)
```

- **Backend**: TypeScript, Node.js, SQLite
- **Frontend**: React, Vite, WebSocket
- **No external services** — everything runs locally

## Multi-project

One Teepee = one project. To work on multiple projects, run multiple instances on different ports:

```bash
cd ~/api && teepee start --port 3000
cd ~/web && teepee start --port 3001
```

## Adding an agent

Any command that reads from stdin and writes to stdout works:

```yaml
agents:
  my-agent:
    provider: my-provider
    prompt: "./prompts/my-agent.md"   # optional
```

The agent receives context on stdin in this format:

```
[teepee/v1]

[system]
<agent prompt>
You must answer in <language>.

[messages]
<recent messages>

[current]
<triggering message>
```

## License

MIT

## Links

- Website: [teepee.org](https://teepee.org)
- GitHub: [github.com/teepee-org/teepee](https://github.com/teepee-org/teepee)
