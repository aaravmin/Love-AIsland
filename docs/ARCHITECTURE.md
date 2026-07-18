# Love AIsland - Architecture

(The product was renamed from "Reality Island" to "Love AIsland" at the Phase 1 gate; internal package names keep the neutral `@arena/*` scope.)

Status: Phase 0 deliverable, awaiting Aarav's approval.
Companion docs: [DATA_MODELS.md](./DATA_MODELS.md) and [TASK_GRAPH.md](./TASK_GRAPH.md).

## 0. Locked decisions

These override the brief's defaults where they differ.

1. Target game duration is 20-30 minutes, lobby to results.
2. Max ~50 agents, auto-start countdown at 10 or more contestants.
3. Spectators start with 50 tokens; play money, no buy-in, fixed manual cash prizes.
4. Combat is HP with regen, not one-shot.
5. Runtime swarm model is Claude Haiku 4.5 (`claude-haiku-4-5-20251001`) with a $10 hard spend cap per game and a deterministic rule-based fallback.
6. Every market is seeded at creation so priceYes starts at ~1/N of the living population, including late joiners. Never 50%.
7. No selling. Spectators can only buy Yes or No; positions are held to settlement.
8. A contestant's market settles the instant they die: No shares redeem 1 token each, Yes shares zero, credited immediately so tokens recycle into live betting. The winner's market settles Yes at endgame.
9. Public favor, wherever the concept is needed, is the live market price.
10. No simultaneous deaths, ever. All eliminations are strictly serialized so a total death order exists and exactly one survivor remains.
11. Betting is open from the lobby continuously until the game ends.
12. Exactly one concurrent game session, in-memory state, with an operator reset.
13. Contestant owners are publicly visible by name on the panel. Email is never sent to any client.
14. Exactly two events, neither an endgame event: "The Purge" (~1/3 of the timeline, the ~5 contestants with the fewest kills are eliminated) and "Weakest Link" (~2/3, the lowest-HP contestants are eliminated). Both get a 60-second on-screen countdown that is also injected into agent contexts.
15. Endgame forcer is "the island turns hostile": past a time threshold, HP regen decays to zero and agent contexts push toward confrontation. No shrinking zone.
16. Most encounters are social (alliance, truce, nothing). Escalation to a fight depends on class and stats: bold pushes to fight, timid negotiates out.

## 1. Monorepo layout and tooling

Tooling: pnpm workspaces, plain TypeScript project references, no Turborepo.
Three devs and four packages with one non-Next build target do not justify Turbo's config surface.
A `concurrently` script (`pnpm dev`) runs Next plus the server under `tsx watch`.

```
practice-arena/
├── package.json                 # workspace root, dev scripts
├── pnpm-workspace.yaml
├── tsconfig.base.json           # strict, shared compilerOptions; each package extends
├── apps/
│   ├── web/                     # MODULE 1: frontend (Next.js App Router, TS)
│   │   ├── src/app/             # routes: / (spectate), /join, /create, /admin, /demo (React Flow)
│   │   ├── src/game/            # Phaser: scenes, sprite manager, interpolation, tag layer
│   │   ├── src/components/      # shadcn chrome: panels, market list, banners, results
│   │   ├── src/lib/socket.ts    # typed Socket.IO client, snapshot/diff store (zustand)
│   │   └── src/lib/optimistic.ts
│   └── server/                  # MODULE 2: sim server (Node process, deploys to droplet)
│       ├── src/index.ts         # boot: http + Socket.IO + tick loop + swarm wiring
│       ├── src/state.ts         # the single in-memory GameState + mutators
│       ├── src/lifecycle.ts     # lobby -> running -> settled -> reset machine
│       ├── src/tick.ts          # fast clock
│       ├── src/movement.ts
│       ├── src/combat.ts        # fight engine + processDeath() pipeline
│       ├── src/conversationsGate.ts
│       ├── src/events.ts        # Purge, Weakest Link, hostile-mode forcer
│       ├── src/market.ts        # market lifecycle, betting, settlement (uses shared LMSR math)
│       ├── src/protocol.ts      # socket handlers, snapshot/diff assembly
│       └── src/admin.ts
└── packages/
    ├── shared/                  # MODULE 4: shared types package
    │   ├── src/types.ts         # all data models (see DATA_MODELS.md)
    │   ├── src/protocol.ts      # event names + payload types (section 5)
    │   ├── src/lmsr.ts          # PURE math: cost, price, buyBySpend, seedShares — used by BOTH server (authoritative) and client (optimistic)
    │   └── src/balance.ts       # stat budget validation, derived-stat formulas (maxHp from grit, etc.)
    └── swarm/                   # MODULE 3: agent swarm (library consumed by server)
        ├── src/scheduler.ts     # think-tick scheduler, stagger, concurrency semaphore
        ├── src/anthropic.ts     # Haiku client, tool use, prompt caching, timeouts
        ├── src/prompts/         # rules block, class blocks, decision + conversation templates
        ├── src/decisions.ts     # context builder + decision call
        ├── src/conversation.ts  # turn loop + outcome resolution
        ├── src/fallback.ts      # deterministic rule-based behavior (spend cap / timeout / pre-LLM)
        └── src/spend.ts         # usage accounting vs $10 cap
```

