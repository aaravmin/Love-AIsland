import { io, type Socket } from "socket.io-client";
import {
  buyShares,
  type AdminCmdAck,
  type AdminCmdPayload,
  type BetPlaceAck,
  type ClientToServerEvents,
  type ContestantCreateAck,
  type ContestantCreatePayload,
  type PrivateSpectator,
  type RoomConfig,
  type RoomInfo,
  type ServerToClientEvents,
  type Snapshot,
  type SpectatorJoinAck,
} from "@arena/shared";
import { toast } from "sonner";
import { getClientId } from "@/lib/clientId";
import { useGameStore } from "@/lib/gameStore";
import { adoptServerFlags } from "@/lib/islandFlags";
import { getRoom, setRoom } from "@/lib/onboarding";
import { outcomePresentation } from "@/lib/outcomes";
import { clearAll, pushSample, seedPosition } from "@/game/interpolation";
import { emitFight } from "@/game/combatEvents";

// Typed Socket.IO client (task 3.4). One socket per browser tab, created
// lazily on first use from any client component; `hello` (identify +
// snapshot in one round trip) runs on every connect, so reconnects
// re-hydrate automatically.

type ArenaSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

const ACK_TIMEOUT_MS = 5_000;
// Seq gaps are expected under volatile emit; re-snapshotting is cheap but
// shouldn't run more than once a second under sustained packet loss.
const SNAPSHOT_COOLDOWN_MS = 1_000;
// How long an ended conversation stays on screen before it's pruned.
const CONV_LINGER_MS = 6_000;

// Activity-feed throttle. The right rail is the ONLY place a viewer at fit
// zoom (bubbles hidden below PILL_MIN_ZOOM) ever reads a spoken line, so
// mirroring every conv:message verbatim -- as it did before this -- makes any
// phrase repetition in the rule engine's small pool read as a scrolling wall
// of near-identical lines. This does not touch the transcript itself
// (addConvMessage below still records every line for the conversation panel);
// it only throttles the feed mirror.
const FEED_RATE_LIMIT_MS = 3_000; // minimum gap between two feed lines from the same agent
const FEED_DEDUPE_WINDOW = 5; // recent lines per agent checked for a near-duplicate
const recentFeedLines = new Map<string, { text: string; at: number }[]>();

function normalizeForDedupe(text: string): string {
  return text.trim().toLowerCase().replace(/[^a-z0-9 ]/g, "");
}

// True when this line should be swallowed rather than pushed to the feed:
// either the same agent spoke too recently, or the (normalized) text matches
// one of their last few lines. Records the line as seen either way so a
// suppressed line still counts toward the agent's recent-lines window.
function shouldThrottleFeedLine(speakerId: string, text: string, now: number): boolean {
  const recent = recentFeedLines.get(speakerId) ?? [];
  const last = recent[recent.length - 1];
  const rateLimited = last != null && now - last.at < FEED_RATE_LIMIT_MS;
  const norm = normalizeForDedupe(text);
  const isDuplicate = recent.some((r) => normalizeForDedupe(r.text) === norm);
  const next = [...recent, { text, at: now }].slice(-FEED_DEDUPE_WINDOW);
  recentFeedLines.set(speakerId, next);
  return rateLimited || isDuplicate;
}

let socket: ArenaSocket | null = null;
let lastSeq: number | null = null;
let lastSnapshotRequestAt = 0;

export function getSocket(): ArenaSocket {
  if (typeof window === "undefined") {
    throw new Error("getSocket is client-only");
  }
  if (!socket) {
    // Follow the page hostname in local development so a phone visiting the
    // LAN URL connects back to the computer running the server, not to the
    // phone's own localhost. Deployments can still override the full URL.
    const url =
      process.env.NEXT_PUBLIC_SOCKET_URL ??
      `${window.location.protocol}//${window.location.hostname}:4000`;
    // Default transports: HTTP long-polling first, then upgrade to WebSocket.
    // A party game is joined from phones on mobile data, hotel/office WiFi, and
    // DNS-filtered networks where a raw WebSocket can be blocked while ordinary
    // HTTP still works; polling-then-upgrade survives that, so we do NOT pin
    // transports to websocket-only. Caddy proxies both the /socket.io/ polling
    // requests and the upgrade, and there is a single server instance so no
    // sticky-session concern.
    socket = io(url, { transports: ["polling", "websocket"] });
    wire(socket);
  }
  return socket;
}

