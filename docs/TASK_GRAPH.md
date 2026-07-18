# Love AIsland - Task Graph

Status: Phases 1 and 2 approved. Phase 3 complete, including deployment.
Tasks 3.1-3.4 and 3.6 built and verified locally; task 3.5 deployed and verified cross-origin (see deploy/README.md).
The deployed URL passes the gate (create flow + many sprites moving); gate evidence in docs/screenshots/phase3/.

Module tags: **FE** = `apps/web`, **SV** = `apps/server`, **SW** = `packages/swarm`, **SH** = `packages/shared`.
Tier tags map to the model/effort table in MVP_BUILD_PLAN.md (A = max reasoning, B = strong coding, C = efficient coding, D = cheap glue).
Every phase ends at the brief's screenshot gate: Playwright screenshots at a desktop width and a ~390 px mobile width, shown to the team for sign-off before the next phase starts.

## Phase 1 - Skeleton and island

| # | Task | Tier | Module | Deps |
|---|---|---|---|---|
| 1.1 | pnpm workspace, tsconfig.base + project refs, lint/format, `pnpm dev` script | D | all | - |
| 1.2 | Data models v1 + protocol event/payload types + stat-budget util. All of the protocol and models are typed now, even where unimplemented; this is the anti-collision contract | D (transcribed from these docs) | SH | 1.1 |
| 1.3 | Next.js shell: routes, Tailwind + shadcn init, responsive layout (canvas + bottom-sheet/drawer chrome) | C | FE | 1.1 |
| 1.4 | Phaser island scene: tileset (water/sand/grass layers), pixelArt true, integer zoom, walkable mask export | C | FE | 1.3 |
| 1.5 | Sprite manager + name/odds tag pills (dummy data), off-screen tag culling | C | FE | 1.4 |
| 1.6 | Camera pan + pinch-zoom (touch + mouse) | C | FE | 1.4 |

Gate: island screenshots, desktop + mobile.

## Phase 2 - Onboarding and character creation

| # | Task | Tier | Module | Deps |
|---|---|---|---|---|
| 2.1 | `/join?room=` QR flow, name + email onboarding, clientId persistence | C | FE | 1.3 |
| 2.2 | Creation screen: class cards, budgeted sliders (30 pts, cap 8, live remaining), persona blurb, preview sprite | C | FE | 2.1, 1.2 |
| 2.3 | Local-stub contestant so the sprite appears with a tag (the authoritative server lands in Phase 3 and replaces the stub) | C | FE | 2.2, 1.5 |

Gate: onboarding, creation, and new-sprite screenshots.

## Phase 3 - Sim server and movement

| # | Task | Tier | Module | Deps |
|---|---|---|---|---|
| 3.1 | Server skeleton: GameState store, lifecycle machine (lobby/auto-start/reset), Socket.IO + CORS, hello/join/create handlers, snapshot assembly | B | SV | 1.2 |
| 3.2 | Fast tick loop + intent execution + wander movement + walkable clamping | B | SV | 3.1 |
| 3.3 | TickDiff assembly/broadcast (volatile, seq), snapshot-on-join, seq-gap recovery | B | SV, SH | 3.2 |
| 3.4 | Client socket layer: typed client, zustand store, snapshot hydrate, position interpolation buffer (~2-tick delay), wire the creation flow to the server | B | FE | 3.3, 2.3 |
| 3.5 | Deploy early: droplet + pm2 + Caddy wss + Vercel envs + CORS verified cross-origin | D | SV, FE | 3.1 |
| 3.6 | Admin: `/admin` page + operator key + start/reset | C | FE, SV | 3.1 |

Gate: recording of many sprites moving smoothly on two devices, one via the deployed URL.

## Phase 4 - Agent swarm and conversations