`shared` and `swarm` are consumed as source via the workspace protocol with `exports` pointing at `src/`.
Next uses `transpilePackages: ["@arena/shared"]`; the server runs via `tsx` in dev and bundles with `tsup` for deploy.
No intermediate build step exists for three people iterating in parallel, and TS project references keep cross-package type errors visible.

## 2. Module boundaries (the parallel-work contract)

| Module | Owns | Never touches |
|---|---|---|
| `apps/web` | All rendering, Phaser, panels, optimistic bet UX, React Flow demo view | Game rules, prices (only displays authoritative + optimistic-pending) |
| `apps/server` | Authoritative state, fast tick, combat, deaths, events, markets, settlement, socket protocol | Prompts, LLM calls |
| `packages/swarm` | When/how agents think, all prompts, LLM calls, spend cap, fallback behavior | Direct state mutation, sockets |
| `packages/shared` | Types, protocol shapes, LMSR math, stat formulas | Runtime behavior |

The collision-prone seam is server-swarm.
It is frozen as a two-interface contract, defined in `shared`, at the start of Phase 4 (task 4.0).

```ts
// swarm reads the world only through this (server implements)
interface WorldView {
  livingAgents(): AgentBrief[];
  agentContext(id: string): AgentContextView;   // own state + nearby + memory + event modifier
  conversationState(id: string): ConversationView | null;
}
// swarm writes only through this
interface DecisionSink {
  applyDecision(agentId: string, d: AgentDecision): void;         // sets intent; validated by server
  appendConversationMessage(convId: string, m: ConvMessage): void;
  resolveConversation(convId: string, outcome: ConvOutcome): void;
  reportSwarmTelemetry(e: SwarmTelemetry): void;                  // feeds React Flow view + spend meter
}
```

## 3. Process model: swarm runs inside the sim server process

Same Node process, separate package.
State is in-memory for exactly one game, so a separate process would force serializing the world view over IPC for zero benefit.
The swarm is purely I/O-bound (HTTP calls to Anthropic), so it cannot block the tick loop; Node's event loop interleaves them.
Crash isolation buys nothing when the game state dies with the server anyway.
The package boundary, not a process boundary, is what protects the three-dev split.
If it ever needs to split, the WorldView/DecisionSink contract is already the RPC surface.

## 4. Two-clock design

Fast clock: `setInterval` at 150 ms in `tick.ts`.
It handles movement, fight exchanges, regen, the event scheduler, and diff broadcast.
Zero awaits and zero LLM calls; budget is under 5 ms per tick at 50 agents (O(N²) proximity at N=50 is only 2,500 distance checks).

Slow clock: a 1-second scan in `scheduler.ts` finds agents whose `nextThinkAt` has passed (initialized staggered, re-jittered 15-30 s after each think).
It launches decision calls under a concurrency semaphore (cap 8) and applies each decision the moment it resolves via `DecisionSink`.
A hung call times out at 10 s and falls back to the rule engine for that agent for that round.
No slow-clock work ever awaits inside the fast tick; the fast tick only reads the intent field that decisions wrote.

