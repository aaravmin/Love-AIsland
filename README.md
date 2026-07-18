# Love AIsland

Live reality-TV survival sim with LLM agent contestants and an LMSR prediction market.

## Quick Start

Install dependencies:

```bash
pnpm install
```

Run development servers:

```bash
pnpm dev
```

This starts both the web app and backend server concurrently.

## Project Structure

See [MVP_BUILD_PLAN.md](./MVP_BUILD_PLAN.md) for the project roadmap and architecture overview.

Documentation is available in the `docs/` directory:

- [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)
- [docs/DATA_MODELS.md](./docs/DATA_MODELS.md)
- [docs/TASK_GRAPH.md](./docs/TASK_GRAPH.md)

## Development Commands

- `pnpm dev` - Start web and server in parallel
- `pnpm dev:web` - Start web app only
- `pnpm dev:server` - Start backend server only
- `pnpm typecheck` - Run TypeScript type checking
- `pnpm test` - Run all tests

## Server Environment

The sim server (`apps/server`) reads these variables, all optional in dev:

- `PORT` - listen port, default 4000
- `CORS_ORIGINS` - comma-separated allowlist; dev also accepts private-LAN origins on port 3000 so phones can join by QR
- `OPERATOR_KEY` - admin console key, default `dev-operator` in dev, required in production
- `DEV_SEED` - seed N house contestants at boot and after reset, for local testing (e.g. `DEV_SEED=12 pnpm dev:server`)
- `ISLAND_MAP_PATH` - override the walkable-mask JSON path for deployed layouts
- `CONTACTS_FILE` - where phone numbers collected at join are appended, default `contacts.jsonl`
- `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_FROM` - SMS credentials; with any of them missing every send logs `[sms:noop]` instead, which is the intended local development path

The web app reads:

- `NEXT_PUBLIC_SOCKET_URL` - backend URL; by default it uses the current page hostname on port 4000
- `NEXT_PUBLIC_APP_URL` - optional public/LAN web origin used in room QR links; defaults to the current page origin

[`.env.example`](./.env.example) at the repo root documents every variable the project reads, with defaults.

## Behavior Flags

Agent behavior lives behind feature flags read once at startup from `packages/shared/src/tunables.ts`.
`ISLAND_BEHAVIOR_ALL` is the master switch and **defaults to on**, so a stock `pnpm dev` runs the full game.
Every individual flag overrides the master switch in both directions.

| Variable | Behavior |
| --- | --- |
| `ISLAND_CONVERSATION_VARIETY` | Ordinary topics such as backstory and jokes, not only game talk |
| `ISLAND_STRIP_DASHES` | Islander speech contains no dashes of any kind |
| `ISLAND_VOTE_REASONING` | Votes weigh threat, likability and whether the votes exist |
| `ISLAND_VOTE_DEFLECTION` | A target that senses danger steers votes toward someone else |
| `ISLAND_EARLY_AGGRESSION` | Raised early-game conflict baseline, ramped in over the warmup window |
| `ISLAND_SELF_ODDS` | A coarse private sense of standing, never an exact percentage |
| `ISLAND_MULTI_ALLIANCES` | Alliances of three or more, tracked as groups rather than pairs |
| `ISLAND_ALLIANCE_DEFECTION` | Cohesion decay and members walking out of a fracturing bloc |
| `ISLAND_SPONTANEOUS_OUSTER` | Agent-driven elimination pushes between formal voting events |
| `ISLAND_VOTE_RESOLUTION` | Plurality plus the one tie rule: lower health, then the run seed |
| `ISLAND_WORLD_AWARENESS` | The event feed and world state reach the agent |
| `ISLAND_SPATIAL_AWARENESS` | Compute whether an agent is in a crowded or secluded spot |
| `ISLAND_SPATIAL_BEHAVIOR` | Let that crowded/secluded reading actually change what agents do |
| `ISLAND_OVERHEARING` | Capture fragments of nearby conversations an agent is not in |
| `ISLAND_GOSSIP` | Let those fragments reach speech and decisions, so they spread |
| `ISLAND_MARKET_EVENT_DRIFT` | Odds move on observable events, not only on bets |
| `ISLAND_RELATIONSHIP_MEMORY` | Per-pair trust, threat and affinity that fade but are never erased |
| `ISLAND_OUTCOME_ICONS` | Tension and amicable icons on the island |
| `ISLAND_CALM_CONVERSATIONS` | Islanders move much less while talking |
| `ISLAND_FOLLOW_CAMERA` | The camera can follow one islander or a whole portfolio |
| `ISLAND_RICH_NOTIFICATIONS` | Event-aware SMS about your islander and your positions |
| `ISLAND_CONVERSATION_HISTORY` | The client retains ended transcripts so you can swipe back |
| `ISLAND_CALL_BUDGET` | Cap model calls per tick, degrading to the rule engine rather than stalling |

