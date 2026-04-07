<p align="center">
  <img src="logo.svg" alt="Teepee logo" width="100" height="100">
</p>

# Teepee

**Coordinate AI agents with @mentions.**

Teepee is a self-hosted workspace where humans and AI agents collaborate in topics. Invite teammates, assign roles, structure work with lightweight nested topics, and coordinate with @mentions. Mention an agent, it runs. Mention two, they run in parallel. An agent can mention another and continue the workflow automatically.

This is not just chat. Teepee sits on top of a real project, so coding agents can work on the codebase underneath while humans stay in the same shared context.

Agents can also hand off work to each other: one agent writes the task, tags the next, and execution continues automatically.

Teepee is a product by TypeEffect.

```
npx teepee-cli start
```

The npm package is `teepee-cli`. If you install it globally, it exposes the `teepee` binary.

## Prerequisites

- Run Teepee from the root of the project you want it to work on
- Install Node.js 20+
- Install at least one agent CLI locally, such as `claude`, `codex`, or `ollama`

## Why Teepee

Teepee is for the moment when "open a few terminals and coordinate agents by hand" stops scaling.

- Keep humans and agents in the same topic-based workspace
- Organize work with lightweight nested topics instead of heavyweight project boards
- Invite teammates with magic links and role-based permissions
- Trigger agents with `@mentions` instead of bespoke scripts
- Let agents delegate work to each other in public, auditable conversation
- Mix providers like Claude, Codex, and local models in one project
- Keep everything self-hosted and close to the codebase
- Let coding agents operate in the real project working directory instead of only replying in chat

## Quick start

**1. Create a config**

```yaml
# .teepee/config.yaml
teepee:
  name: my-project

providers:
  claude:
    command: "claude -p --permission-mode acceptEdits"
  codex:
    command: "codex exec"

agents:
  coder:
    provider: claude
  reviewer:
    provider: claude
  architect:
    provider: codex
  devops:
    provider: codex
```

**2. Start**

```bash
npx teepee-cli start
```

Run this in the root of the project you want Teepee to work on. On first run, Teepee creates `.teepee/config.yaml` and exits. It keeps its state for that project in `.teepee/`.

If you prefer a global install, run:

```bash
npm install -g teepee-cli
teepee start
```

The generated config tries to detect installed agent CLIs such as `claude`, `codex`, and `ollama`, and uses what it finds. If none are detected, Teepee writes a commented starter template for you to edit manually.

**3. Start again**

```bash
npx teepee-cli start
```

Now Teepee starts the server and prints the owner login link. Open it, create a topic, and start chatting.

**4. Tag agents**

```
@coder write a fibonacci function
```

```
@coder @reviewer what do you think about this approach?
```

Agents respond in real time with streaming output.
If the provider supports editing and shell actions, agents can modify files in the project working directory.

## Good fits

- Coordinating a small team of coding agents in one repo
- Inviting human teammates into the same workspace instead of coordinating in a separate chat tool
- Review + implementation + architecture loops in the same workspace
- Release and operational workflows in the same workspace with a dedicated `@devops` agent
- Self-hosted local workflows where you want auditability and control
- Mixed-provider setups where different agents use different CLIs

## Features

- **@mention driven** — Write `@coder` in chat. The agent activates. Quoted mentions like `"@agent"` are ignored.
- **Multi-agent parallel** — Tag multiple agents in one message. They run simultaneously with isolated context.
- **Agent chaining** — An agent's reply can mention another agent, triggering automatic follow-up. Configurable depth limits prevent loops.
- **Human + agent collaboration** — Invite teammates with magic links, assign roles, and keep humans and agents in the same workspace.
- **Hierarchical topics** — Topics can contain child topics, rendered with slight indentation and moved with simple slash commands.
- **Works on the real project** — Agents run in the project working directory, so they can read files, make changes, and keep the workflow attached to the codebase itself.
- **Specialized roles** — Split work across `@coder`, `@reviewer`, `@architect`, `@devops`, or your own custom agents with per-agent prompts.
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

alice> @architect write a task for @coder to implement it
  → architect drafts the implementation task and tags @coder
  → coder starts automatically

bob> @coder @reviewer what do you think?
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
  devops:
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
/topic move root          — move current topic to root level
/topic move into <id>     — move current topic inside another topic
/topic move before <id>   — move current topic before another topic
/topic move after <id>    — move current topic after another topic
/alias @agent @short      — create alias
/agents                   — list agents
```

## Admin

Click **Admin** in the sidebar (owner only) to:

- **Invite users** — Generate magic links with role and agent permissions
- **Manage permissions** — Allow/deny specific agents per user
- **Revoke access** — Instantly invalidate sessions and tokens

This is a shared workspace, not a single-user agent console: multiple humans can join the same Teepee, collaborate in topics, and decide which users can tag which agents.

> **Shared-use responsibility:** If you invite collaborators to use agents backed by third-party paid services (e.g. Claude, Codex), you are responsible for verifying that those services' Terms of Service allow shared or team use. Teepee does not grant additional usage rights for those services.

## Auth model

- **Owner**: Authenticated via a one-time secret link printed to the terminal at startup. The secret changes on every restart. Works from any device.
- **Users**: Invited via magic link (generated from the Admin panel or CLI). Choose a handle on first access. Session cookie (30 days, HttpOnly).
- **Observers**: Read-only. Cannot post messages, create topics, tag agents, or run commands.
- **Permissions**: Deny-by-default. Owner must explicitly allow which agents each user can tag via the Admin panel.
- **All API endpoints** require a valid session. Unauthenticated requests get 401. Only auth endpoints and static assets are public.
- **WebSocket** connections are authenticated from the session cookie at connection time. Unauthenticated clients cannot join topics, send messages, or run commands.
- **Identity is server-side**: the author of a message is always derived from the session, never from client-supplied fields.

## Security notes

- **Third-party service terms**: When sharing agent access with invited users, ensure the underlying services' Terms of Service permit multi-user or team usage under your account.
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