| # | Task | Tier | Module | Deps |
|---|---|---|---|---|
| 4.0 | Freeze the `WorldView`/`DecisionSink` interfaces in SH | B | SH, SV, SW | 3.2 |
| 4.1 | Prompt design: shared rules block, 5 class blocks, decision tool schema, conversation speak/outcome schemas, escalation instruction language, event/hostile injection lines | **A** | SW | 4.0 |
| 4.2 | Anthropic client: Haiku 4.5, forced tool use, 2-block prompt caching, 10 s timeout, usage accounting into SpendState, $8 throttle / $10 hard cap | B | SW | 4.1 |
| 4.3 | Think scheduler: stagger, 1 s scan, semaphore(8), apply-on-arrival, validation in applyDecision | B | SW, SV | 4.0, 4.2 |
| 4.4 | Rule-based fallback engine (decisions + canned conversations + escalation scorer) | B | SW | 4.0 |
| 4.5 | Conversation gate in the tick (radius, cooldowns, caps, conditions) + converse-intent pinning + Conversation state | B | SV | 3.2, 4.0 |
| 4.6 | Conversation turn loop + allowed-outcome computation + resolution into alliances/fight spawn | B | SW, SV | 4.1, 4.5 |
| 4.7 | Alliance state, memory ring-buffer writers, notoriety plumbing | B | SV | 4.6 |
| 4.8 | Island interaction nodes (spawn/position/fade) + conversation panel with live transcript + tone accents | C | FE | 4.5, 3.4 |

Gate: two contestants with a live interaction node and an open transcript panel. **Met** (docs/screenshots/phase4/).

Status: Phase 4 complete and deployed. The full swarm runs in production (droplet) with the live Haiku path; a `security-audit` pass ran before release.
- 4.0 `packages/shared/src/swarm.ts` — frozen `WorldView`/`DecisionSink` contract.
- 4.1 `packages/swarm/src/prompts.ts` — shared rules + class blocks + decide/speak/resolve tool schemas.
- 4.2 `packages/swarm/src/anthropic.ts` + `spend.ts` — Haiku 4.5, forced tool use, 2-block caching, 10 s timeout, $8 throttle / $10 hard cap.
- 4.3 `packages/swarm/src/scheduler.ts` — staggered 1 s scan, concurrency semaphore (8), apply-on-arrival.
- 4.4 `packages/swarm/src/fallback.ts` + canned conversations in `conversation.ts` — deterministic rule engine (spend-cap/timeout/pre-LLM fallback).
- 4.5/4.6/4.7 `apps/server/src/swarmBridge.ts` — conversation gate, turn loop + escalation scorer + outcome resolution into alliances/fights, alliance/memory/notoriety writers.
- 4.8 FE — `src/lib/gameStore.ts` conversation slice, `IslandScene` interaction nodes, `src/components/conversation-panel.tsx` live transcript.
Verified on production: 18 live Haiku decisions / 0 fallback, 31 in-character conversation lines, spend $0.065 well under cap.
Combat is Phase 5, so a "fight" outcome currently sets attack intent + fires `fight:started`; the fight engine that consumes it lands in 5.2.

## Phase 5 - Combat and death

| # | Task | Tier | Module | Deps |
|---|---|---|---|---|
| 5.1 | Balance spec: hit/damage/regen/skill constants + expected fight length + convergence targets | **A** | SV | 4.7 |
| 5.2 | Fight engine: multi-tick exchanges, one fight per agent, third-party queueing, the serialized `processDeath` pipeline + deathOrder invariant tests | B | SV | 5.1 |
| 5.3 | Regen system + lastCombatAt gating (+ regenFactor hook stub for Phase 7) | B | SV | 5.2 |
| 5.4 | Headless sim harness: full game, rule-based agents, zero LLM calls, asserts a single survivor and prints the death-time distribution; used to tune 5.1 constants toward ~18 min convergence | B | SV, SW | 5.2, 4.4 |
| 5.5 | Fight/death rendering (flash, tween, tag removal), kill count + owner name on the contestant panel | C | FE | 5.2 |

Gate: a fight, a death, and a contestant panel showing an updated kill count. **Met** (docs/screenshots/phase5/).

