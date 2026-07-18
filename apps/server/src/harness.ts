import { TICK_MS } from "@arena/shared";
import type { Class, Stats } from "@arena/shared";
import { STAT_BUDGET, STAT_KEYS, STAT_MAX, STAT_MIN } from "@arena/shared";
import { fallbackDecision, runConversation, SpendTracker } from "@arena/swarm";
import { createCombatState, setCombatRng, tickCombat, tickRegen } from "./combat.js";
import { currentRegenFactor, tickEvents } from "./events.js";
import { startGame } from "./lifecycle.js";
import { TILE_SIZE } from "./map.js";
import { createMarketState, seedMarket } from "./market.js";
import { createMovementState, moveContestants } from "./movement.js";
import { createContestant } from "./protocol.js";
import { activate, createGateState, initRooms, mainRoom } from "./rooms.js";
import { aliveCount, createGameState, state } from "./state.js";
import { createDecisionSink, createWorldView } from "./swarmBridge.js";
import type { ArenaServer } from "./io.js";

// ---------------------------------------------------------------------------
// Task 5.4: headless balance harness. Runs full games with rule-based agents,
// no LLM and no sockets, on a virtual clock (no real timers), to tune the
// combat constants (5.1) toward ~18 min combat-only convergence. Prints the
// per-game duration and the death-time distribution.
//
// Run: pnpm --filter @arena/server exec tsx src/harness.ts [population] [games]
// ---------------------------------------------------------------------------

// A no-op io: the sim emits events we don't consume here. Includes .to /
// volatile.to so the per-room io shim (rooms.ts) can wrap it.
const noopBroadcast = { emit: () => {} };
const noopIo = {
  emit: () => {},
  to: () => noopBroadcast,
  volatile: { emit: () => {}, to: () => noopBroadcast },
} as unknown as ArenaServer;

initRooms(noopIo); // create the MAIN room the harness games run in

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CLASSES: Class[] = ["bold", "timid", "schemer", "charmer", "wildcard"];

// Random legal build (every stat >= min, remaining budget sprinkled).
function randomStats(rand: () => number): Stats {
  const stats: Stats = {
    charisma: STAT_MIN,
    cunning: STAT_MIN,
    grit: STAT_MIN,
    strength: STAT_MIN,
    charm: STAT_MIN,
    instinct: STAT_MIN,
    resolve: STAT_MIN,
  };
  let remaining = STAT_BUDGET - STAT_MIN * STAT_KEYS.length;
  while (remaining > 0) {
    const open = STAT_KEYS.filter((k) => stats[k] < STAT_MAX);
    const key = open[Math.floor(rand() * open.length)]!;
    stats[key]++;
    remaining--;
  }
  return stats;
}

const CONV_RADIUS_PX = 2.2 * TILE_SIZE;
const CONV_SCAN_MS = 1000;
const PAIR_CONV_COOLDOWN_MS = 90_000;
const THINK_MIN_MS = 15_000;
const THINK_MAX_MS = 30_000;

type GameResult = { converged: boolean; durationMs: number; deathTimes: number[]; survivor: string | null };

async function runGame(seed: number, population: number, maxMinutes: number): Promise<GameResult> {
  const rand = mulberry32(seed);
  // Reset the MAIN room to a fresh game and point the engine at it.
  const main = mainRoom();
  main.state = createGameState();
  main.movement = createMovementState();
  main.combat = createCombatState();
  main.market = createMarketState();
  main.gate = createGateState();
  main.seq = 0;
  activate(main);
  setCombatRng(rand);

  for (let i = 0; i < population; i++) {
    const c = createContestant({
      name: `A${i}`,
      klass: CLASSES[i % CLASSES.length]!,
      stats: randomStats(rand),
      persona: "",
      ownerName: "House",
      ownerPhone: "",
      ownerClientId: "harness",
      now: 0,
    });
    state.contestants[c.id] = c;
    state.markets[c.id] = seedMarket(c.id, aliveCount(), 0);
  }
  // Full running phase incl. the Phase 7 event schedule + hostile timeline, so
  // the harness exercises the real endgame forcer end to end.
  startGame(main.io, 0, main);

  const world = createWorldView();
  const sink = createDecisionSink(noopIo);
  const spend = new SpendTracker();

  const nextThinkAt = new Map<string, number>();
  const pairLastConvAt = new Map<string, number>();
  const deathTimes: number[] = [];
  let recorded = 0;
  let lastConvScan = 0;

  const maxTicks = Math.floor((maxMinutes * 60_000) / TICK_MS);
  let now = 0;
  for (let tick = 0; tick < maxTicks; tick++) {
    now = tick * TICK_MS;

    // Think: due, living, free agents pick a rule decision.
    for (const c of Object.values(state.contestants)) {
      if (!c.alive || c.intent.kind === "converse" || c.activeFightId) continue;
      if (now < (nextThinkAt.get(c.id) ?? 0)) continue;
      const ctx = world.agentContext(c.id);
      if (ctx) sink.applyDecision(c.id, fallbackDecision(ctx, rand));
      nextThinkAt.set(c.id, now + THINK_MIN_MS + Math.floor(rand() * (THINK_MAX_MS - THINK_MIN_MS)));
    }

    moveContestants(now);

    // Conversation gate (one per scan window); await the (unpaced) runner so
    // the outcome — alliance/truce/fight intent — lands before combat this tick.
    if (now - lastConvScan >= CONV_SCAN_MS) {
      lastConvScan = now;
      await maybeStartConversation(world, sink, spend, pairLastConvAt, now, rand);
    }

    // Scheduled events (Purge, Weakest Link) + hostile-mode flip, then combat
    // with the decaying regen factor -- the exact tick order the live server runs.
    tickEvents(noopIo, now);
    tickCombat(noopIo, now);
    tickRegen(now, currentRegenFactor(now));

    while (recorded < state.deathOrder.length) {
      deathTimes.push(now);
      recorded++;
    }
    if (aliveCount() <= 1) {
      const survivor = Object.values(state.contestants).find((c) => c.alive);
      return { converged: true, durationMs: now, deathTimes, survivor: survivor?.name ?? null };
    }
  }
  return { converged: false, durationMs: now, deathTimes, survivor: null };
}