## 5. Realtime protocol (Socket.IO)

All payload types live in `packages/shared/src/protocol.ts`.
Requests use Socket.IO acks.
Discrete events are reliable emits; the per-tick diff uses `volatile.emit` (dropping one position frame under backpressure is invisible because the next tick supersedes it).
Private data goes to per-spectator rooms `spec:{spectatorId}`.

### 5.1 Client to server

| Event | Payload | Ack |
|---|---|---|
| `hello` | `{ clientId: string }` | `{ ok, spectator: PrivateSpectator \| null, snapshot: Snapshot }` — reconnect + snapshot-on-join in one round trip |
| `spectator:join` | `{ clientId, name: string, email: string }` | `{ ok, spectator: PrivateSpectator, snapshot: Snapshot }` |
| `contestant:create` | `{ clientId, name, klass: Class, stats: Stats, persona: string }` | `{ ok, contestant: PublicContestant } \| { ok: false, error }` — validates stat budget via shared `balance.ts`; allowed in lobby and running (late joiners get fair-seeded markets) |
| `bet:place` | `{ betId: string /* client uuid */, contestantId, side: "yes" \| "no", spend: number /* tokens, int, 1..25 */ }` | `{ ok, betId, shares, cost, newBalance, market: { qYes, qNo, priceYes } } \| { ok: false, betId, reason: "insufficient" \| "settled" \| "capExceeded" \| "phase" }` |
| `admin:cmd` | `{ key: string, cmd: "start" \| "reset" \| "forceEvent" \| "forceEndgame", arg? }` | `{ ok }` |

Bets are denominated in tokens spent, not shares; the server computes shares from the LMSR closed form (section 6.4).
This is what makes optimistic UX honest: "spend 10" always costs exactly 10 regardless of races.

### 5.2 Server to client

Snapshot (in the `hello`/`join` ack): full public state.
That is: game phase and timeline, all `PublicContestant`s, all markets (`{contestantId, qYes, qNo, b, priceYes, settled, settledOutcome, sparkline}` with the sparkline downsampled to ~60 points), active conversation summaries, event schedule (kinds and `firesAt` for pending, results for fired), hostile-mode state, spend meter, and `deathOrder`.
Plus, privately, the spectator's own balance and positions.

The per-tick diff (150 ms, volatile):

```ts
type TickDiff = {
  t: number; seq: number;                       // seq gap detection -> client requests fresh snapshot
  moves?: [id: string, x: number, y: number][]; // only sprites that moved
  hp?: [id: string, hp: number][];              // only changed
  prices?: [contestantId: string, priceYes: number][]; // only markets traded since last tick
  regenFactor?: number;                          // present only while decaying (hostile mode)
};
```

Discrete reliable events:

| Event | Payload |
|---|---|
| `game:phase` | `{ phase, startedAt, autoStartAt?, timeline?: { purgeAt, weakestLinkAt, hostileAt } }` |
| `contestant:joined` | `{ contestant: PublicContestant, market: MarketPublic }` (seeded at 1/N) |
| `conv:started` | `{ id, participantIds: string[], x, y }` (positions the island interaction node) |
| `conv:message` | `{ convId, speakerId, text, tone }` |
| `conv:ended` | `{ convId, outcome, fightInitiatorId: string \| null }` |
| `fight:started` | `{ fightId, attackerId, defenderId, betrayal: boolean }` |
| `contestant:died` | `{ contestantId, deathIndex, killerId: string \| null, cause: "combat" \| "purge" \| "weakestLink", settlement: { priceAtDeath } }` — one per death, strictly ordered by `deathIndex` |
| `market:settled` | `{ contestantId, outcome: "yes" \| "no" }` |
| `balance:update` (room `spec:{id}`) | `{ tokens, delta, reason: "bet" \| "deathRedemption" \| "winnerRedemption", contestantId? }` — how death redemptions recycle into live betting instantly |
| `event:countdown` | `{ kind: "purge" \| "weakestLink", firesAt, description }` (60 s warning) |
| `event:fired` | `{ kind, eliminatedIds: string[] /* in death order */, survivorsCount }` |
| `game:hostile` | `{ startedAt, fullDecayAt }` |
| `game:results` | `{ winnerContestantId, winnerOwnerName, winnerPortfolio: { spectatorId, name, tokens }, leaderboard: { name, tokens }[], recap: { totalDeaths, totalBets, biggestUpset } }` |
| `swarm:telemetry` | `{ kind: "decision" \| "convTurn", agentId, action?, reasoning?, latencyMs, inputTokens, outputTokens, cached: boolean, fallback: boolean }` — feeds the React Flow demo view |
| `spend:update` | `{ estimatedUsd, capUsd, throttled: boolean, fallbackActive: boolean }` |