// The room this client is currently in; on reconnect we rejoin it (a fresh
// socket defaults to MAIN server-side) so a friend-room viewer stays put.
function normalizeRoomCode(code: string | null | undefined): string {
  return code?.trim().toUpperCase() || "MAIN";
}

// Module memory is lost on a hard reload, while onboarding deliberately keeps
// the chosen room in localStorage. Restore that capability code before the
// socket's first hello so a refresh never flashes or hydrates the MAIN room.
let joinedRoomCode = normalizeRoomCode(getRoom());

// Apply a snapshot (from hello / room:join / room:create) into the store and
// reseed the interpolation buffer.
function applySnapshot(snapshot: Snapshot, spectator: PrivateSpectator | null): void {
  // Adopt the server's resolved behavior flags before anything renders from
  // this snapshot, so the scene never draws one frame under the wrong flags.
  adoptServerFlags(snapshot.flags);
  const store = useGameStore.getState();
  store.hydrate(snapshot, spectator);
  joinedRoomCode = snapshot.room.code;
  setRoom(snapshot.room.code);
  recentFeedLines.clear(); // a fresh room/run means a fresh cast; stale throttle state would mean nothing
  clearAll();
  for (const c of snapshot.contestants) seedPosition(c.id, c.x, c.y);
  lastSeq = null; // next tick diff re-anchors the gap detector
}

function requestSnapshot(s: ArenaSocket): void {
  const now = Date.now();
  if (now - lastSnapshotRequestAt < SNAPSHOT_COOLDOWN_MS) return;
  lastSnapshotRequestAt = now;
  const clientId = getClientId();
  if (joinedRoomCode !== "MAIN") {
    s.emit("room:join", { clientId, code: joinedRoomCode }, (ack) => {
      if (ack.ok) applySnapshot(ack.snapshot, ack.spectator);
      else {
        joinedRoomCode = "MAIN";
        setRoom("MAIN");
        s.emit("hello", { clientId }, (a) => applySnapshot(a.snapshot, a.spectator));
      }
    });
    return;
  }
  s.emit("hello", { clientId }, (ack) => applySnapshot(ack.snapshot, ack.spectator));
}

