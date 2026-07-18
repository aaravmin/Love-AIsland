import { randomUUID } from "node:crypto";
import { maxHpFromGrit, validateStats } from "@arena/shared";
import type { Contestant, RoomConfig, RoomInfo, Spectator } from "@arena/shared";
import { handleAdminCmd } from "./admin.js";
import { recordContact } from "./contacts.js";
import { maybeScheduleAutoStart, MAX_CONTESTANTS, MAX_SPECTATORS, startGame } from "./lifecycle.js";
import { randomWalkablePosition } from "./map.js";
import { executeBet, seedMarket } from "./market.js";
import {
  activate,
  allRooms,
  createRoom,
  MAIN_ROOM_CODE,
  mainRoom,
  roomByCode,
  type Room,
} from "./rooms.js";
import {
  aliveCount,
  assembleSnapshot,
  ownedContestantCount,
  spectatorByClientId,
  state,
  toMarketPublic,
  toPrivateSpectator,
  toPublicContestant,
} from "./state.js";
import type { ArenaServer, ArenaSocket } from "./io.js";

// Cap on concurrent rooms so user-created rooms can't exhaust memory.
const MAX_ROOMS = 100;

function roomMeta(room: Room) {
  return { code: room.code, name: room.name, isMain: room.isMain, config: room.config };
}

function roomInfo(room: Room): RoomInfo {
  return {
    ...roomMeta(room),
    phase: room.state.phase,
    islanders: Object.keys(room.state.contestants).length,
    spectators: Object.keys(room.state.spectators).length,
    autoStartAt: room.state.autoStartAt ?? null,
  };
}

function sanitizeConfig(c: unknown): RoomConfig {
  const o = (c ?? {}) as Partial<RoomConfig>;
  const clamp = (v: unknown, lo: number, hi: number, d: number) =>
    Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v as number))) : d;
  return {
    agentsPerPerson: clamp(o.agentsPerPerson, 1, 5, 2),
    lengthMinutes: clamp(o.lengthMinutes, 5, 30, 15),
    eventCount: clamp(o.eventCount, 0, 4, 2),
  };
}

// Resolve (and activate) the room a socket is currently in; defaults to MAIN.
function currentRoom(socket: ArenaSocket): Room {
  const room = roomByCode(socket.data.roomCode ?? MAIN_ROOM_CODE) ?? mainRoom();
  activate(room);
  return room;
}

// Move a socket into `room`: leave the old Socket.IO room + spec room, join the
// new, and activate it. The caller re-resolves the spectator afterward.
function switchSocketToRoom(socket: ArenaSocket, room: Room): void {
  const old = socket.data.roomCode as string | undefined;
  if (old && old !== room.code) void socket.leave(old);
  if (socket.data.spectatorId) void socket.leave(specRoom(socket.data.spectatorId));
  socket.data.roomCode = room.code;
  socket.data.spectatorId = undefined;
  void socket.join(room.code);
  activate(room);
}

const NAME_MAX = 20;
const PERSONA_MAX = 140;

// Lenient international phone check: 7-15 digits, allowing +, spaces, (), -.
function validPhone(raw: string): boolean {
  const digits = raw.replace(/\D/g, "");
  return digits.length >= 7 && digits.length <= 15 && /^\+?[\d\s().-]+$/.test(raw);
}

// An "admin" socket is a direct local connection to the server host, used for
// local development and operator tooling. It bypasses the one-islander-per-
// person rule. In production the sim sits behind Caddy, which sets
// x-forwarded-for, so real users are never treated as local even though the
// proxy hop itself is on loopback.
function isAdminSocket(socket: ArenaSocket): boolean {
  const addr = socket.handshake.address ?? "";
  const forwarded = socket.handshake.headers["x-forwarded-for"];
  const loopback =
    addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
  return loopback && !forwarded;
}

function specRoom(spectatorId: string): string {
  return `spec:${spectatorId}`;
}

export function createContestant(input: {
  name: string;
  klass: Contestant["klass"];
  stats: Contestant["stats"];
  persona: string;
  ownerName: string;
  ownerPhone: string;
  ownerClientId: string;
  now: number;
}): Contestant {
  const spawn = randomWalkablePosition();
  return {
    id: randomUUID(),
    name: input.name,
    ownerPhone: input.ownerPhone,
    ownerName: input.ownerName,
    ownerClientId: input.ownerClientId,
    klass: input.klass,
    stats: input.stats,
    persona: input.persona,
    hp: maxHpFromGrit(input.stats.grit),
    maxHp: maxHpFromGrit(input.stats.grit),
    alive: true,
    kills: 0,
    notoriety: 0,
    x: spawn.x,
    y: spawn.y,
    intent: { kind: "wander" },
    allies: [],
    memory: [],
    deathIndex: null,
    diedAt: null,
    killedBy: null,
    causeOfDeath: null,
    lastCombatAt: null,
    activeFightId: null,
    nextThinkAt: input.now,
  };
}