Several flags are no-ops on their own.
`ISLAND_GOSSIP` needs `ISLAND_OVERHEARING`, `ISLAND_SPATIAL_BEHAVIOR` needs `ISLAND_SPATIAL_AWARENESS`, `ISLAND_VOTE_DEFLECTION` and `ISLAND_EARLY_AGGRESSION` need `ISLAND_WORLD_AWARENESS`, and `ISLAND_MULTI_ALLIANCES`, `ISLAND_SELF_ODDS` and `ISLAND_OUTCOME_ICONS` all degrade without `ISLAND_RELATIONSHIP_MEMORY`.
The full list, along with every numeric tunable, is in `.env.example`.

### Running the pre-spec build

The spec's cross-cutting rule is that all flags off means the game behaves exactly as it did before the behavior work.
That is preserved as a reachable configuration rather than as the default:

```bash
# The exact pre-spec build
ISLAND_BEHAVIOR_ALL=0 DEV_SEED=14 pnpm dev:server

# Pre-spec plus one feature, for an A/B on that feature alone
ISLAND_BEHAVIOR_ALL=0 ISLAND_STRIP_DASHES=1 pnpm dev:server

# Everything except one feature
ISLAND_OVERHEARING=0 pnpm dev:server
```

## Model Backends

Every model call goes through one seam, configured with `SWARM_*` (see `packages/swarm/src/config.ts`).
Whatever the active backend, the rule engine is wired underneath it as an automatic fallback, so the sim keeps running with no model reachable at all.

```bash
# Rule engine only. Deterministic, no model, no network.
# Use this for dialogue-quality iteration and for offline play.
SWARM_BACKEND=rules DEV_SEED=14 pnpm dev:server

# Local model via Ollama. Free per call, so the swarm can make as many calls
# as the hardware allows. The targeted model must actually be installed.
ollama pull llama3.2
SWARM_BACKEND=local pnpm dev:server
SWARM_BACKEND=local SWARM_LOCAL_MODEL=gemma3:4b pnpm dev:server   # pin a different one

# Anthropic. Note the key alone does nothing: the backend factory only reads
# ANTHROPIC_API_KEY when the active backend is the Anthropic one.
SWARM_BACKEND=anthropic ANTHROPIC_API_KEY=sk-ant-... pnpm dev:server

# Free-tier hosted, OpenAI-compatible. Good quality on a small cast, but rate
# limited, so it depends on the per-tick call budget. Requires the hosted
# backend; until it lands, `hosted` is an alias for the Anthropic path.
SWARM_BACKEND=hosted SWARM_HOSTED_BASE_URL=https://api.groq.com/openai/v1 \
  SWARM_HOSTED_MODEL=llama-3.3-70b-versatile SWARM_HOSTED_API_KEY=... pnpm dev:server
```

If the configured model is unreachable, the circuit breaker opens after a few consecutive failures and every subsequent line comes from the rule engine.
That is a silent degradation in the UI, so check the boot log before concluding the writing is bad.

## Workspace Structure

This is a pnpm monorepo with the following directories:

- `apps/` - Web and server applications
- `packages/` - Shared packages and libraries
