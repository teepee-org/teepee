<p align="center">
  <img src="logo.svg" alt="Teepee logo" width="100" height="100">
</p>

# Teepee

**Coordinate AI agents with @mentions.**

Teepee is a self-hosted workspace where humans and AI agents collaborate in topics. Invite teammates, assign roles, structure work with lightweight nested topics, and coordinate with @mentions. Mention an agent, it runs. Mention two, they run in parallel. An agent can mention another and continue the workflow automatically.

This is not just chat. Teepee sits on top of a real project, so coding agents can work on the codebase underneath while humans stay in the same shared context.

Agents can also hand off work to each other: one agent writes the task, tags the next, and execution continues automatically.

Teepee is a product by TypeEffect.

## Quick local eval

Try Teepee in under 5 minutes. Run this from the root of any project:

```bash
npx teepee-cli start
```

On first run, Teepee creates `.teepee/config.yaml` and exits. Run the command again to start the server. Open the owner link printed in the terminal.

For stronger isolation, run Teepee inside a dedicated VM or container. Teepee profiles control access inside that deployment boundary.

## Secure / shared setup

For shared or persistent use, set `mode: shared` in `.teepee/config.yaml` before inviting teammates:

```bash
npx teepee-cli start
```

This requires a sandbox backend (bubblewrap on Linux, Docker on macOS). Agent runs are resolved from the role access matrix: `readonly` and `readwrite` run in the project sandbox, while `trusted` runs with host filesystem access. See [Execution policy](#execution-policy) below for details.

The npm package is `teepee-cli`. If you install it globally, it exposes the `teepee` binary.

## Prerequisites

- Run Teepee from the root of the project you want it to work on
- Install Node.js 20+
- Install at least one agent CLI locally, such as `claude`, `codex`, or `ollama`
- For secure/shared use: install a sandbox backend (`apt install bubblewrap` on Linux, or Docker)

## Why Teepee

Teepee is for the moment when "open a few terminals and coordinate agents by hand" stops scaling.

- Keep humans and agents in the same topic-based workspace
- Organize work with lightweight nested topics instead of heavyweight project boards
- Invite teammates with magic links and role-based permissions
- Trigger agents with `@mentions` instead of bespoke scripts
- Let agents delegate work to each other in public, auditable conversation
- Mix providers like Claude, Codex, and local models in one project
- Keep everything self-hosted and close to the codebase
- Let coding agents operate on the real project with explicit `readonly`, `readwrite`, or `trusted` access profiles

## Getting started

**1. Run Teepee**

```bash
npx teepee-cli start
```

On first run, Teepee creates `.teepee/config.yaml` and exits. It auto-detects installed agent CLIs (`claude`, `codex`, `ollama`). Edit the config if needed, then run the command again.

If you prefer a global install:

```bash
npm install -g teepee-cli
teepee start
```

**2. Configure providers (if needed)**

Teepee auto-detects `claude`, `codex`, and `ollama` in your PATH. On Linux, CLIs installed outside the sandbox-visible directories (`/usr/local/bin`, `/usr/bin`, `/bin`, `/sbin`) — for example in `~/.local/bin` or under `nvm` — are detected, commented out in the generated config, and reported in the terminal. Open `.teepee/config.yaml`, uncomment the providers you want, and run `npx teepee-cli start` again. Teepee will mount the provider paths into the sandbox automatically.

**3. Open the owner link**

Teepee prints an owner login URL to the terminal. Open it to access the workspace.

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
- **Hierarchical topics** — Topics can contain child topics, rendered with slight indentation and moved with simple slash commands. Use `/topic new <name>` to create a child under the current topic.
- **Live presence** — See who is online and which topic each person is in. The sidebar shows a compact presence panel, and `/who` gives the full list.
- **Focus mode** — Use `/focus` to narrow the sidebar to the current topic's subtree. `/unfocus` restores the full tree.
- **Filesystem Explorer** — A sidebar **Files** tab with a lazy tree over all configured filesystem roots, typed preview (Markdown, syntax-highlighted code, images, PDFs), and a right-click context menu that copies markdown-link references and ready-made agent-review prompts to the clipboard.
- **Versioned artifacts** — Long-form documents (specs, RFCs, reports, reviews) are stored as versioned artifacts with an `edit` op that applies small targeted `find`/`replace` changes server-side — typical edits are seconds instead of full-body rewrites.
- **Compose-box file picker** — Type `|` in a message to open a unified picker across filesystem roots and topic hierarchy; selecting a file inserts a markdown link.
- **Live system messages** — Artifact commits, permission events, and decision records appear in the topic transcript in real time, not only after reload.
- **Works on the real project** — Agents run in the project working directory, so they can read files, make changes, and keep the workflow attached to the codebase itself.
- **Specialized roles** — Split work across `@coder`, `@reviewer`, `@architect`, `@devops`, or your own custom agents with per-agent prompts.
- **Any CLI agent** — Works with Claude, Codex, Ollama, or any command that reads stdin and writes stdout.
- **Realtime streaming** — Agent output streams token-by-token via WebSocket.
- **Self-hosted** — Runs on your machine. Your code, your API keys, your control.
- **Markdown native** — All messages are Markdown with syntax-highlighted code blocks, tables, and copy buttons.
- **Web UI** — Clean dark-theme interface with topics, files tab, agent slots, and `@` autocomplete.
- **Auth built in** — Owner login via secret link. Invite users with magic links. Role-based permissions (owner/collaborator/observer). Deny-by-default agent tagging.

## Releases

- [CHANGELOG.md](./CHANGELOG.md) tracks shipped features and fixes.
- [RELEASING.md](./RELEASING.md) documents the repeatable release flow for version bumps, npm publication, Pages updates, and GitHub releases.

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

Teepee reads its project config from `.teepee/config.yaml`. The current schema is v2. Legacy v1 configs are automatically migrated on first start, and a `.config.v2.bak.yaml` backup is written next to the live file.

```yaml
version: 2
mode: private

teepee:
  name: my-project
  language: en           # agent response language

server:
  trust_proxy: false
  cors_allowed_origins: []          # optional extra origins for cross-origin API access
  auth_rate_limit_window_seconds: 60
  auth_rate_limit_max_requests: 20

filesystem:
  roots:
    - id: workspace
      kind: workspace
      path: .

providers:
  claude:
    command: "claude -p --permission-mode acceptEdits --output-format stream-json --verbose"
    timeout_seconds: 180        # idle timeout; the provider is killed if no stdout/stderr chunk arrives for this long (default 180)
    kill_grace_seconds: 5       # SIGTERM → SIGKILL grace window on idle timeout (default 5)
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

roles:
  owner:
    superuser: true                   # owner bypasses the capability list
    agents:
      coder: readwrite
      reviewer: readwrite
      architect: readwrite
      devops: trusted
  collaborator:
    capabilities:
      - files.workspace.access
      - topics.create
      - topics.rename
      - messages.post
    agents:
      coder: readwrite
      reviewer: readonly
      architect: draft
  observer:
    capabilities:
      - files.workspace.access
    agents: {}

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
/new <name>               — create root topic
/topic new <name>         — create child topic under current
/topic language <lang>    — set topic language
/topic rename <name>      — rename topic
/topic archive            — archive topic
/topic move root          — move current topic to root level
/topic move into <id>     — move current topic inside another topic
/topic move before <id>   — move current topic before another topic
/topic move after <id>    — move current topic after another topic
/focus                    — focus on current topic subtree
/unfocus                  — show all topics
/who                      — show who is online
/alias @agent @short      — create alias
/agents                   — list agents
```

## Admin

Click **Admin** in the sidebar (owner only) to:

- **Invite users** — Generate magic links with a user role
- **Manage users** — Change a user's role, revoke access, re-enable, or delete
- **Review access** — Inspect the role-to-agent access matrix from `.teepee/config.yaml`
- **Revoke access** — Instantly invalidate sessions and tokens

This is a shared workspace, not a single-user agent console: multiple humans can join the same Teepee, collaborate in topics, and receive agent access through their role.

> **Shared-use responsibility:** If you invite collaborators to use agents backed by third-party paid services (e.g. Claude, Codex), you are responsible for verifying that those services' Terms of Service allow shared or team use. Teepee does not grant additional usage rights for those services.

## Auth model

- **Owner**: Authenticated via a one-time secret link printed to the terminal at startup. The secret changes on every restart. Works from any device.
- **Users**: Invited via magic link (generated from the Admin panel or CLI). Choose a handle on first access. Session cookie (30 days, HttpOnly).
- **Observers**: Read-only. Cannot post messages, create topics, tag agents, or run commands.
- **Access**: Deny-by-default. A user's role is resolved through `roles[role][agent]` in `.teepee/config.yaml`.
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
cd ~/api && npx teepee-cli serve --port 3000
cd ~/web && npx teepee-cli serve --port 3001
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

Provider commands run according to the **role access matrix**:

```yaml
roles:
  owner:
    superuser: true
    agents:
      coder: trusted
      reviewer: readwrite
  collaborator:
    capabilities:
      - files.workspace.access
      - messages.post
    agents:
      coder: readwrite
      reviewer: readonly
  observer:
    capabilities:
      - files.workspace.access
    agents: {}
```

The mapping is:

```text
roles[role].agents[agent] = effective access profile
missing agent mapping = deny
unknown profile = invalid config
superuser: true on a role bypasses the capability list
```

Built-in profiles:

- `readonly` — provider CLI runs in a read-only codebase sandbox, no artifact write.
- `draft` — provider CLI runs in a read-only codebase sandbox, with artifact document write.
- `readwrite` — provider CLI runs in a read-write codebase sandbox, with artifact document write.
- `trusted` — provider CLI runs with host filesystem access, with artifact document write.

Agents define which provider and prompt to use. Roles define whether an agent can run and with which profile.

**Workspace mode:** `mode: private` is local owner-only operation and can only bind to loopback hosts. `mode: shared` enables invite-based multi-user operation. Teepee no longer exposes an `--insecure` runtime switch; run the whole workspace inside a VM/container when you need a stronger boundary than the host process.

**Agent chain policy:** Agents can delegate work to other agents via mentions in their output. This is governed by `chain_policy`:
  - `none` — mentions in output are persisted as text only, never trigger another agent.
  - `propose_only` — same as `none` (reserved for future approval workflows).
  - `delegate_with_origin_policy` — mentions trigger the target agent, subject to the original requester's role matrix.

The target agent never inherits the source agent's privileges. Chained calls are resolved again as `roles[origin_user_role].agents[target_agent]`.

**Sandbox backends:**

- **Linux**: [bubblewrap](https://github.com/containers/bubblewrap) (`bwrap`). Install with `apt install bubblewrap`.
- **macOS / cross-platform**: Docker-compatible container runtime (`docker` or `podman`).
- If the required sandbox backend is not available and the effective profile requires sandboxing, the run **fails closed** with a clear error — it does not silently fall back to host mode.

Sandboxed runs mount only the project root at `/workspace`, with a private `/tmp` and empty `/home/agent`. Parent directories and the real host home are not mounted. Environment variables are not inherited — only an explicit allowlist is forwarded.

**Configuration example:**

```yaml
security:
  sandbox:
    runner: bubblewrap        # or 'container' for macOS
    empty_home: true
    private_tmp: true
    forward_env: []           # explicit env var allowlist

providers:
  claude:
    command: "claude -p --permission-mode acceptEdits"
    sandbox:                          # provider-specific container runtime
      image: "teepee/claude-runner:latest"  # must include the provider CLI
      command: "claude -p --permission-mode acceptEdits"

agents:
  architect:
    provider: claude
    chain_policy: delegate_with_origin_policy
  coder:
    provider: claude
  reviewer:
    provider: claude

roles:
  owner:
    superuser: true
    agents:
      architect: readwrite
      coder: trusted
      reviewer: readwrite
  collaborator:
    capabilities:
      - files.workspace.access
      - messages.post
    agents:
      architect: draft
      coder: readwrite
      reviewer: readonly
  observer:
    capabilities:
      - files.workspace.access
    agents: {}
```

When sandbox mode uses the **container** backend, the provider must define `providers.<name>.sandbox.image`. Teepee does not fall back to a generic image or silently reuse host-only runtime assumptions. If the configured sandbox runner is unavailable, or the selected provider has no container runtime definition, the run fails closed.

`roles` is the primary access policy. Legacy configs without `roles` are normalized for compatibility, but new configs should use the explicit role matrix.

## License

MIT

## Links

- Website: [teepee.org](https://teepee.org)
- GitHub: [github.com/typeeffect/teepee](https://github.com/typeeffect/teepee)
