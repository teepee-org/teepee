# Teepee

**Coordinate AI agents in realtime with @mentions.**

Teepee is a self-hosted workspace where humans and AI agents collaborate in topics. Mention an agent, it runs. Mention two, they run in parallel. An agent can mention another — chaining happens automatically.

Agents can also hand off work to each other: one agent writes the task, tags the next, and execution continues automatically.

Teepee is a product by TypeEffect.

```
npx teepee-cli start
```

The npm package is `teepee-cli`. If you install it globally, it exposes the `teepee` binary.

## Quick start

**1. Create a config**

```yaml
# .teepee/config.yaml
teepee:
  name: my-project

providers:
  claude:
    command: "claude -p --permission-mode acceptEdits"

agents:
  coder:
    provider: claude
  reviewer:
    provider: claude
```

**2. Start**

```bash
npx teepee-cli start
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
If the provider supports editing and shell actions, agents can modify files in the project working directory.

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

Teepee reads its project config from `.teepee/config.yaml`.

```yaml
teepee:
  name: my-project
  language: en           # agent response language

server:
  trust_proxy: false
  cors_allowed_origins: []          # optional extra origins for cross-origin API access
  auth_rate_limit_window_seconds: 60
  auth_rate_limit_max_requests: 20

providers:
  claude:
    command: "claude -p --permission-mode acceptEdits"
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
    prompt: "./agents/reviewer.md"    # custom prompt file, relative to the project root
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

- **Owner**: Authenticated via a one-time secret link printed to the terminal at startup. The secret changes on every restart. Works from any device.
- **Users**: Invited via magic link (generated from the Admin panel or CLI). Choose a handle on first access. Session cookie (30 days, HttpOnly).
- **Observers**: Read-only. Cannot post messages, create topics, tag agents, or run commands.
- **Permissions**: Deny-by-default. Owner must explicitly allow which agents each user can tag via the Admin panel.
- **All API endpoints** require a valid session. Unauthenticated requests get 401. Only auth endpoints and static assets are public.
- **WebSocket** connections are authenticated from the session cookie at connection time. Unauthenticated clients cannot join topics, send messages, or run commands.
- **Identity is server-side**: the author of a message is always derived from the session, never from client-supplied fields.

## Security notes

- No passwords. Auth is session-based (cookie) with magic links.
- On localhost without HTTPS, the session cookie is not marked `Secure` — this is fine for local development.
- For production/public access, **always use HTTPS** via a reverse proxy. Teepee sets the `Secure` cookie flag when it detects `X-Forwarded-Proto: https`.
- `server.trust_proxy` is `false` by default. Enable it only when Teepee is behind a proxy you control that overwrites `X-Forwarded-*` headers.
- CORS is same-origin by default. Use `server.cors_allowed_origins` only if you intentionally need cross-origin access.
- Public auth endpoints have a basic in-memory rate limit to slow repeated token or owner-secret attempts.
- The owner secret link is printed to stdout at startup. Treat it like a password — do not share it.

## Reverse proxy (HTTPS)

For public access, put Teepee behind a reverse proxy:

```bash
# Caddy (zero-config HTTPS)
caddy reverse-proxy --from teepee.example.com --to localhost:3000
```

If you run Teepee behind a reverse proxy, set `server.trust_proxy: true` so forwarded protocol, host, and client IP are read from the proxy headers. When behind HTTPS, session cookies are marked `Secure`.

## Architecture

```
Browser (Web UI)
    ↕ WebSocket
Teepee Server (Node.js)
    ↕ SQLite
    ↕ spawn
Agent CLI (claude -p, codex exec, ...)
```

- **Backend**: TypeScript, Node.js, SQLite
- **Frontend**: React, Vite, WebSocket
- **No external services** — everything runs locally

## Multi-project

One Teepee = one project. To work on multiple projects, run multiple instances on different ports:

```bash
cd ~/api && npx teepee-cli start --port 3000
cd ~/web && npx teepee-cli start --port 3001
```

## Adding an agent

Any command that reads from stdin and writes to stdout works:

```yaml
agents:
  my-agent:
    provider: my-provider
    prompt: "./prompts/my-agent.md"   # optional, relative to the project root
```

If `agents.<name>.prompt` is omitted, Teepee automatically looks for `default-prompts/<name>.md`.
If that file does not exist, it falls back to `default-prompts/default.md`.
Prompt paths are resolved relative to the project root.

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

Provider commands run in the Teepee project working directory. If your provider CLI supports editing files and running shell commands, agents can modify the codebase directly.

## License

MIT

## Links

- Website: [teepee.org](https://teepee.org)
- GitHub: [github.com/typeeffect/teepee](https://github.com/typeeffect/teepee)
