import { create } from "zustand";
import { winProbabilities } from "@arena/shared";
import type {
  ContestantDiedPayload,
  ConvEndedPayload,
  ConvMessagePayload,
  ConvStartedPayload,
  GamePhasePayload,
  GameResultsPayload,
  MarketPublic,
  MarketSettledPayload,
  Position,
  PrivateSpectator,
  PublicContestant,
  RoomMeta,
  Snapshot,
  SpendUpdatePayload,
  SwarmTelemetryPayload,
  TickDiff,
  Tone,
} from "@arena/shared";
import { islandFlags } from "@/lib/islandFlags";

// The client's authoritative game state, hydrated from the server Snapshot
// and patched by discrete socket events (see src/lib/socket.ts). Sprite
// positions deliberately do NOT flow through here per tick -- the
// interpolation buffer (src/game/interpolation.ts) carries those at 150 ms
// cadence so React subscribers only re-render on real state changes; the
// x/y stored on contestants is only the position as of hydration/join.

// A live conversation the FE tracks for the interaction node + transcript
// panel (task 4.8). Messages stream in via conv:message; outcome/endedAt land
// on conv:ended, after which the socket layer prunes it a few seconds later.
export type ClientConversation = {
  id: string;
  participantIds: string[];
  x: number;
  y: number;
  messages: { speakerId: string; text: string; tone: Tone }[];
  outcome: ConvEndedPayload["outcome"] | null;
  endedAt: number | null;
};

// A single line in the live activity feed (the right-hand "broadcast chat").
// Derived entirely on the client from discrete socket events; `contestantIds`
// lets a contestant's detail panel filter the feed down to just their moments.
export type FeedKind = "conv" | "outcome" | "fight" | "death" | "event" | "hostile" | "join" | "alliance" | "thought";
export type FeedEntry = {
  id: number;
  t: number;
  kind: FeedKind;
  text: string;
  speaker?: string;
  tone?: Tone;
  // Set on `outcome` rows so the feed can render the same glyph the island
  // marker and the transcript panel use (see src/lib/outcomes.ts) instead of
  // inventing a third mapping.
  outcome?: ConvEndedPayload["outcome"];
  contestantIds: string[];
};

// A pending scheduled event (Purge / Weakest Link) mid-countdown, and the
// hostile-mode window. Both drive the on-screen banner and the feed.
export type ClientEventCountdown = { kind: "purge" | "weakestLink"; firesAt: number; description: string };
export type ClientHostile = { startedAt: number; fullDecayAt: number };

// Per-agent swarm activity for the /demo architecture view: when each agent
// last thought, whether that decision was LLM or rule-fallback, and whether the
// prompt hit cache. Drives the pulsing edges and the live decision ticker.
export type AgentActivity = { at: number; fallback: boolean; cached: boolean; action?: string; kind: "decision" | "convTurn" };
export type SwarmStats = { calls: number; cached: number; fallback: number };

// Newest feed entries live at the end; the list is capped so a long game
// doesn't grow the store unbounded.
const FEED_MAX = 250;
let feedSeq = 0;

// Each market's client sparkline is capped to the most recent points so a long
// game doesn't grow it unbounded (a point lands per bet + per ~5 s heartbeat).
const SPARKLINE_MAX = 120;

// Ended conversations retained for "swipe to view past conversations" once
// they've been pruned from the live `conversations` map. Bounded so a long
// game doesn't grow the store unbounded; gated on flags.conversationHistory
// by the one call site that pushes into it (removeConversation, below).
const CONV_HISTORY_MAX = 20;