Status: the combat gate is built, deployed, and verified (production: fights fire, contestants die, the panel shows kills). 5.4 (the tuning harness) is the one open Phase 5 task.
- 5.1 balance constants + 5.2 fight engine + the serialized `processDeath` pipeline: `apps/server/src/combat.ts`. Verified deathIndex strictly increasing (0,1,2,3...), kill/notoriety attribution, immediate market:settled("no").
- 5.3 regen (5 s combat gating, ~90 s full heal, regenFactor=1 until Phase 7) in `combat.ts`, wired as tick steps 4-5 with HP on the diff.
- 5.5 FE: fight-flash + death animation + sprite removal in `IslandScene`, live HP bar, and the clickable contestant panel with the kill count (`src/components/contestant-panel.tsx`).
- 5.4 `apps/server/src/harness.ts` — headless balance harness (full game, rule agents, no LLM/sockets, virtual clock). Run: `pnpm --filter @arena/server exec tsx src/harness.ts [pop] [games]`. Used to tune the 5.1 constants: added the bounded-exchange model (a fight ends inconclusively at its exchange cap, so lethality comes from lopsided matchups, not a death march), then tuned damage / exchanges / regen / cooldown so combat produces ~8-13 deaths and thins the field to the Phase-7 event handoff (~6 alive) over the first several minutes, then **stalls** — combat cannot kill the timid/even-matched core, which is by design what the Purge + hostile forcer finish (7.3/7.5). Full single-survivor convergence is validated in 7.5 with events + forcer enabled.

Phase 5 complete (5.1-5.5 built, verified, deployed; 5.4 harness done). Constants are tuned for the combat-to-events handoff; final endgame pacing is a Phase 7 concern.

## Phase 6 - Prediction market

| # | Task | Tier | Module | Deps |
|---|---|---|---|---|
| 6.1 | `shared/lmsr.ts`: cost (log-sum-exp), price, buy-by-spend closed form, 1/N seed formula, b=70; exhaustive unit tests (round-trips, tails, clamps) | B build, **A** math review | SH | 1.2 |
| 6.2 | Server market lifecycle: seed at creation + late-join fair seed, bet handler (validate / cap 25 / execute / Trade log), settleMarketNo inside processDeath, endgame Yes settlement, balance credits, priceHistory | B | SV | 6.1, 5.2 |
| 6.3 | Over-head odds tags driven by live prices, trend coloring (green/red vs 30 s ago) | C | FE | 6.2, 3.4 |
| 6.4 | Contestant panel odds block: big Yes %, Yes/No cents, Buy buttons, position + potential payout, sparkline, owner name | C | FE | 6.2 |
| 6.5 | Market list view (mobile-primary), sort by probability, balance header; optimistic engine using shared lmsr + reconcile | C | FE | 6.1, 6.4 |
| 6.6 | Lobby-betting UX (odds visible pre-start, settled-market states, death-redemption toast) | C | FE | 6.5 |

Gate: the odds block, a bet visibly moving the price, and the market list. **Met** (docs/screenshots/phase6/) and deployed.

Status: Phase 6 complete and live.
- 6.1 `packages/shared/src/lmsr.ts` (+ `lmsr.test.ts`, 6 passing tests): pure LMSR — cost via log-sum-exp, price, buy-by-spend closed form, 1/N seed, b=70. Shared by server (authoritative) and client (optimistic).
- 6.2 `apps/server/src/market.ts` + `protocol.ts` bet handler: 1/N + late-join seeding, validated bets (cap 25, spend-denominated), Trade log, positions, `settleMarketNo` crediting inside `processDeath`, endgame `settleMarketYes`, priceHistory + 5 s heartbeat, prices on the tick diff.
- 6.3 live over-head odds tags with trend coloring (`IslandScene.syncPills`).
- 6.4 `src/components/contestant-panel.tsx` odds block: big Yes %, Yes/No cents, spend selector, Buy Yes/No, position + payout, sparkline.
- 6.5 `src/components/markets-list.tsx`: balance header, sorted by probability, click-to-open; `src/lib/socket.ts` `placeBet` optimistic engine (shared LMSR predict → authoritative ack reconcile → rollback).
- 6.6 lobby betting (open pre-start), settled-market states (WON/OUT), death/winner-redemption toasts.
Verified: a Buy Yes moved Rico 25%→35% across the panel, the tag, and the market list, with the balance and position updating; the over-cap bet was rejected; LMSR tests green.