### 5.3 Optimistic bet reconciliation

1. On tap, the client generates a `betId`, runs the same shared `lmsr.ts` against its latest known `(qYes, qNo, b)` to predict shares and price, and immediately renders: balance minus spend, price at the predicted value with a "pending" shimmer, position provisionally increased. It emits `bet:place`.
2. On ack `ok`: replace all provisional numbers with the ack's authoritative `shares/cost/newBalance/market` (they differ only if another bet raced in; cost never differs because bets are spend-denominated). Clear pending.
3. On ack `ok:false`: roll back to pre-bet values and toast the reason.
4. Any `prices` entry in a tick diff or bet ack always overwrites local market state, except while one or more of the spectator's own bets is pending on that market, in which case the client recomputes authoritative-base plus pending-delta. On a `seq` gap, re-request a snapshot.

## 6. Sim server internals

### 6.1 Tick loop (150 ms, strictly ordered, fully synchronous)

```
1. lifecycle checks        (auto-start countdown; endgame detection)
2. movement                (execute every living agent's intent)
3. conversation gating     (proximity scan -> maybe enqueue conversation to swarm)
4. fight engine            (advance active fights; deaths processed inline, serialized)
5. regen                   (hp += rate * regenFactor for eligible agents)
6. event scheduler         (countdowns; fire Purge / Weakest Link; activate hostile mode)
7. price heartbeat         (append priceHistory every ~5s)
8. diff assembly + broadcast
```

Bets and swarm decisions are applied event-driven the moment they arrive.
Node is single-threaded, so they interleave between ticks atomically; the tick only reads their results.

### 6.2 Movement and intent execution

Wander is a small random drift with heading persistence.
Approach and attack steer toward the target; attack transitions to a fight on contact radius.
Flee steers away from the threat with jitter.
LayLow drifts toward the lowest-density map region at reduced speed.
Converse freezes the agent in place for the conversation's duration.
Speed is a base value plus a small instinct bonus, and positions clamp to an island walkable mask precomputed from the tilemap.

### 6.3 Combat with strictly serialized deaths

A fight is an object `{id, attackerId, defenderId, nextExchangeAt}`; exchanges resolve every 4 ticks (~600 ms) and a fight lasts roughly 4-8 exchanges.
Each contestant is in at most one fight (`activeFightId`); a third party with attack intent on a fighter queues and engages the survivor, which produces the "finish the weak winner" dynamic.

Exchange math (tuned in task 5.1 via the headless harness): hit chance `= clamp(0.45 + 0.05*(str_att - ins_def), 0.15, 0.9)`; damage `= 6 + str + U(0,6)`; maxHp `= 60 + 8*grit`.
Class skills: bold gets +50% damage on the first exchange; a schemer betrayal opens with one free hit; timid has a 35% lower probability of being selected as a target; charmer can pull one adjacent ally into the fight (adds an extra exchange against the enemy); wildcard gets a random buff or debuff at each event.

The single death pipeline: all eliminations (combat, Purge, Weakest Link) go through one synchronous function, and it is the only code that can kill.

```ts
function processDeath(id, cause, killerId) {
  // invariant: called only from tick code, never concurrently
  c.alive = false; c.deathIndex = state.deathOrder.length; state.deathOrder.push(id);
  c.diedAt = now; c.killedBy = killerId; c.causeOfDeath = cause;
  if (killerId) { killer.kills++; killer.notoriety += NOTORIETY_PER_KILL; }
  settleMarketNo(id);                    // immediate settlement, before ANYTHING else can die
  dissolveAlliancesOf(id); cancelFightsOf(id); pushMemoryToWitnesses(id);
  emit("contestant:died", ...); emitBalanceUpdates(...);
}
```