// The living+unsettled filter before winProbabilities was duplicated by
// convention at five call sites across the client (this file's hydrate and
// applyPrices, markets-list.tsx, and twice in IslandScene.ts) with zero test
// coverage, so a sixth site that forgot the filter would silently break
// death-driven odds (a settled or dead contestant's stale price would still
// count toward the normalization). This is the one place that filter lives
// now; every consumer -- in this file and in the components/scene that own
// the other four sites -- should call this instead of re-deriving it.
export function normalizedWinProbs(
  markets: Record<string, MarketPublic>,
  contestants: Record<string, PublicContestant>,
): Map<string, number> {
  const living = Object.values(markets).filter(
    (m) => !m.settled && contestants[m.contestantId]?.alive,
  );
  return winProbabilities(living.map((m) => ({ id: m.contestantId, priceYes: m.priceYes })));
}

export type GameStore = {
  connected: boolean;
  // The room whose game this store currently reflects (Phase 9).
  room: RoomMeta | null;
  phase: Snapshot["phase"];
  startedAt: number | null;
  autoStartAt: number | null;
  timeline: Snapshot["timeline"];
  contestants: Record<string, PublicContestant>;
  markets: Record<string, MarketPublic>;
  conversations: Record<string, ClientConversation>;
  // Ended conversations retained past their live-map prune, newest last, so a
  // viewer who reads a moment late still has something to swipe through. Only
  // populated while flags.conversationHistory is on; see removeConversation.
  conversationHistory: ClientConversation[];
  spectator: PrivateSpectator | null;
  // The contestant whose detail panel is open (clicked on the island).
  selectedContestantId: string | null;
  // The contestant the camera follows (own islander or an investment), zoomed
  // in and framed so their interactions stay on screen. Null means the
  // ordinary free/fit camera. Purely client state -- the scene reacts through
  // its existing store subscription, so no second event bus is needed.
  followedContestantId: string | null;
  // The interaction (conversation/fight/alliance) whose transcript panel is
  // open -- set only when a viewer clicks an interaction marker on the island,
  // so the bottom-left panel never auto-pops.
  openConversationId: string | null;
  // Live activity feed + Phase 7 event/hostile banners.
  feed: FeedEntry[];
  eventCountdown: ClientEventCountdown | null;
  hostile: ClientHostile | null;
  // Phase 8: end-of-game results (winner, portfolio winner, leaderboard, recap).
  results: GameResultsPayload | null;
  // Winner id from the snapshot, so a client that connects after the game has
  // settled can still show a minimal results screen without the live event.
  winnerContestantId: string | null;
  // Phase 8.3: swarm telemetry for the /demo architecture view.
  spend: SpendUpdatePayload | null;
  swarmActivity: Record<string, AgentActivity>;
  swarmStats: SwarmStats;
  setConnected: (connected: boolean) => void;
  hydrate: (snapshot: Snapshot, spectator: PrivateSpectator | null) => void;
  pushFeed: (entry: Omit<FeedEntry, "id" | "t"> & { t?: number }) => void;
  setEventCountdown: (c: ClientEventCountdown | null) => void;
  setHostile: (h: ClientHostile | null) => void;
  setResults: (r: GameResultsPayload | null) => void;
  applyTelemetry: (p: SwarmTelemetryPayload) => void;
  setSpend: (p: SpendUpdatePayload) => void;
  applyPhase: (payload: GamePhasePayload) => void;
  addContestant: (contestant: PublicContestant, market: MarketPublic) => void;
  setSpectator: (spectator: PrivateSpectator) => void;
  startConversation: (p: ConvStartedPayload) => void;
  addConvMessage: (p: ConvMessagePayload) => void;
  endConversation: (p: ConvEndedPayload) => void;
  removeConversation: (id: string) => void;
  applyHp: (changes: NonNullable<TickDiff["hp"]>) => void;
  killContestant: (p: ContestantDiedPayload) => void;
  settleMarket: (p: MarketSettledPayload) => void;
  setSelectedContestant: (id: string | null) => void;
  setFollowedContestantId: (id: string | null) => void;
  setOpenConversation: (id: string | null) => void;
  // Betting (Phase 6): live prices from the tick diff, authoritative/optimistic
  // market quote updates, balance, and local position edits.
  applyPrices: (changes: NonNullable<TickDiff["prices"]>, t?: number) => void;
  setMarketQuote: (id: string, qYes: number, qNo: number, priceYes: number) => void;
  setBalance: (tokens: number) => void;
  upsertPosition: (contestantId: string, side: "yes" | "no", shares: number, spend: number) => void;
};