## Phase 7 - Two events + endgame forcer (revised from the brief's 3-event design)

| # | Task | Tier | Module | Deps |
|---|---|---|---|---|
| 7.1 | Timeline computation at start; event scheduler with countdown state; The Purge (k = min(5, alive-6), tie-break chain, serialized processDeath loop) and Weakest Link (k = min(4, alive-3), ascending HP) | B | SV | 5.2, 6.2 |
| 7.2 | Countdown + hostile context injection into agent thinks; fallback-engine event modifiers | B | SW | 7.1, 4.3 |
| 7.3 | Hostile mode: regenFactor decay over 3 min, aggression pressure in the allowed-outcome/escalation scoring, 25-min watchdog + operator forceEndgame | B | SV, SW | 7.1, 5.3 |
| 7.4 | FE: 60 s countdown banner, event-fired modal (eliminated list), hostile-mode ambient indicator (tint/vignette + label) | C | FE | 7.1 |
| 7.5 | Headless-harness rerun with events + forcer enabled: verify a 15-20 min running phase and no sub-2 population before hostile mode | B | SV | 7.3, 5.4 |

Gate: screenshots of both countdowns, both events fired with their elimination lists, and the hostile-mode banner.

Status: Phase 7 complete and deployed.
- 7.1 `apps/server/src/events.ts`: `tickEvents` raises 60 s countdowns and fires due events through the one serialized `processDeath` pipeline (settles each market No before the next elimination).
  The Purge culls the bottom third by combat strength (`kills*100 + strength + grit + hp`), floored at 4 survivors; the Weakest Link sends home the single lowest-priced islander (the audience's least-backed), floored at 3. Neither can end the game.
- 7.2 event context injection: `currentEventModifier` populates `WorldView.agentContext().event`, which the swarm already consumes - the LLM prompt gains the event line and the rule engine gains aggression pressure. No swarm-package change needed beyond the existing hooks.
- 7.3 hostile-mode endgame forcer: `currentRegenFactor` lerps regen 1 -> 0 over 3 min then pins at 0; the fallback engine gains a universal "hunt the nearest islander" clause under hostile mode and `DecisionSink` lets anyone attack an ally once hostile (alliances dissolve). Operator `forceEvent` / `forceEndgame` wired in `admin.ts` behind the existing operator-key gate.
- 7.4 FE: `event-banner.tsx` (live-ticking countdown, then the persistent SUDDEN DEATH banner), plus event/hostile entries in the new activity feed. Regen decay is surfaced on the tick diff (`regenFactor`).
- 7.5 harness reworked into an end-to-end Phase 7 validator (`startGame` + `tickEvents` + decaying regen): **100% convergence to a single winner** across 16-pop x8 and 40-pop x5 runs, converging ~17-22 min (2-6 min into hostile mode).
  Verified live on production: forced Purge eliminated 2 (floor held at 6), Weakest Link 1, hostile activated, all three markets settled No, betting unaffected.

### Spectate-view redesign (shipped with Phase 7)
- The right rail is now the **live activity feed** (`activity-feed.tsx`) - a chat-style, high-contrast broadcast overlay fed by a client-derived feed slice (`gameStore` `feed`) from conversation lines, fights, eliminations, and events. A contestant's panel shows their own filtered slice of it.
- **Markets** moved to a bottom tab that expands to a full-screen board (`markets-sheet.tsx`); picking a row opens that islander's panel.
- The **contestant panel** (`contestant-panel.tsx`) was rebuilt to show stats (capability bars), class behavior, the win market + Buy Yes/No + position, and the personal feed - fixing the earlier click-to-open breakage.
- **Class and stats are now independent** in `create-form.tsx`: picking a class only sets behavior and no longer overwrites the stat sliders (stats = how good they are; class = how they play). This matches how the server already treated them.

## Phase 8 - Settlement, results, and the demo view

| # | Task | Tier | Module | Deps |
|---|---|---|---|---|
| 8.1 | Endgame detection, winner settlement, leaderboard + recap payload, input freeze | B | SV | 7.3, 6.2 |
| 8.2 | Results screen: contestant winner (+ owner name), portfolio winner, leaderboard, recap stats | C | FE | 8.1 |
| 8.3 | React Flow swarm/architecture view on `/demo`: agent nodes, scheduler + model nodes, edges pulse on `swarm:telemetry`, live spend meter + fallback indicator | C | FE | 4.3 |
| 8.4 | Mobile polish pass: market-list-primary layout, island ambient, tap targets, safe areas | C | FE | 6.5, 7.4 |
| 8.5 | QR flyer asset | D | FE | 2.1 |
| 8.6 | Dress rehearsal: two full deployed games (one forced into fallback to prove the cap path), operator runbook, reset verified | C | all | everything |

Gate: results screen + architecture view on a large display.

Status: Phase 8 complete and deployed (8.1-8.6).
- 8.1 `lifecycle.ts` endgame: on the last-islander-standing detection the phase flips to `settled` (the input freeze - movement/combat/events are gated on `running`, bet:place rejects when settled), the winner's market settles Yes (redeeming winning Yes positions), and `buildResults` assembles the winner + owner, the richest betting portfolio, the token leaderboard (top 10), and recap stats (eliminations, bets, biggest-upset = how low the winner's market ever traded). Emitted as `game:results`; the winner id also rides the snapshot so a late-joining client shows a minimal card.
  Verified end to end: a 2-islander game converged, `game:results` carried the full payload, and a winning Yes bet redeemed (+15.3 tokens).