// Registers a contestant plus its 1/N-seeded market into `room` and broadcasts
// the pair to that room's sockets. The room must already be activated.
export function admitContestant(room: Room, c: Contestant, now: number): void {
  state.contestants[c.id] = c;
  const market = seedMarket(c.id, aliveCount(), now);
  state.markets[c.id] = market;
  room.io.emit("contestant:joined", {
    contestant: toPublicContestant(c),
    market: toMarketPublic(market),
  });
  maybeScheduleAutoStart(room.io, now, room);
}

export function registerHandlers(io: ArenaServer): void {
  io.on("connection", (socket) => {
    // Every socket starts in the MAIN room (the QR hackathon island).
    socket.data.roomCode = MAIN_ROOM_CODE;
    void socket.join(MAIN_ROOM_CODE);

    socket.on("hello", (payload, ack) => {
      if (typeof ack !== "function") return;
      const room = currentRoom(socket);
      const spectator =
        typeof payload?.clientId === "string" ? spectatorByClientId(payload.clientId) : undefined;
      if (spectator) {
        void socket.join(specRoom(spectator.id));
        socket.data.spectatorId = spectator.id;
      }
      ack({
        ok: true,
        spectator: spectator ? toPrivateSpectator(spectator, room.config.agentsPerPerson) : null,
        snapshot: assembleSnapshot(spectator ?? null, roomMeta(room)),
      });
    });

    // ---- Multi-room (Phase 9) ------------------------------------------
    socket.on("room:create", (payload, ack) => {
      if (typeof ack !== "function") return;
      if (allRooms().length >= MAX_ROOMS) {
        ack({ ok: false, error: "Too many games are running right now." });
        return;
      }
      const clientId = typeof payload?.clientId === "string" ? payload.clientId : "";
      const name = typeof payload?.name === "string" ? payload.name.slice(0, 30) : "";
      const room = createRoom(name, sanitizeConfig(payload?.config), clientId, Date.now());
      switchSocketToRoom(socket, room);
      ack({ ok: true, snapshot: assembleSnapshot(null, roomMeta(room)), spectator: null });
    });

    socket.on("room:join", (payload, ack) => {
      if (typeof ack !== "function") return;
      const code = typeof payload?.code === "string" ? payload.code.trim().toUpperCase() : "";
      const room = roomByCode(code);
      if (!room) {
        ack({ ok: false, error: "No game with that code." });
        return;
      }
      switchSocketToRoom(socket, room);
      const clientId = typeof payload?.clientId === "string" ? payload.clientId : "";
      const spectator = clientId ? spectatorByClientId(clientId) : undefined;
      if (spectator) {
        void socket.join(specRoom(spectator.id));
        socket.data.spectatorId = spectator.id;
      }
      ack({
        ok: true,
        snapshot: assembleSnapshot(spectator ?? null, roomMeta(room)),
        spectator: spectator ? toPrivateSpectator(spectator, room.config.agentsPerPerson) : null,
      });
    });

    // The host of a friend room starts it manually (no operator key). MAIN
    // auto-starts and is operator-only.
    socket.on("room:start", (payload, ack) => {
      if (typeof ack !== "function") return;
      const room = currentRoom(socket);
      const clientId = typeof payload?.clientId === "string" ? payload.clientId : "";
      if (room.isMain || !room.hostClientId || room.hostClientId !== clientId) {
        ack({ ok: false });
        return;
      }
      ack({ ok: startGame(room.io, Date.now(), room) });
    });

    socket.on("room:list", (ack) => {
      if (typeof ack !== "function") return;
      ack({ rooms: allRooms().map(roomInfo) });
    });

    socket.on("spectator:join", (payload, ack) => {
      if (typeof ack !== "function") return;
      const room = currentRoom(socket);
      const app = room.config.agentsPerPerson;
      const clientId = typeof payload?.clientId === "string" ? payload.clientId : "";
      const name = typeof payload?.name === "string" ? payload.name.trim() : "";
      const phone = typeof payload?.phone === "string" ? payload.phone.trim() : "";
      const valid =
        clientId.length > 0 &&
        name.length > 0 &&
        name.length <= NAME_MAX &&
        validPhone(phone);
      if (!valid) {
        const existing = clientId ? spectatorByClientId(clientId) : undefined;
        ack({
          ok: false,
          spectator: existing ? toPrivateSpectator(existing, app) : (null as never),
          snapshot: assembleSnapshot(existing ?? null, roomMeta(room)),
        });
        return;
      }

      // Persist every name + phone to the contacts database (deduped).
      recordContact(name, phone);

      // Idempotent by clientId (within this room): a re-join updates the profile
      // instead of minting a second spectator.
      let spectator = spectatorByClientId(clientId);
      if (spectator) {
        spectator.name = name;
        spectator.phone = phone;
      } else {
        if (Object.keys(state.spectators).length >= MAX_SPECTATORS) {
          ack({ ok: false, spectator: null as never, snapshot: assembleSnapshot(null, roomMeta(room)) });
          return;
        }
        spectator = { id: randomUUID(), clientId, name, phone, tokens: 50, notify: false } satisfies Spectator;
        state.spectators[spectator.id] = spectator;
      }
      void socket.join(specRoom(spectator.id));
      socket.data.spectatorId = spectator.id;
      ack({
        ok: true,
        spectator: toPrivateSpectator(spectator, app),
        snapshot: assembleSnapshot(spectator, roomMeta(room)),
      });
    });

    socket.on("contestant:create", (payload, ack) => {
      if (typeof ack !== "function") return;
      const now = Date.now();
      const room = currentRoom(socket);
      const clientId = typeof payload?.clientId === "string" ? payload.clientId : "";
      const spectator = spectatorByClientId(clientId);
      if (!spectator) {
        ack({ ok: false, error: "Join as a spectator before creating an islander." });
        return;
      }
      // Per-person islander limit is the room's agentsPerPerson (MAIN = 1).
      // Local/admin connections may exceed it (seeding and rehearsal).
      if (ownedContestantCount(clientId) >= room.config.agentsPerPerson && !isAdminSocket(socket)) {
        const n = room.config.agentsPerPerson;
        ack({
          ok: false,
          error:
            n === 1
              ? "You've already got an islander in this game."
              : `You've used all ${n} of your islanders in this game.`,
        });
        return;
      }
      // Islanders can only be created before the game starts (lobby). Once it's
      // running or settled, no new islanders -- viewers can still bet.
      if (state.phase !== "lobby") {
        ack({ ok: false, error: "The game has already started - you can still bet, but no new islanders." });
        return;
      }
      if (Object.keys(state.contestants).length >= MAX_CONTESTANTS) {
        ack({ ok: false, error: "The island is full (50 islanders)." });
        return;
      }
      const name = typeof payload?.name === "string" ? payload.name.trim() : "";
      if (name.length === 0 || name.length > NAME_MAX) {
        ack({ ok: false, error: `Name must be 1-${NAME_MAX} characters.` });
        return;
      }
      const persona = typeof payload?.persona === "string" ? payload.persona.trim() : "";
      if (persona.length > PERSONA_MAX) {
        ack({ ok: false, error: `Persona must be at most ${PERSONA_MAX} characters.` });
        return;
      }
      const statsCheck = validateStats(payload.stats);
      if (!statsCheck.ok) {
        ack({ ok: false, error: statsCheck.error });
        return;
      }

      const contestant = createContestant({
        name,
        klass: payload.klass,
        stats: payload.stats,
        persona,
        ownerName: spectator.name,
        ownerPhone: spectator.phone,
        ownerClientId: clientId,
        now,
      });
      admitContestant(room, contestant, now);
      ack({ ok: true, contestant: toPublicContestant(contestant) });
    });

    socket.on("bet:place", (payload, ack) => {
      if (typeof ack !== "function") return;
      const room = currentRoom(socket);
      void room;
      const betId = typeof payload?.betId === "string" ? payload.betId : "";
      const now = Date.now();
      // Betting is open from the lobby continuously until the game ends
      // (ARCHITECTURE.md decision 11).
      if (state.phase === "settled") {
        ack({ ok: false, betId, reason: "phase" });
        return;
      }
      // The bettor is the socket's own spectator (set on hello/join), not a
      // payload field -- a client can't bet as someone else.
      const spectatorId = socket.data.spectatorId;
      const spectator = spectatorId ? state.spectators[spectatorId] : undefined;
      if (!spectator) {
        ack({ ok: false, betId, reason: "insufficient" });
        return;
      }
      const side = payload?.side === "no" ? "no" : "yes";
      const result = executeBet(spectator.id, payload.contestantId, side, payload.spend, now);
      if ("error" in result) {
        ack({ ok: false, betId, reason: result.error });
        return;
      }
      // Private balance update to just this spectator's room.
      io.to(specRoom(spectator.id)).emit("balance:update", {
        tokens: result.newBalance,
        delta: -result.cost,
        reason: "bet",
        contestantId: payload.contestantId,
      });
      ack({
        ok: true,
        betId,
        shares: result.shares,
        cost: result.cost,
        newBalance: result.newBalance,
        market: { qYes: result.qYes, qNo: result.qNo, priceYes: result.priceYes },
      });
    });

    // Toggle SMS portfolio alerts for the caller's spectator in the current
    // room. Idempotent: sets notify to !!on and echoes the stored value back.
    socket.on("notif:setPref", (payload, ack) => {
      if (typeof ack !== "function") return;
      currentRoom(socket);
      const clientId = typeof payload?.clientId === "string" ? payload.clientId : "";
      const spectator = clientId ? spectatorByClientId(clientId) : undefined;
      if (!spectator) {
        ack({ ok: false, notify: false });
        return;
      }
      spectator.notify = !!payload?.on;
      ack({ ok: true, notify: spectator.notify });
    });

    socket.on("admin:cmd", (payload, ack) => {
      if (typeof ack !== "function") return;
      handleAdminCmd(io, payload, ack);
    });
  });
}