Fights advance in a deterministic iteration order (fight creation order).
Within a tick, if multiple fights would produce deaths, each `processDeath` completes fully before the next fight is advanced, so `deathIndex` is always strict and every No-redemption lands before the next elimination.
Event eliminations call it in a loop with defined tie-breaks (section 6.5).
The endgame check (`alive === 1`) runs in step 1 of the next tick, guaranteeing exactly one survivor.

### 6.4 LMSR module (`shared/lmsr.ts`: pure, unit-tested, shared with the client)

Cost function `C(qY,qN) = b·ln(e^{qY/b} + e^{qN/b})`, computed via the log-sum-exp trick (factor out the max) to avoid overflow.
Price: `priceYes = 1/(1 + e^{(qN-qY)/b})`.

Buy by spend (closed form, no numeric solver): spending `c` tokens on Yes gives

```
d = b·ln( e^{c/b}·(e^{qY/b}+e^{qN/b}) − e^{qN/b} ) − qY
```

(symmetric for No). The server applies `qY += d`, deducts exactly `c`, and records a `Trade`.

b derivation: at `p = 0.5`, spending `c` on Yes gives `p' = 1 − 1/(2·e^{c/b})`.
The requirement is that 10 tokens moves the price 5-8 points: b=80 gives +5.9, b=70 gives +6.7, b=60 gives +7.7.
Pick b = 70.
At tail prices moves are larger per token, which is correct and exciting (cheap longshots swing).
A per-trade cap of 25 tokens prevents a single whale from pinning a tail market to 98%.

1/N seeding (exact initialization): at market creation with N living contestants, target `p₀ = clamp(1/N, 0.02, 0.98)` and set

```
qYes = 0,  qNo = b·ln((1 − p₀)/p₀)     // equivalently b·ln(N−1) for the unclamped case
```

Example: N=10, b=70 gives `qNo = 70·ln 9 ≈ 153.8` and priceYes = 0.10 exactly.
A late joiner at current living count N gets the same formula at join time.
In the lobby N grows as contestants join; existing markets are not re-seeded (trades already happened, and bettors arbitraging the drift is a feature).
Seed shares are virtual and unowned; with play money and no selling, market-maker subsidy accounting is moot.

Immediate settlement on death happens inside `processDeath`: mark the market settled with outcome "no"; for every position on it, credit `noShares × 1` tokens via `balance:update`; Yes shares void.
Settled markets reject bets and freeze their sparkline.
Endgame settlement: the winner's market settles "yes" (`yesShares × 1` each), then the leaderboard is final balances (all redemptions already applied) and the highest is the portfolio winner.

### 6.5 Event scheduler and timeline

At game start compute the timeline for an ~18-minute running phase: `purgeAt = start+6m`, `weakestLinkAt = start+12m`, `hostileAt = start+15m`.
Each event has a countdown state machine: at `scheduledAt − 60s`, emit `event:countdown` and inject a context line into every agent's next think (for example: "THE PURGE fires in under a minute. Contestants with the fewest kills are eliminated. A kill now saves you.").

At `scheduledAt`, fire:

- The Purge: `k = min(5, max(0, alive − 6))` eliminations, ordered by ascending kills, tie-broken by lower HP, then lower priceYes, then id. Loop `processDeath(id, "purge", null)`: serialized, each with its own `deathIndex` and immediate settlement.
- Weakest Link: `k = min(4, max(0, alive − 3))`, ascending HP, same tie-break tail, same serialized loop.

The floors (6 and 3) guarantee the events never end the game; the hostile forcer plus combat produce the final deaths.
Watchdog: if `alive > 1` at `start + 25 min`, the operator gets an alert and a `forceEndgame` button (accelerates regen decay to 0 instantly and injects maximal aggression context).
There is no automatic culling of the last two.

### 6.6 Regen and the hostile-mode decay

