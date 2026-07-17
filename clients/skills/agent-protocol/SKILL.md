---
name: agent-protocol
description: Standard protocol for AI coding agents working in the MDX dev platform (CodeForge, Crucible, Velocity). Covers agent registration, liveness through run ingests, identity, and service discovery. Use when an agent starts work on any registered project, connects to platform services, or needs to maintain liveness with CodeForge/Crucible/Velocity.
---

# Agent Protocol

Standard behavior for any AI agent (Claude Code instance) working in the MDX development platform.

## Core Principle

**If you're registered with a service, keep it alive by reporting real work.**
For Crucible, ingest is the heartbeat: every run you post (`/api/v2/runs`,
`/api/v2/runs/parsed`, `/api/v2/runs/compile`) touches your agent. A TDD agent
that ingests every RED/GREEN/regression run never needs a dedicated ping.

## Agent Identity

On first contact with any service, identify yourself from project context. Priority order:

1. **CLAUDE.md** — look for `agent_id` or project name → `source: "claude-md"`
2. **package.json** — `name` field → `source: "package-json"`
3. **git remote / directory name** → `source: "git-repo"`
4. **Manual** — hardcoded or configured → `source: "manual"`

Identity payload (send once inside `identity` on register, preserved across touches):
```json
{
  "agentId": "<unique-id>",
  "displayName": "<human-readable-name>",
  "source": "claude-md|package-json|git-repo|manual",
  "repoPath": "<absolute-path-to-project>"
}
```

**Naming convention:** `<agent-type>-<project-key>` e.g. `claude-codeforge-ui`, `tester-entity-router`

## Liveness Protocol

### How liveness works
- **Register once** at session start (`POST /api/v2/agents/register` — an upsert).
- **During work** — every run ingest counts as the heartbeat; there is nothing
  extra to send.
- **Status change** (idle → busy, busy → idle) — touch
  `POST /api/v2/agents/heartbeat` (same handler as register) with the new
  `status` + `message`. This is the only time a manual touch is warranted.

### When to stop
- Told to unregister
- Work on the project is complete
- Session ending

### Touch Payload (register and heartbeat are the same upsert)
```json
{
  "agentId": "<id>",
  "projectKey": "<key>",
  "status": "online|busy",
  "message": "<what you're doing right now>"
}
```

### Status Values
| Status | Meaning | When to use |
|--------|---------|-------------|
| `online` | Active, available | Default — idle or light work |
| `busy` | Actively executing | Running tests, building, deploying |

### Liveness Thresholds (service-side decay — information, not a ping schedule)
| State | After | Visual |
|-------|-------|--------|
| Online | Run ingested / agent touched | 🟢 Green |
| Stale | 60s no activity | 🟡 Yellow |
| Offline | 300s no activity | ⚪ Grey |
| Removed | 1h offline | Gone |

These describe how the dashboard decays idle agents; they are configurable per
service. Do not build a ping loop around them — a normally-ingesting agent
stays green by doing its job.

## Service Registry

| Service | Port | Agent Endpoint | Purpose |
|---------|------|----------------|---------|
| **Crucible** | 3849 | `POST /api/v2/agents/heartbeat` | Test dashboard |
| **CodeForge** | 8090 | `POST /api/agents/heartbeat` (legacy v1 — CodeForge has not adopted the v2 API; out of Crucible CR scope) | Agent orchestration |
| **Velocity** | 3001 | _(planned)_ | SCRUM tracker |

## Helper Script

Use `scripts/heartbeat.sh` for any service:

```bash
scripts/heartbeat.sh <agent-id> <project-key> [status] [message] [service-url]
```

It targets the Crucible v2 agent touch by default; the touch upserts, so it
also serves as a one-shot registration.

## Workflow

1. **Start of session** → Identify yourself, register with identity
2. **During work** → run ingests ARE the liveness signal; nothing extra to send
3. **Status changes** → update status + message via the agent touch
4. **End of session** → unregister (`POST /api/v2/agents/unregister`); otherwise the service decays you to stale → offline