export const useGameStore = create<GameStore>()((set) => ({
  connected: false,
  room: null,
  phase: "lobby",
  startedAt: null,
  autoStartAt: null,
  timeline: null,
  contestants: {},
  markets: {},
  conversations: {},
  conversationHistory: [],
  spectator: null,
  selectedContestantId: null,
  followedContestantId: null,
  openConversationId: null,
  feed: [],
  eventCountdown: null,
  hostile: null,
  results: null,
  winnerContestantId: null,
  spend: null,
  swarmActivity: {},
  swarmStats: { calls: 0, cached: 0, fallback: 0 },

  setConnected: (connected) => set({ connected }),

  hydrate: (snapshot, spectator) =>
    set((prev) => {
      // Reconstruct the Phase 7 banners from the snapshot so a reconnecting or
      // late-joining viewer immediately sees an in-progress countdown / hostile
      // mode rather than waiting for the next live event.
      const h = snapshot.hostile;
      const hostile =
        h.active && h.startedAt !== null && h.fullDecayAt !== null
          ? { startedAt: h.startedAt, fullDecayAt: h.fullDecayAt }
          : null;
      const pending = snapshot.events.find(
        (e) => e.countdownStartedAt !== null && e.firedAt === null,
      );
      const eventCountdown =
        pending && !hostile
          ? {
              kind: pending.kind,
              firesAt: pending.scheduledAt,
              description:
                pending.kind === "purge"
                  ? "The Purge - the weakest islanders are culled."
                  : "The Vote - the islanders vote off who they want gone.",
            }
          : null;
      // A seq-gap re-snapshot of the SAME room mid-game must NOT wipe the live
      // activity feed (that was the "feed disappears out of nowhere" bug) or the
      // open conversations. Only a genuine room change / first hydrate resets them.
      const sameRoom = prev.room?.code === snapshot.room.code;
      const contestants = Object.fromEntries(snapshot.contestants.map((c) => [c.id, c]));
      // Seed each market's sparkline with a single CURRENT normalized win-prob
      // point so a chart renders immediately (a flat line is fine). The server
      // snapshot's sparkline is RAW priceYes history; we replace it with the
      // normalized value so the chart matches the displayed "% chance to win"
      // and grows from there as tick prices arrive.
      const snapProbs = normalizedWinProbs(
        Object.fromEntries(snapshot.markets.map((m) => [m.contestantId, m])),
        contestants,
      );
      const seedT = Date.now();
      const markets = Object.fromEntries(
        snapshot.markets.map((m) => {
          const y = snapProbs.get(m.contestantId) ?? m.priceYes;
          // A same-room re-snapshot (seq-gap recovery under volatile ticks
          // drops one and re-fetches) must PRESERVE the chart history we've
          // accumulated, not reset it to a single point -- otherwise every
          // dropped tick flickers the chart back to a flat line and it never
          // grows. Only a genuine room change / first hydrate seeds afresh.
          // applyPrices appends the next live point on the following tick.
          const prevSpark = sameRoom ? prev.markets[m.contestantId]?.sparkline : undefined;
          const sparkline: [number, number][] =
            prevSpark && prevSpark.length > 0 ? prevSpark : [[seedT, y] as [number, number]];
          return [m.contestantId, { ...m, sparkline }];
        }),
      );

      // A snapshot carries every conversation still running on the server.
      // Rebuild lightweight client records on a cold reload so subsequent
      // conv:message / conv:ended events have something to update and Phaser
      // can immediately restore their interaction markers. Existing same-room
      // records keep the transcript already accumulated in this tab.
      const activeConversations: Record<string, ClientConversation> = {};
      for (const summary of snapshot.activeConversations) {
        const existing = sameRoom ? prev.conversations[summary.id] : undefined;
        if (existing) {
          activeConversations[summary.id] = existing;
          continue;
        }
        const participants = summary.participantIds
          .map((id) => contestants[id])
          .filter((c): c is PublicContestant => c !== undefined);
        const x = participants.length > 0
          ? participants.reduce((sum, c) => sum + c.x, 0) / participants.length
          : 0;
        const y = participants.length > 0
          ? participants.reduce((sum, c) => sum + c.y, 0) / participants.length
          : 0;
        activeConversations[summary.id] = {
          id: summary.id,
          participantIds: summary.participantIds,
          x,
          y,
          messages: [],
          outcome: null,
          endedAt: null,
        };
      }
      // Treat the snapshot as authoritative for conversations that are still
      // ongoing. If conv:ended was the packet that triggered this resnapshot,
      // retaining every previous record would leave a permanent "talking"
      // marker. Locally-ended records may stay for their short reading window;
      // the socket's existing linger timer owns their eventual removal.
      const endedConversations = sameRoom
        ? Object.fromEntries(
            Object.entries(prev.conversations).filter(([, conv]) => conv.endedAt !== null),
          )
        : {};
      const conversations = { ...endedConversations, ...activeConversations };

      return {
        room: snapshot.room,
        phase: snapshot.phase,
        startedAt: snapshot.startedAt,
        autoStartAt: snapshot.autoStartAt,
        timeline: snapshot.timeline,
        contestants,
        markets,
        conversations,
        conversationHistory: sameRoom ? prev.conversationHistory : [],
        selectedContestantId: sameRoom ? prev.selectedContestantId : null,
        followedContestantId: sameRoom ? prev.followedContestantId : null,
        openConversationId: sameRoom ? prev.openConversationId : null,
        feed: sameRoom ? prev.feed : [],
        eventCountdown,
        hostile,
        winnerContestantId: snapshot.winnerContestantId,
        spectator,
        // Preserve live results only for recovery inside the same room. A room
        // switch must never show the previous island's winner or portfolio.
        results: sameRoom ? prev.results : null,
        swarmActivity: sameRoom ? prev.swarmActivity : {},
        swarmStats: sameRoom ? prev.swarmStats : { calls: 0, cached: 0, fallback: 0 },
      };
    }),

  pushFeed: (entry) =>
    set((prev) => {
      const next = [
        ...prev.feed,
        { ...entry, id: ++feedSeq, t: entry.t ?? Date.now() },
      ];
      // Cap: drop the oldest once past the ceiling.
      if (next.length > FEED_MAX) next.splice(0, next.length - FEED_MAX);
      return { feed: next };
    }),

  setEventCountdown: (eventCountdown) => set({ eventCountdown }),
  setHostile: (hostile) => set({ hostile }),
  setResults: (results) => set({ results }),

  applyTelemetry: (p) =>
    set((prev) => ({
      swarmActivity: {
        ...prev.swarmActivity,
        [p.agentId]: {
          at: Date.now(),
          fallback: p.fallback,
          cached: p.cached,
          action: p.action,
          kind: p.kind,
        },
      },
      swarmStats: {
        calls: prev.swarmStats.calls + 1,
        cached: prev.swarmStats.cached + (p.cached ? 1 : 0),
        fallback: prev.swarmStats.fallback + (p.fallback ? 1 : 0),
      },
    })),

  setSpend: (spend) => set({ spend }),

  applyPhase: (payload) =>
    set((prev) => ({
      phase: payload.phase,
      startedAt: payload.startedAt,
      autoStartAt: payload.autoStartAt ?? null,
      timeline: payload.timeline ?? (payload.phase === "lobby" ? null : prev.timeline),
      // A reset back to lobby clears the run's banners, feed, results, swarm
      // telemetry, retained transcripts, and any camera follow -- a new run
      // has a different cast, so a stale followed id or last game's
      // transcripts would be meaningless carried forward.
      ...(payload.phase === "lobby"
        ? {
            eventCountdown: null,
            hostile: null,
            feed: [],
            results: null,
            winnerContestantId: null,
            swarmActivity: {},
            swarmStats: { calls: 0, cached: 0, fallback: 0 },
            conversationHistory: [],
            followedContestantId: null,
          }
        : {}),
    })),

  addContestant: (contestant, market) =>
    set((prev) => ({
      contestants: { ...prev.contestants, [contestant.id]: contestant },
      markets: { ...prev.markets, [contestant.id]: market },
    })),

  setSpectator: (spectator) => set({ spectator }),

  startConversation: (p) =>
    set((prev) => ({
      conversations: {
        ...prev.conversations,
        [p.id]: {
          id: p.id,
          participantIds: p.participantIds,
          x: p.x,
          y: p.y,
          messages: [],
          outcome: null,
          endedAt: null,
        },
      },
    })),

  addConvMessage: (p) =>
    set((prev) => {
      const conv = prev.conversations[p.convId];
      if (!conv) return prev;
      return {
        conversations: {
          ...prev.conversations,
          [p.convId]: {
            ...conv,
            messages: [...conv.messages, { speakerId: p.speakerId, text: p.text, tone: p.tone }],
          },
        },
      };
    }),

  endConversation: (p) =>
    set((prev) => {
      const conv = prev.conversations[p.convId];
      if (!conv) return prev;
      return {
        conversations: {
          ...prev.conversations,
          [p.convId]: { ...conv, outcome: p.outcome, endedAt: Date.now() },
        },
      };
    }),

  removeConversation: (id) =>
    set((prev) => {
      const conv = prev.conversations[id];
      if (!conv) return prev;
      const next = { ...prev.conversations };
      delete next[id];
      // Retain the full transcript + outcome in the history ring before it's
      // gone from the live map, so "swipe to view past conversations" (spec
      // line 198) has something to show once the 6 s linger prune fires.
      // Gated on the flag so an all-flags-off run matches today's behavior
      // (the conversation is simply gone) exactly.
      const conversationHistory = islandFlags.conversationHistory
        ? [...prev.conversationHistory, conv].slice(-CONV_HISTORY_MAX)
        : prev.conversationHistory;
      // If the pruned conversation was the one open in the panel, close it.
      return {
        conversations: next,
        conversationHistory,
        openConversationId: prev.openConversationId === id ? null : prev.openConversationId,
      };
    }),

  // Live HP from the tick diff (combat + regen). Powers the contestant panel's
  // health bar; positions still ride the interpolation buffer, not the store.
  applyHp: (changes) =>
    set((prev) => {
      const contestants = { ...prev.contestants };
      let touched = false;
      for (const [id, hp] of changes) {
        const c = contestants[id];
        if (c && c.hp !== hp) {
          contestants[id] = { ...c, hp };
          touched = true;
        }
      }
      return touched ? { contestants } : prev;
    }),

  killContestant: (p) =>
    set((prev) => {
      const dead = prev.contestants[p.contestantId];
      if (!dead) return prev;
      const contestants = {
        ...prev.contestants,
        [p.contestantId]: {
          ...dead,
          alive: false,
          hp: 0,
          deathIndex: p.deathIndex,
          killedBy: p.killerId,
          causeOfDeath: p.cause,
        },
      };
      // Credit the killer's kill count (the panel's headline number).
      if (p.killerId && contestants[p.killerId]) {
        contestants[p.killerId] = {
          ...contestants[p.killerId]!,
          kills: contestants[p.killerId]!.kills + 1,
        };
      }
      return { contestants };
    }),

  settleMarket: (p) =>
    set((prev) => {
      const m = prev.markets[p.contestantId];
      if (!m) return prev;
      return {
        markets: {
          ...prev.markets,
          [p.contestantId]: { ...m, settled: true, settledOutcome: p.outcome },
        },
      };
    }),

  setSelectedContestant: (id) => set({ selectedContestantId: id }),
  setFollowedContestantId: (id) => set({ followedContestantId: id }),
  setOpenConversation: (id) => set({ openConversationId: id }),

  applyPrices: (changes, t) =>
    set((prev) => {
      if (changes.length === 0) return prev;
      const markets = { ...prev.markets };
      // 1) Apply the authoritative RAW priceYes updates (the betting mechanics
      // run on these unchanged).
      for (const [id, price] of changes) {
        const m = markets[id];
        if (m) markets[id] = { ...m, priceYes: price };
      }
      // 2) Recompute normalized win probs across ALL living, unsettled markets
      // from the post-update raw prices, then append a chart point to every
      // broadcast market. Charting the NORMALIZED value (not raw priceYes)
      // keeps the sparkline consistent with the displayed "% chance to win",
      // and because a single bet shifts the normalization it moves the whole
      // board. Appending on every broadcast (bet + ~5 s heartbeat) is what
      // makes the charts always grow, even a flat idle line.
      const probs = normalizedWinProbs(markets, prev.contestants);
      const stamp = t ?? Date.now();
      for (const [id] of changes) {
        const m = markets[id];
        if (!m) continue;
        const y = probs.get(id) ?? m.priceYes;
        const sparkline: [number, number][] = [...m.sparkline, [stamp, y]];
        if (sparkline.length > SPARKLINE_MAX) {
          sparkline.splice(0, sparkline.length - SPARKLINE_MAX);
        }
        markets[id] = { ...m, sparkline };
      }
      return { markets };
    }),

  setMarketQuote: (id, qYes, qNo, priceYes) =>
    set((prev) => {
      const m = prev.markets[id];
      if (!m) return prev;
      return { markets: { ...prev.markets, [id]: { ...m, qYes, qNo, priceYes } } };
    }),

  setBalance: (tokens) =>
    set((prev) => (prev.spectator ? { spectator: { ...prev.spectator, tokens } } : prev)),

  upsertPosition: (contestantId, side, shares, spend) =>
    set((prev) => {
      if (!prev.spectator) return prev;
      const positions = prev.spectator.positions.slice();
      let pos = positions.find((p) => p.contestantId === contestantId);
      if (!pos) {
        pos = {
          spectatorId: prev.spectator.id,
          contestantId,
          yesShares: 0,
          noShares: 0,
          yesSpent: 0,
          noSpent: 0,
        };
        positions.push(pos);
      }
      const next = { ...pos };
      if (side === "yes") {
        next.yesShares += shares;
        next.yesSpent += spend;
      } else {
        next.noShares += shares;
        next.noSpent += spend;
      }
      const idx = positions.indexOf(pos);
      positions[idx] = next;
      return { spectator: { ...prev.spectator, positions } };
    }),
}));

// ---------------------------------------------------------------------------
// "My agent" selectors.
//
// spectator.ownedContestantId crosses the wire on every hello/join and is
// stored on hydrate/setSpectator, but before this a grep across the whole web
// app found zero reads of it -- the client already knows which islander (if
// any) belongs to the viewer and never used that fact. These two selectors
// are the anchors for the user's ask (1), follow my own agent or the agents I
// invested in: `myContestantId` for "my own agent", `myPositions` for "the
// agents I invested in". Plain functions rather than store actions so they
// compose with `useGameStore(selectMyContestantId)` and stay usable from
// non-React callers (the Phaser scene) via `selectMyContestantId(store.getState())`.
export function selectMyContestantId(state: GameStore): string | null {
  return state.spectator?.ownedContestantId ?? null;
}

export function selectMyPositions(state: GameStore): Position[] {
  return state.spectator?.positions ?? [];
}
