import { TICK_MS } from "@arena/shared";
import type { TickDiff } from "@arena/shared";
import { tickAlliances } from "./alliances.js";
import { tickCombat, tickRegen } from "./combat.js";
import { currentRegenFactor, tickEvents } from "./events.js";
import { tickLifecycle } from "./lifecycle.js";
import { drainDirtyPrices, tickPriceHeartbeat } from "./market.js";
import { moveContestants } from "./movement.js";
import { activate, allRooms, type Room } from "./rooms.js";
import { state } from "./state.js";
import { runConversationGate } from "./swarmBridge.js";
import type { ArenaServer } from "./io.js";

// The fast clock (ARCHITECTURE.md 4 and 6.1): fully synchronous, zero awaits.
// Phase 9: one interval drives every room. For each room we activate() its
// state, run the tick steps against the (now global) state, and broadcast the
// diff through the room's own io shim so it only reaches that room's sockets.
// Each room carries its own seq (on room.seq).

export function startTickLoop(_io: ArenaServer): NodeJS.Timeout {
  return setInterval(() => {
    const now = Date.now();
    for (const room of allRooms()) tickRoom(room, now);
  }, TICK_MS);
}

function tickRoom(room: Room, now: number): void {
  activate(room);
  const io = room.io; // room-scoped emitter

  tickLifecycle(io, now, room);

  // Islanders wander in the lobby too (an ambling holding pattern) as well as
  // while running; only the running-phase sim steps below are gated on "running".
  const moves =
    state.phase === "running" || state.phase === "lobby" ? moveContestants(now) : [];

  // Step 3: conversation gating (proximity scan -> maybe start a conversation).
  if (state.phase === "running") runConversationGate(room, now);

  const diff: TickDiff = { t: now, seq: ++room.seq };
  if (moves.length > 0) diff.moves = moves;

  if (state.phase === "running") {
    // Step 3b: scheduled events (Purge, Weakest Link) + the hostile-mode flip.
    tickEvents(io, now);

    // Step 4/5: fight engine (deaths processed inline, serialized) + regen.
    const regenFactor = currentRegenFactor(now);
    const hp = new Map<string, number>();
    for (const [id, v] of tickCombat(io, now)) hp.set(id, v);
    for (const [id, v] of tickRegen(now, regenFactor)) hp.set(id, v);
    if (hp.size > 0) diff.hp = [...hp];
    if (regenFactor < 1) diff.regenFactor = regenFactor;

    // Step 6b: alliance cohesion drift and defection checks. Throttled inside
    // tickAlliances rather than here, because a bloc that re-evaluates itself
    // every 100 ms never survives long enough to be worth anything.
    tickAlliances(now);

    // Step 7: price heartbeat (fills sparklines).
    tickPriceHeartbeat(now);
  }
  // Prices flow whenever markets move, including bets placed in the lobby.
  const prices = drainDirtyPrices();
  if (prices.length > 0) diff.prices = prices;

  io.volatile.emit("tick", diff);
}