- 8.2 `results-screen.tsx`: full-screen hot-pink results overlay (winner spotlight, top portfolio, leaderboard, recap), dismissible to peek at the final island, cleared on reset. Driven by the `game:results` event with a snapshot-winner fallback.
- 8.3 `/demo` swarm architecture view (`app/demo/swarm-flow.tsx`, React Flow): each living islander is an agent node feeding a scheduler node feeding the Claude Haiku node; edges pulse on `swarm:telemetry` (green = LLM, amber = rule fallback) and a spend meter tracks the $10 cap with throttled/fallback badges. Telemetry + spend are consumed via a new `gameStore` slice (`applyTelemetry`/`setSpend`). Verified live: nodes render, edges pulse, telemetry accumulates.
- 8.4 mobile polish: `viewport-fit=cover` + `env(safe-area-inset-*)` padding on the top bar and bottom markets tab (notch/home-indicator safe); the forgiving nearest-sprite picker already handles tap targets; island stays the ambient backdrop with markets in the bottom sheet.
- 8.5 `/flyer` printable QR flyer (`qrcode`): Love AIsland branding + a QR encoding `window.location.origin` (works for any deployment) + "scan to play" CTA. Verified the QR renders.
- 8.6 dress-rehearsal tooling: operator `forceFallback` command (`SpendTracker.forceFallback` + `swarmBridge.forceFallbackNow`) flips the swarm to the rule engine on demand to prove the cap path without real spend - wired into the admin console; `docs/OPERATOR_RUNBOOK.md` written. Verified on production: `forceFallback` flips `fallbackActive`, `forceConversation`/`forceEvent`/`forceEndgame` all work, and a full 6-islander game runs with live LLM telemetry, conversations, and a clean reset between games.

Phase 8 (and the 8-phase MVP) complete. The whole loop is live: create -> swarm sim -> combat -> events -> hostile forcer -> single winner -> settlement -> results, with the LMSR betting layer throughout and the architecture view on /demo.