`hp += regenRate * regenFactor` per tick for agents not in a fight and with `now − lastCombatAt > 5s`.
`regenRate` gives roughly a full heal in 90 s at factor 1, so fight winners stay vulnerable for a meaningful window.
`regenFactor = 1` until `hostileAt`, then lerps to 0 over 3 minutes and stays 0.
It is broadcast in the tick diff while changing.

### 6.7 Notoriety and targeting

Notoriety is +12 per kill with slow decay (−0.5 per think interval).
The target-selection weight, used by the rule fallback and by the "nearby threats" ordering injected into LLM context, is `weight(t) = notoriety_t * (1 − 0.06*charm_t) * proximityFactor * (timid_t ? 0.65 : 1)`.
Public favor for any display or prompt is the live priceYes.

### 6.8 Lifecycle state machine

Lobby: joins, creations, and betting are all open (markets exist from creation).
At 10 or more contestants, `autoStartAt = now + 90s`, cancelled if the count drops below 10; the operator can force-start or hold.
Cap is 50 contestants.

Running: everything above stays open; late contestant joins are allowed until `purgeAt − 60s` (a fresh contestant walking into the Purge with 0 kills would be dead on arrival, so the cutoff keeps late markets meaningful).

Settled: on `alive === 1`, settle the winner market, compute results, broadcast `game:results`, freeze all inputs, stop the swarm.

Reset (operator): `admin:cmd reset` reconstructs a pristine GameState, clears swarm timers and spend state, and broadcasts a fresh lobby snapshot.
Spectator identities may optionally persist their name with a fresh 50 tokens.

## 7. Agent swarm internals

### 7.1 Scheduler

Each agent has `nextThinkAt`, initialized `start + i·(interval/N)` to spread the first wave, then re-jittered `U(15s, 30s)` after each completion.
A 1-second scan collects due, living, non-conversing, non-fighting agents and pushes them through a semaphore.
Concurrency cap is 8: worst case 50 agents per 15 s needs ~3.3 calls/s, and at ~1.5 s median Haiku latency, 8 slots gives ~5.3/s of headroom.
Each decision is applied via `DecisionSink.applyDecision` the instant it resolves; there is no batching, so one slow call never stalls others.
A per-call timeout of 10 s produces a rule-fallback decision for that agent, with telemetry marked `fallback: true`.

### 7.2 Decision call: context template and schema

Request shape targets under 350 input tokens.

```
system[0] (SHARED RULES — cache_control: ephemeral; identical across ALL agents, cached once fleet-wide):
  game rules in ~8 lines: you are a contestant on a survival island; social play
  beats violence unless you're built for it; kills raise notoriety and make you a
  target; alliances protect; the market price next to each name is public favor.
  You must respond by calling the decide tool.

system[1] (PERSONA — cache_control: ephemeral; per-agent, stable all game):
  Name, class card (3 lines of archetype behavior), the owner-written persona blurb,
  stat summary in words ("very strong, not cunning").

user (DYNAMIC, tiny, rebuilt each think):
  HP 41/92. Kills 1. Notoriety high. Your market: 14% and falling.
  Nearby: Rex (bold, healthy, 3 kills, 31%, NOT allied) | Mia (charmer, weak, ally) ...
  Memory: saw Rex kill Jo (40s ago); allied with Mia (2m ago)
  [event line if countdown/hostile active]
```

The call forces a tool response (`tool_choice: {type:"tool", name:"decide"}`), so Haiku returns structurally valid JSON with no parsing heuristics, with `max_tokens: 120`.

```json
{ "action": "wander|approach|attack|flee|layLow|proposeAlliance",
  "target": "contestant id or null",
  "reasoning": "one short line" }
```

Server-side validation in `applyDecision`: the target must be alive and nearby; `attack` on an ally is rejected unless the class is schemer (betrayal is allowed, flagged, and triggers the surprise-bonus opener); anything invalid downgrades to `wander`.
`proposeAlliance` converts to `approach` plus a conversation-request flag that the gate honors.

### 7.3 Conversation engine