function wire(s: ArenaSocket): void {
  s.on("connect", () => {
    useGameStore.getState().setConnected(true);
    lastSnapshotRequestAt = 0;
    requestSnapshot(s);
  });

  s.on("disconnect", () => {
    useGameStore.getState().setConnected(false);
  });

  s.on("game:phase", (payload) => {
    const wasLobby = useGameStore.getState().phase === "lobby";
    useGameStore.getState().applyPhase(payload);
    // A running/settled game snapping back to lobby is an operator reset:
    // the server rebuilt its state from scratch, so re-snapshot rather than
    // patch.
    if (payload.phase === "lobby" && !wasLobby) {
      lastSnapshotRequestAt = 0;
      requestSnapshot(s);
    }
  });

  s.on("contestant:joined", ({ contestant, market }) => {
    const store = useGameStore.getState();
    store.addContestant(contestant, market);
    store.pushFeed({
      kind: "join",
      text: `${contestant.name} stepped onto the island`,
      contestantIds: [contestant.id],
    });
    seedPosition(contestant.id, contestant.x, contestant.y);
  });

  // Conversations (task 4.8): drive the island interaction node + transcript
  // panel. An ended conversation lingers a few seconds so viewers can read the
  // outcome, then is pruned. Each line + outcome also lands in the live feed.
  s.on("conv:started", (p) => useGameStore.getState().startConversation(p));
  s.on("conv:message", (p) => {
    const store = useGameStore.getState();
    // The transcript panel gets every line verbatim, unthrottled -- only the
    // feed mirror below is rate-limited.
    store.addConvMessage(p);
    if (!shouldThrottleFeedLine(p.speakerId, p.text, Date.now())) {
      store.pushFeed({
        kind: "conv",
        speaker: nameOf(p.speakerId),
        text: p.text,
        tone: p.tone,
        contestantIds: [p.speakerId],
      });
    }
  });
  s.on("conv:ended", (p) => {
    const store = useGameStore.getState();
    const conv = store.conversations[p.convId];
    store.endConversation(p);
    if (p.outcome !== "ongoing") {
      const names = (conv?.participantIds ?? []).map(nameOf);
      store.pushFeed({
        kind: "outcome",
        outcome: p.outcome,
        text: `${names.join(" & ") || "Two islanders"} - ${outcomePresentation(p.outcome).phrase}`,
        contestantIds: conv?.participantIds ?? [],
      });
    }
    setTimeout(() => useGameStore.getState().removeConversation(p.convId), CONV_LINGER_MS);
  });

  s.on("tick", (diff) => {
    // Seq-gap recovery (task 3.3): volatile diffs may drop; any hole means
    // missed moves, so re-request a snapshot and re-anchor.
    if (lastSeq !== null && diff.seq !== lastSeq + 1) {
      lastSeq = null;
      requestSnapshot(s);
      return;
    }
    lastSeq = diff.seq;
    if (diff.moves) {
      for (const [id, x, y] of diff.moves) pushSample(id, x, y);
    }
    // HP from combat + regen (Phase 5): drives the contestant panel's health bar.
    if (diff.hp) useGameStore.getState().applyHp(diff.hp);
    // Live market prices (Phase 6): authoritative overwrite of priceYes.
    if (diff.prices) useGameStore.getState().applyPrices(diff.prices);
  });

  // Private balance updates (bet spend, death/winner redemption). Redemptions
  // recycle No-share payouts into live betting; surface them as a toast (6.6).
  s.on("balance:update", (p) => {
    useGameStore.getState().setBalance(p.tokens);
    if (p.reason === "deathRedemption" && p.delta > 0) {
      const name = p.contestantId
        ? useGameStore.getState().contestants[p.contestantId]?.name
        : undefined;
      toast.success(`${name ?? "A contestant"} is out - your No shares paid +${Math.round(p.delta)}`);
    } else if (p.reason === "winnerRedemption" && p.delta > 0) {
      toast.success(`Winner! Your Yes shares paid +${Math.round(p.delta)}`);
    }
  });

  // Combat + death (Phase 5). fight:started is a one-shot flash (event bus);
  // death and settlement update the store, which drives the death animation,
  // the killer's kill count, and the market's settled state. Both also feed
  // the live activity feed.
  s.on("fight:started", (p) => {
    emitFight(p.attackerId, p.defenderId, p.betrayal);
    useGameStore.getState().pushFeed({
      kind: "fight",
      text: p.betrayal
        ? `${nameOf(p.attackerId)} betrays ${nameOf(p.defenderId)}!`
        : `${nameOf(p.attackerId)} squares up to ${nameOf(p.defenderId)}`,
      contestantIds: [p.attackerId, p.defenderId],
    });
  });
  s.on("contestant:died", (p) => {
    const store = useGameStore.getState();
    store.killContestant(p);
    store.pushFeed({
      kind: "death",
      text: p.causeText,
      contestantIds: p.killerId ? [p.contestantId, p.killerId] : [p.contestantId],
    });
  });
  s.on("market:settled", (p) => useGameStore.getState().settleMarket(p));

  // Alliance formation + private thoughts (feed only -- neither touches the
  // store's game state, they're pure broadcast lines).
  s.on("alliance:formed", (p) => {
    useGameStore.getState().pushFeed({
      kind: "alliance",
      text: `${p.aName} and ${p.bName} formed an alliance`,
      contestantIds: [p.aId, p.bId],
    });
  });
  s.on("agent:thought", (p) => {
    const verb = p.kind === "scheme" ? "scheming" : p.kind === "plan" ? "plotting" : "thinking";
    useGameStore.getState().pushFeed({
      kind: "thought",
      text: `${p.agentName} is ${verb}: ${p.text}`,
      contestantIds: [p.agentId],
    });
  });

  // Phase 7: scheduled events + the hostile-mode endgame forcer.
  s.on("event:countdown", (p) => {
    const store = useGameStore.getState();
    store.setEventCountdown({ kind: p.kind, firesAt: p.firesAt, description: p.description });
    store.pushFeed({ kind: "event", text: `Incoming: ${p.description}`, contestantIds: [] });
  });
  s.on("event:fired", (p) => {
    const store = useGameStore.getState();
    store.setEventCountdown(null);
    const label = p.kind === "purge" ? "The Purge" : "The Vote";
    const who = p.eliminatedIds.map((id) => store.contestants[id]?.name ?? "an islander");
    store.pushFeed({
      kind: "event",
      text:
        who.length > 0
          ? `${label}: ${who.join(", ")} eliminated. ${p.survivorsCount} remain.`
          : `${label} passed - nobody met the axe. ${p.survivorsCount} remain.`,
      contestantIds: p.eliminatedIds,
    });
  });
  s.on("game:hostile", (p) => {
    const store = useGameStore.getState();
    store.setEventCountdown(null);
    store.setHostile({ startedAt: p.startedAt, fullDecayAt: p.fullDecayAt });
    store.pushFeed({
      kind: "hostile",
      text: "SUDDEN DEATH - healing is gone and alliances are off. Last islander standing wins.",
      contestantIds: [],
    });
  });

  // Phase 8.3: swarm telemetry + spend, for the /demo architecture view.
  s.on("swarm:telemetry", (p) => useGameStore.getState().applyTelemetry(p));
  s.on("spend:update", (p) => useGameStore.getState().setSpend(p));

  // Phase 8: end-of-game results. Drives the results screen; also clears the
  // hostile/countdown banners and drops a closing line into the feed.
  s.on("game:results", (p) => {
    const store = useGameStore.getState();
    store.setResults(p);
    store.setHostile(null);
    store.setEventCountdown(null);
    const name = store.contestants[p.winnerContestantId]?.name ?? "The winner";
    store.pushFeed({
      kind: "hostile",
      text: `👑 ${name} wins Love AIsland!`,
      contestantIds: [p.winnerContestantId],
    });
  });
}

