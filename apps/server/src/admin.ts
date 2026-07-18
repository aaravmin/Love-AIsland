import type { AdminCmdAck, AdminCmdPayload } from "@arena/shared";
import { createCombatState } from "./combat.js";
import { armEvent, forceHostile, forceNextEvent, forceVoteNow } from "./events.js";
import { startGame } from "./lifecycle.js";
import { createMarketState } from "./market.js";
import { createMovementState } from "./movement.js";
import {
  activate,
  createGateState,
  MAIN_ROOM_CODE,
  roomByCode,
  type Room,
} from "./rooms.js";
import { createSocialState } from "./social.js";
import { state, createGameState } from "./state.js";
import { forceConversation, forceFallbackNow, resetSwarmState } from "./swarmBridge.js";
import { seedContestants, seedDevContestants } from "./devSeed.js";
import type { ArenaServer } from "./io.js";

// Operator key: required from the environment in production; the dev
// default keeps local operator work frictionless.
export function operatorKey(): string {
  const key = process.env.OPERATOR_KEY;
  if (key) return key;
  if (process.env.NODE_ENV === "production") {
    throw new Error("OPERATOR_KEY must be set in production");
  }
  return "dev-operator";
}

// Shared by every operator-only server boundary. The browser may persist and
// resend the key, but that never grants access by itself: each request is
// validated here against the server-side value.
export function isOperatorKey(key: unknown): key is string {
  return typeof key === "string" && key.length > 0 && key === operatorKey();
}

// Reset one room (ARCHITECTURE.md 6.8): rebuild its state + engine sub-state,
// re-seed MAIN, and broadcast the fresh lobby to that room's sockets. The
// shared LLM budget spans all rooms and is deliberately not reset here.
export function resetGame(io: ArenaServer, room: Room): void {
  room.state = createGameState();
  room.movement = createMovementState();
  room.combat = createCombatState();
  room.market = createMarketState();
  room.gate = createGateState();
  // Rebuilt with the rest of the engine sub-state. Without this a reset would
  // carry the previous game's relationships, alliances, overheard fragments,
  // and event feed into the fresh lobby, so islanders would start a brand new
  // run already holding grudges from a game that no longer exists.
  room.social = createSocialState();
  room.seq = 0;
  activate(room);
  resetSwarmState(room);
  if (room.isMain) seedDevContestants(room.io);
  room.io.emit("game:phase", { phase: "lobby", startedAt: null, autoStartAt: null });
}

export function handleAdminCmd(
  io: ArenaServer,
  payload: AdminCmdPayload,
  ack: (a: AdminCmdAck) => void
): void {
  if (!isOperatorKey(payload?.key)) {
    ack({ ok: false });
    return;
  }
  const room = roomByCode(typeof payload?.room === "string" ? payload.room : MAIN_ROOM_CODE);
  if (!room) {
    ack({ ok: false });
    return;
  }
  activate(room);
  const now = Date.now();
  switch (payload?.cmd) {
    case "start":
      ack({ ok: startGame(room.io, now, room) });
      return;
    case "reset":
      resetGame(io, room);
      ack({ ok: true });
      return;
    case "forceEvent":
      ack({ ok: forceNextEvent(room.io, now) });
      return;
    case "forceEndgame":
      ack({ ok: forceHostile(room.io, now) });
      return;
    case "forceVote":
      // Run THE VOTE now, voting off the purge-equivalent count without waiting
      // for the scheduled event. Only meaningful in a running game.
      ack({ ok: forceVoteNow(room.io, now) });
      return;
    case "setLength": {
      // Set the room's game length (minutes, clamped 5..30). Lobby-only: the
      // length feeds startGame's timeline, so it must be fixed before start.
      const mins = Number(payload?.minutes);
      if (state.phase !== "lobby" || !Number.isFinite(mins)) {
        ack({ ok: false });
        return;
      }
      room.config.lengthMinutes = Math.max(5, Math.min(30, Math.round(mins)));
      ack({ ok: true });
      return;
    }
    case "forceConversation":
      ack({ ok: forceConversation(room) });
      return;
    case "armEvent": {
      // Schedule a Purge/Weakest Link to fire in `seconds` (defaults: purge/60).
      const kind = payload?.eventKind === "weakestLink" ? "weakestLink" : "purge";
      const secs = Number(payload?.seconds);
      const seconds = Number.isFinite(secs) && secs > 0 ? Math.round(secs) : 60;
      ack({ ok: armEvent(room.io, kind, seconds, now) });
      return;
    }
    case "forceFallback":
      // Shared budget across all rooms; broadcast globally.
      ack({ ok: forceFallbackNow(io) });
      return;
    case "seed": {
      // Add house islanders to the room -- lobby or already running.
      const n = Number(payload?.count);
      ack({ ok: seedContestants(room, Number.isFinite(n) ? Math.round(n) : 12) > 0 });
      return;
    }
    case "countdown": {
      // Arm an auto-start countdown shown on the island. Lobby + non-empty only.
      const secs = Number(payload?.seconds);
      if (
        state.phase !== "lobby" ||
        Object.keys(state.contestants).length === 0 ||
        !Number.isFinite(secs) ||
        secs <= 0
      ) {
        ack({ ok: false });
        return;
      }
      state.autoStartAt = now + Math.round(secs) * 1000;
      room.io.emit("game:phase", {
        phase: "lobby",
        startedAt: null,
        autoStartAt: state.autoStartAt,
      });
      ack({ ok: true });
      return;
    }
    default:
      ack({ ok: false });
      return;
  }
}