Trigger (server-side gate, in the tick): a pair within radius, neither in a fight or conversation, pair cooldown 90 s, a global cap of 6 concurrent conversations, and a base probability of 15% per tick-window boosted by never-met, one party at low HP, a high-notoriety agent nearby, or one party carrying a `proposeAlliance` intent (auto-fire).
The server creates the Conversation (maxTurns drawn 2-4), pins both parties with `converse` intent, and hands off to the swarm.

Turn loop (swarm): alternating speakers; each turn is one Haiku call built from the speaker's cached system blocks plus the transcript so far plus the partner's public info.
It returns via a forced `speak` tool: `{ text: "≤20 words", tone, wantsToEnd: boolean }`.
The loop ends at maxTurns or mutual `wantsToEnd`, and each line streams to clients via `conv:message` as it lands.

Outcome resolution with class-dependent escalation: before the final turn, the server precomputes each participant's allowed outcome set from class, stats, and state.
Fight enters the set only if an escalation score (base 0.15, strongly boosted by bold, scaled by strength, reduced by timid charisma, raised by notoriety pressure and hostile-mode pressure) clears a threshold for at least one participant; timid negotiates out unless cornered (low HP, no allies, hostile mode).
The final turn's tool schema includes `outcome: enum(allowedOutcomes)` plus `fightInitiator`.
The LLM chooses the drama and the rules bound the physics: Haiku can never produce a fight the class system forbids, and bold reliably escalates.
An alliance outcome requires both final tones to be non-hostile, otherwise it downgrades to truce.
The outcome goes to `DecisionSink.resolveConversation`; a fight outcome spawns a fight with the initiator attacking.

### 7.4 Memory management

The memory is a server-owned ring buffer of 6 items, one short line each, written by sim events: a witnessed kill within sight radius, own fights, alliances and betrayals, event warnings, "your price crashed".
The swarm only reads it via `agentContext`.
There is no summarization pass; overflow drops the oldest item, keeping every context flat and bounded forever.

### 7.5 Prompt caching

Both system blocks carry `cache_control: {type: "ephemeral"}`.
Block 0 (shared rules) is byte-identical fleet-wide, so one cache entry serves every call.
Block 1 (persona) caches per agent; the think interval (≤30 s) and conversation turns sit well inside the 5-minute TTL, so effectively all static tokens bill at cache-read rate after each agent's first call.
The dynamic user block stays uncached since it changes every call.

### 7.6 Spend tracking vs the $10 cap

Every response's `usage` accumulates into `SpendState`: `estimatedUsd += in·$1/M + out·$5/M + cacheRead·$0.10/M + cacheWrite·$1.25/M`.
Expected load is comfortably under the cap: roughly 30 living agents on average × ~50 thinks × (~350 in + 80 out) ≈ $1.10, plus ~$0.50 of conversations, so $10 is a genuine guard rather than a constraint.
Escalation ladder: at $8 (soft throttle) think intervals stretch to 30-45 s, the conversation gate probability halves, and maxTurns is forced to 2.
At $10 (hard cap) `fallbackActive = true`: in-flight calls complete but zero new calls are made, and `spend:update` is broadcast so the demo view shows the cap honestly.

### 7.7 Rule-based fallback

A deterministic scorer in `swarm/fallback.ts` serves triple duty: the spend-cap/timeout fallback, pre-Phase-4 testing, and the headless balance harness.
It scores each action from class weights times state features: bold attacks the weakest non-ally in range, else approaches the highest-weight target; timid flees if any high-notoriety agent is near or HP < 40%, else lays low; schemer betrays a weakened ally in the late or hostile game, else proposes alliance to the strongest neighbor; charmer proposes alliance to the nearest unallied agent and clusters with allies; wildcard makes a seeded-random weighted pick.
Event and hostile modifiers add flat aggression weight.
Fallback conversations skip LLM turns entirely: two canned lines per participant from per-class tone template banks, with the outcome drawn from the same escalation score as 7.3, so game dynamics stay intact and only the prose gets canned.

## 8. Deployment topology

Web deploys to Vercel: static/SSR chrome only, all game data over the socket, with `NEXT_PUBLIC_SOCKET_URL=wss://arena.<domain>`.