### Interaction + access fixes (shipped alongside Phase 8)
- **Click-to-select rebuilt** as a forgiving nearest-sprite picker (`IslandScene.selectNearest`): a scene-level pointer handler selects the closest islander within a zoom-aware radius instead of requiring a pixel-exact hit on a tiny, moving sprite. Verified with a headless-Chrome repro that direct hits and ~12px near-misses both open the panel, on mobile (zoom 0.41) and desktop.
- **One islander per person**: the create handler rejects a second islander for a clientId that already owns one; `PrivateSpectator.ownedContestantId` lets the client hide the "Join as islander" CTA once you have one. Local/admin sockets (loopback, no `x-forwarded-for`) bypass the limit for seeding/rehearsal - verified that production, behind Caddy, correctly enforces one per person.
- **Operator force powers**: `forceEvent`, `forceEndgame`, and new `forceConversation` (forces an interaction between the two nearest available islanders) wired into the admin console behind the operator-key gate; the console prefills the dev key on localhost.

## Critical path and parallelism

Critical path: 1.1 → 1.2 → 3.1 → 3.2 → 4.0 → (4.x swarm chain) → 5.2 → 6.2 → 7.1 → 8.1.

The four-person split follows the four module boundaries.
The FE dev runs 1.3 through 2.3 while the SV dev does 3.x and the SW dev drafts 4.1 and 4.4.
After 4.0 freezes the contract, all three lanes are independent until the 8.6 rehearsal.

## Phase 9 - Multi-room (Kahoot-style) + Kalshi/Polymarket betting UI

Post-MVP. In progress.

### Shipped and live
- **Betting UI redesign**: Kalshi-style Yes/No prices in cents with "to win +N" payout on each buy button (`contestant-panel.tsx`), the market list shows Yes/No cents (`markets-list.tsx`), and a Polymarket-style filled-area price chart replaces the old sparkline (`price-chart.tsx`).
- **Multi-room UX (client mock, for approval)**: a top-right "Games" control (`games-menu.tsx`) to create a game (name + islanders-per-person + length + random-event sliders) -> a Kahoot-style 5-char join code + host lobby with a Start button, or join a friend's game by code. Backed by a mock store (`roomsStore.ts`); the fixed `MAIN` room stays 1-islander/20-min. This is UX-only until the server engine lands.

### Locked decisions
- LLM cost: **one shared $10 budget across all rooms** (every room can use Claude; when the shared cap hits, all rooms fall back to the rule engine).
- Friend-room start: **host starts manually** (creator gets a Start button); the main room keeps its auto-start.

### Server engine - shipped and live
- `rooms.ts` registry keyed by a 5-char join code; `MAIN` (1 islander/person, 20 min) always exists. Each room bundles its own `GameState`, per-room engine sub-state (`MovementState`/`CombatState`/`MarketState`/`GateState`), and a room-scoped `io` shim so `io.emit` only reaches that room's sockets. `activate(room)` points the global `state` (ES live binding) + the module sub-state at the room being processed.
- One tick loop iterates all rooms (`tick.ts`); one swarm loop + one shared `SpendTracker` drive every room (shared $10 budget). The single room-aware `WorldView`/`DecisionSink` resolve the room per agent/conversation (`roomOfAgent`/`roomOfConversation`), so async LLM callbacks always write to the right room.
- Per-room timeline + events from the room's `config` (`lengthMinutes` scales the Purge/Weakest-Link/hostile schedule; `eventCount` chooses how many events run). Per-person islander cap = the room's `agentsPerPerson`.
- Protocol: `room:create` / `room:join` (by code) / `room:start` (host-only, no operator key) / `room:list`; a socket belongs to one room and switches with a re-hydrate. `admin:cmd` takes a `room` code (defaults MAIN). Snapshot carries `room` meta; `PrivateSpectator.agentsRemaining` drives the join CTA.
- Client: `GamesMenu` (top-right) create/join/switch/start via real sockets; `gameStore.room` tracks the current room; reconnect rejoins the friend room.
- Verified on production: friend room created with its config, per-room agent cap enforced through Caddy, friend joins by code and sees the islanders, MAIN stays isolated, host-only start works, MAIN resets clean. Engine regression: harness still converges 100%.

Phase 9 core (multi-room + Kalshi/Polymarket betting UI) complete and deployed.