async function maybeStartConversation(
  world: ReturnType<typeof createWorldView>,
  sink: ReturnType<typeof createDecisionSink>,
  spend: SpendTracker,
  pairLastConvAt: Map<string, number>,
  now: number,
  rand: () => number,
): Promise<void> {
  const active = Object.values(state.conversations).filter((c) => c.endedAt === null).length;
  if (active >= 6) return;
  const avail = Object.values(state.contestants).filter(
    (c) => c.alive && c.intent.kind !== "converse" && c.activeFightId === null,
  );
  for (let i = 0; i < avail.length; i++) {
    for (let j = i + 1; j < avail.length; j++) {
      const a = avail[i]!;
      const b = avail[j]!;
      if (Math.hypot(a.x - b.x, a.y - b.y) > CONV_RADIUS_PX) continue;
      const key = a.id < b.id ? `${a.id}:${b.id}` : `${b.id}:${a.id}`;
      if (now - (pairLastConvAt.get(key) ?? 0) < PAIR_CONV_COOLDOWN_MS) continue;
      if (rand() >= 0.3) continue;
      pairLastConvAt.set(key, now);
      const convId = `${a.id}-${b.id}-${now}`;
      state.conversations[convId] = {
        id: convId,
        participants: [a.id, b.id],
        messages: [],
        outcome: "ongoing",
        fightInitiator: null,
        startedAt: now,
        endedAt: null,
        maxTurns: 2 + Math.floor(rand() * 3),
      };
      a.intent = { kind: "converse", convId };
      b.intent = { kind: "converse", convId };
      // Unpaced: resolves fully (no timers) before we return.
      await runConversation({ world, sink, client: null, spend }, convId, { paced: false });
      return;
    }
  }
}

function stats(nums: number[]): { min: number; median: number; max: number } {
  const s = [...nums].sort((a, b) => a - b);
  return { min: s[0] ?? 0, median: s[Math.floor(s.length / 2)] ?? 0, max: s[s.length - 1] ?? 0 };
}

async function main(): Promise<void> {
  const population = Number(process.argv[2] ?? 16);
  const games = Number(process.argv[3] ?? 8);
  const MAX_MINUTES = 45;
  // End-to-end Phase 7 validation: combat thins the field, the two scheduled
  // events cull the weak on the timeline, and hostile mode (regen -> 0 plus
  // universal aggression) forces a single survivor. The metric is that every
  // game converges, and how long it takes.
  console.log(`Harness: ${games} games x ${population} contestants (rule agents, full Phase 7 timeline)`);
  console.log(`Metric: every game converges to one survivor; time to converge\n`);

  const convergeTimes: number[] = [];
  const totalDeaths: number[] = [];
  let converged = 0;

  for (let g = 0; g < games; g++) {
    const r = await runGame(1000 + g * 7919, population, MAX_MINUTES);
    totalDeaths.push(r.deathTimes.length);
    if (r.converged) {
      converged++;
      convergeTimes.push(r.durationMs / 60_000);
    }
    console.log(
      `  game ${g + 1}: ${r.deathTimes.length} deaths; ` +
        (r.converged
          ? `converged at ${(r.durationMs / 60_000).toFixed(1)} min -> winner ${r.survivor}`
          : `DID NOT converge (${population - r.deathTimes.length} still alive at ${MAX_MINUTES} min)`),
    );
  }

  const t = stats(convergeTimes);
  const d = stats(totalDeaths);
  console.log(
    `\nConverged in ${converged}/${games} games. ` +
      `Time (min): min ${t.min.toFixed(1)} / median ${t.median.toFixed(1)} / max ${t.max.toFixed(1)}.`,
  );
  console.log(
    `Total deaths: min ${d.min} / median ${d.median} / max ${d.max} (of ${population}).`,
  );
  console.log(`\nTarget: 100% convergence; the field reaches a single winner well inside hostile mode.`);
}

void main();