// Resolve a contestant id to a display name against the current store.
function nameOf(id: string): string {
  return useGameStore.getState().contestants[id]?.name ?? "Someone";
}

function emitWithAck<A>(
  run: (s: ArenaSocket, done: (err: Error | null, ack: A) => void) => void
): Promise<A> {
  return new Promise((resolve, reject) => {
    run(getSocket(), (err, ack) => {
      if (err) reject(new Error("The island server did not respond."));
      else resolve(ack);
    });
  });
}

export function joinSpectator(
  name: string,
  phone: string,
  notify?: boolean,
): Promise<SpectatorJoinAck> {
  return emitWithAck<SpectatorJoinAck>((s, done) =>
    s
      .timeout(ACK_TIMEOUT_MS)
      .emit("spectator:join", { clientId: getClientId(), name, phone, notify }, (err, ack) => {
        if (!err && ack.ok) useGameStore.getState().setSpectator(ack.spectator);
        done(err, ack);
      })
  );
}

export function createContestant(
  payload: ContestantCreatePayload
): Promise<ContestantCreateAck> {
  return emitWithAck<ContestantCreateAck>((s, done) =>
    s.timeout(ACK_TIMEOUT_MS).emit("contestant:create", payload, done)
  );
}

export function adminCmd(
  key: string,
  cmd: AdminCmdPayload["cmd"],
  extra?: { room?: string; count?: number; seconds?: number; minutes?: number; eventKind?: "purge" | "weakestLink" },
): Promise<AdminCmdAck> {
  return emitWithAck<AdminCmdAck>((s, done) =>
    s.timeout(ACK_TIMEOUT_MS).emit("admin:cmd", { key, cmd, ...extra }, done)
  );
}

// ---- Multi-room (Phase 9) --------------------------------------------------
// Each of these switches the socket's room server-side and re-hydrates the
// store from the new room's snapshot.

export function createRoom(
  name: string,
  config: RoomConfig,
): Promise<{ ok: boolean; code?: string; error?: string }> {
  return new Promise((resolve) => {
    getSocket()
      .timeout(ACK_TIMEOUT_MS)
      .emit("room:create", { clientId: getClientId(), name, config }, (err, ack) => {
        if (err || !ack?.ok) {
          resolve({ ok: false, error: (!err && ack && "error" in ack && ack.error) || "Couldn't create the game." });
          return;
        }
        applySnapshot(ack.snapshot, ack.spectator);
        resolve({ ok: true, code: ack.snapshot.room.code });
      });
  });
}

