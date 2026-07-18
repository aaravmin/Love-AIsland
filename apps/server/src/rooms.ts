import type { GameState } from "@arena/shared";
import { createCombatState, useCombat, type CombatState } from "./combat.js";
import { createMarketState, useMarket, type MarketState } from "./market.js";
import { createMovementState, useMovement, type MovementState } from "./movement.js";
import { createSocialState, useSocial, type SocialState } from "./social.js";
import { createNotifyState, useNotify, type NotifyState } from "./notify.js";
import { createGameState, replaceState } from "./state.js";
import type { ArenaServer } from "./io.js";

// ---------------------------------------------------------------------------
// Phase 9: multi-room. Each room is an independent game -- its own GameState
// and its own engine sub-state -- keyed by a short join code. The MAIN room is
// the fixed hackathon island the QR flyer points at (one islander per person,
// 20 minutes). Friend rooms are host-created with configurable settings.
//
// The synchronous engine (movement, combat, market, events, lifecycle) still
// reads a single global `state` + module-level maps; the tick and the swarm
// call activate(room) to point those globals at the room being processed
// (safe because everything runs on one thread and each entry point activates
// before it touches state). Broadcasts go through the room's `io` shim so they
// only reach that room's sockets. LLM spend is one shared budget across all
// rooms (product decision).
// ---------------------------------------------------------------------------

export type RoomConfig = {
  agentsPerPerson: number;
  lengthMinutes: number;
  eventCount: number;
};

// Conversation-gate bookkeeping, per room. Its logic + `useGate` live in
// swarmBridge; the state shape lives here so rooms can own an instance without
// a circular import.
export type GateState = {
  convRequests: Map<string, string>;
  pairLastConvAt: Map<string, number>;
  lastGateScanAt: number;
};
export function createGateState(): GateState {
  return { convRequests: new Map(), pairLastConvAt: new Map(), lastGateScanAt: 0 };
}

export type Room = {
  code: string;
  name: string;
  config: RoomConfig;
  isMain: boolean;
  hostClientId: string | null;
  createdAt: number;
  state: GameState;
  io: ArenaServer; // room-scoped emitter (broadcasts only to this room's sockets)
  movement: MovementState;
  combat: CombatState;
  market: MarketState;
  gate: GateState;
  // World event feed, per-pair relationships, and the room's seeded RNG.
  social: SocialState;
  // SMS/notify rate-limit and digest state, kept per room so one room's
  // notification cadence can never throttle or leak into another's.
  notify: NotifyState;
  seq: number;
};

export const MAIN_ROOM_CODE = "MAIN";
export const MAIN_CONFIG: RoomConfig = { agentsPerPerson: 1, lengthMinutes: 20, eventCount: 2 };

const rooms = new Map<string, Room>();
let realIo: ArenaServer | null = null;

// A partial ArenaServer that scopes every broadcast to one Socket.IO room. The
// sim only uses .emit / .to / .volatile.emit, so the rest is intentionally
// absent (cast through unknown).
function makeRoomIo(io: ArenaServer, code: string): ArenaServer {
  return {
    emit: (event: string, ...args: unknown[]) =>
      (io.to(code) as unknown as { emit: (e: string, ...a: unknown[]) => void }).emit(event, ...args),
    to: (target: string) => io.to(target),
    volatile: {
      emit: (event: string, ...args: unknown[]) =>
        (io.volatile.to(code) as unknown as { emit: (e: string, ...a: unknown[]) => void }).emit(
          event,
          ...args,
        ),
    },
  } as unknown as ArenaServer;
}

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function makeCode(): string {
  let out = "";
  for (let i = 0; i < 5; i++) out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return out;
}

function freshRoom(code: string, name: string, config: RoomConfig, isMain: boolean, host: string | null, now: number): Room {
  if (!realIo) throw new Error("rooms not initialised");
  return {
    code,
    name,
    config,
    isMain,
    hostClientId: host,
    createdAt: now,
    state: createGameState(),
    io: makeRoomIo(realIo, code),
    movement: createMovementState(),
    combat: createCombatState(),
    market: createMarketState(),
    gate: createGateState(),
    social: createSocialState(),
    notify: createNotifyState(),
    seq: 0,
  };
}

// Boot: wire the real io and create the always-present MAIN room.
export function initRooms(io: ArenaServer): Room {
  realIo = io;
  const main = freshRoom(MAIN_ROOM_CODE, "Main Island", MAIN_CONFIG, true, null, 0);
  rooms.set(MAIN_ROOM_CODE, main);
  return main;
}

export function createRoom(name: string, config: RoomConfig, hostClientId: string, now: number): Room {
  let code = makeCode();
  while (rooms.has(code)) code = makeCode();
  const room = freshRoom(code, name.trim() || "Friends' Island", config, false, hostClientId, now);
  rooms.set(code, room);
  return room;
}

export function roomByCode(code: string): Room | undefined {
  return rooms.get(code);
}

export function mainRoom(): Room {
  return rooms.get(MAIN_ROOM_CODE)!;
}

export function allRooms(): Room[] {
  return [...rooms.values()];
}

export function runningRooms(): Room[] {
  return [...rooms.values()].filter((r) => r.state.phase === "running");
}

// Which room owns a given contestant / conversation (ids are globally unique),
// so the async swarm can resolve the right room per callback.
export function roomOfAgent(agentId: string): Room | undefined {
  for (const r of rooms.values()) if (r.state.contestants[agentId]) return r;
  return undefined;
}
export function roomOfConversation(convId: string): Room | undefined {
  for (const r of rooms.values()) if (r.state.conversations[convId]) return r;
  return undefined;
}

// Point the global engine state (and the per-module maps) at `room`. Every
// synchronous entry point calls this before touching state. The gate's own
// `useGate` is called separately by its owner (swarmBridge) to avoid a cycle.
export function activate(room: Room): void {
  replaceState(room.state);
  useMovement(room.movement);
  useCombat(room.combat);
  useMarket(room.market);
  useSocial(room.social);
  useNotify(room.notify);
}

// Remove a finished, empty friend room to reclaim memory. MAIN is permanent.
export function disposeRoom(code: string): void {
  if (code === MAIN_ROOM_CODE) return;
  rooms.delete(code);
}