The server (with the swarm inside it) deploys to one DigitalOcean droplet in NYC3.
The demo audience is in Providence, spectator socket RTT dominates perceived quality, and NYC also gives good Anthropic API latency.
2 vCPU / 4 GB is ample.
It runs under `pm2` for auto-restart, behind Caddy for automatic TLS on a subdomain; Vercel pages are HTTPS, so the socket must be `wss://`.
CORS allowlists the Vercel prod and preview domains.

LLM calls live only on the slow clock, so API RTT is irrelevant to game feel; the topology is not contorted for it.
What matters is doing the droplet, TLS, and CORS setup in Phase 3, not Phase 8: cross-origin websocket issues are the classic demo-day landmine, and every later gate runs against the deployed URL.

Secrets live on the droplet only: `ANTHROPIC_API_KEY` and `OPERATOR_KEY`.
The browser never talks to Anthropic.

Identity: no auth.
The client generates a UUID `clientId` in localStorage; the server maps it to a Spectator and uses it for reconnect.
Email is collected for prize contact and never leaves the server; `ownerName` is the public field.

## 9. UI style directive (from Aarav, applies to all FE work)

Keep shading simple: flat fills and solid colors; no gradients, glassmorphism, heavy drop shadows, glows, or layered elevation effects.
Within that flatness, the palette and typography should be VIBRANT and Love-Island-flavored: hot pink primary, coral/orange and purple accents, a chunky rounded display font for the wordmark and headings.
The market UI stays functional rather than themed, but bold: heavy weights, large percentages, strong trend colors.
Island and character art come from the licensed Sunnyside World pack in `apps/web/assets-src/sunnyside/` (do not redistribute); any custom art must match its quality bar.
The default camera view must always show the entire island; zooming in is allowed, the automatic view is never partial.
Every frontend sub-agent prompt must carry this directive.

## 10. Risks and mitigations

1. The game doesn't converge in 20-30 minutes (too peaceful or too fast). This is the highest product risk. Mitigation: the headless harness (tasks 5.4 and 7.5) tunes combat constants and event floors against wall-clock targets with zero LLM spend before any live run; the timeline events plus the hostile forcer are deterministic backstops; the operator watchdog and forceEndgame at 25 minutes are the last resort.
2. Simultaneous-death or settlement race bugs. The single synchronous `processDeath` pipeline is the only kill path; Node single-threading plus settle-before-next-elimination ordering; invariant unit tests (deathIndex strictly increasing, exactly one survivor, every settled market's redemptions applied exactly once).
3. Haiku output breaks the game (malformed or invalid decisions, latency spikes). Forced tool_choice guarantees schema-shaped JSON; server-side semantic validation downgrades nonsense to `wander`; the 10 s timeout gives a per-call rule fallback; the full rule engine means the game is playable with the LLM entirely off, so the demo can never hard-fail on the API.
4. Optimistic price divergence confusing bettors. Identical LMSR code on both sides via the shared package, spend-denominated bets so cost never surprises, authoritative overwrite on ack and diff, and seq-gap snapshot recovery.
5. Cross-origin wss breakage on demo day. Deployment lands in Phase 3 and every later gate runs against the deployed URL, so the risky infra path gets about five phases of soak.
6. Spend runaway. Projected ~$1.60 per game vs the $10 cap, plus the $8 soft throttle, prompt caching, and hard conversation caps (6 concurrent, 4 turns); the spend meter is on the demo view so a runaway is visible, not silent.
7. Socket and tick load with many spectators. Diffs only, volatile position frames, prices batched into the tick payload, sparklines downsampled in snapshots; 50 agents is trivial CPU, and broadcast is one serialized payload per tick.
8. Three-dev collisions. The four-package layout, the Phase 4.0 frozen WorldView/DecisionSink contract, and all protocol and payload types authored in `shared` at task 1.2 mean every cross-module change is a visible shared-package diff.
9. Class or stat degeneracy (one build dominates, markets get boring). Escalation scoring bounds LLM behavior to class identity; the timid targeting discount and the notoriety gang-up are explicit counterweights; the harness prints per-class survival distributions to catch dominance before demo day.