export function joinRoom(
  code: string,
): Promise<{ ok: boolean; error?: string; retryable?: boolean }> {
  return new Promise((resolve) => {
    const targetCode = normalizeRoomCode(code);
    const previousCode = joinedRoomCode;
    // Set the reconnect target before emitting. If Socket.IO is still opening,
    // its connect handler and this buffered join now agree on the destination
    // instead of racing a stale MAIN hello against the requested room.
    joinedRoomCode = targetCode;
    getSocket()
      .timeout(ACK_TIMEOUT_MS)
      .emit("room:join", { clientId: getClientId(), code: targetCode }, (err, ack) => {
        if (err) {
          joinedRoomCode = useGameStore.getState().room?.code ?? previousCode;
          resolve({
            ok: false,
            error: "The island server didn't respond. Try again in a moment.",
            retryable: true,
          });
          return;
        }
        if (!ack?.ok) {
          joinedRoomCode = useGameStore.getState().room?.code ?? previousCode;
          resolve({ ok: false, error: ack?.error || "Couldn't join that game." });
          return;
        }
        applySnapshot(ack.snapshot, ack.spectator);
        resolve({ ok: true });
      });
  });
}

export function startRoom(): Promise<boolean> {
  return new Promise((resolve) => {
    getSocket()
      .timeout(ACK_TIMEOUT_MS)
      .emit("room:start", { clientId: getClientId() }, (err, ack) => resolve(!err && !!ack?.ok));
  });
}

export function listRooms(
  key?: string,
): Promise<{ rooms: RoomInfo[]; isAdmin: boolean }> {
  return new Promise((resolve) => {
    getSocket()
      .timeout(ACK_TIMEOUT_MS)
      .emit("room:list", { key }, (err, ack) =>
        resolve(err || !ack ? { rooms: [], isAdmin: false } : ack),
      );
  });
}

// Toggle SMS portfolio updates; reflects the server's authoritative state back
// into the store spectator so the toggle stays in sync.
export function setNotifPref(on: boolean): Promise<boolean> {
  return new Promise((resolve) => {
    getSocket()
      .timeout(ACK_TIMEOUT_MS)
      .emit("notif:setPref", { clientId: getClientId(), on }, (err, ack) => {
        const next = !err && !!ack?.ok ? ack.notify : on;
        const spec = useGameStore.getState().spectator;
        if (spec) useGameStore.getState().setSpectator({ ...spec, notify: next });
        resolve(next);
      });
  });
}

// Optimistic bet (ARCHITECTURE.md 5.3): predict shares + price with the shared
// LMSR against the latest known quote, render immediately, emit, then overwrite
// with the authoritative ack (they differ only under a race; cost never
// differs because bets are spend-denominated). Roll back on failure.
export function placeBet(
  contestantId: string,
  side: "yes" | "no",
  spend: number,
): Promise<BetPlaceAck> {
  const store = useGameStore.getState();
  const m = store.markets[contestantId];
  const spec = store.spectator;
  if (!m || !spec) return Promise.reject(new Error("Join as a spectator first."));

  const prev = { qYes: m.qYes, qNo: m.qNo, priceYes: m.priceYes };
  const prevBalance = spec.tokens;
  const r = buyShares(m.qYes, m.qNo, side, spend);

  store.setMarketQuote(contestantId, r.qYes, r.qNo, r.priceAfter);
  store.setBalance(prevBalance - spend);
  store.upsertPosition(contestantId, side, r.shares, spend);

  const betId =
    typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}`;

  const rollback = () => {
    store.setMarketQuote(contestantId, prev.qYes, prev.qNo, prev.priceYes);
    store.setBalance(prevBalance);
    store.upsertPosition(contestantId, side, -r.shares, -spend);
  };

  return emitWithAck<BetPlaceAck>((s, done) =>
    s.timeout(ACK_TIMEOUT_MS).emit("bet:place", { betId, contestantId, side, spend }, done),
  )
    .then((ack) => {
      if (ack.ok) {
        // Authoritative overwrite; reconcile the position's share count.
        store.setMarketQuote(contestantId, ack.market.qYes, ack.market.qNo, ack.market.priceYes);
        store.setBalance(ack.newBalance);
        store.upsertPosition(contestantId, side, ack.shares - r.shares, 0);
      } else {
        rollback();
      }
      return ack;
    })
    .catch((e) => {
      rollback();
      throw e;
    });
}
