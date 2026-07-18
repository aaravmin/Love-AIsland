import { test } from "node:test";
import assert from "node:assert/strict";
import type { MarketPublic, PublicContestant, Snapshot } from "@arena/shared";
import { normalizedWinProbs, selectMyContestantId, selectMyPositions, useGameStore } from "./gameStore";
import { islandFlags } from "./islandFlags";

function market(overrides: Partial<MarketPublic> & { contestantId: string }): MarketPublic {
  return {
    qYes: 1,
    qNo: 1,
    b: 10,
    priceYes: 0.5,
    settled: false,
    settledOutcome: null,
    sparkline: [],
    ...overrides,
  };
}

function contestant(id: string, alive: boolean): PublicContestant {
  return { id, alive } as unknown as PublicContestant;
}

function roomSnapshot(code: string, activeConversation = false): Snapshot {
  const contestants = [
    { ...contestant("a", true), x: 10, y: 20 },
    { ...contestant("b", true), x: 30, y: 40 },
  ];
  return {
    phase: "running",
    room: {
      code,
      name: `Room ${code}`,
      isMain: code === "MAIN",
      config: { agentsPerPerson: 2, lengthMinutes: 15, eventCount: 2 },
    },
    startedAt: 1,
    autoStartAt: null,
    timeline: null,
    contestants,
    markets: [market({ contestantId: "a" }), market({ contestantId: "b" })],
    activeConversations: activeConversation
      ? [{ id: "live-conv", participantIds: ["a", "b"], startedAt: 1 }]
      : [],
    events: [],
    hostile: { active: false, startedAt: null, fullDecayAt: null },
    spend: {} as Snapshot["spend"],
    deathOrder: [],
    winnerContestantId: null,
    tokens: 0,
    positions: [],
    flags: {} as Snapshot["flags"],
    seed: 1,
  };
}

test("setFollowedContestantId round-trips and defaults to null", () => {
  assert.equal(useGameStore.getState().followedContestantId, null);
  useGameStore.getState().setFollowedContestantId("c1");
  assert.equal(useGameStore.getState().followedContestantId, "c1");
  useGameStore.getState().setFollowedContestantId(null);
  assert.equal(useGameStore.getState().followedContestantId, null);
});

test("selectMyContestantId reads spectator.ownedContestantId, null with no spectator", () => {
  useGameStore.setState({ spectator: null });
  assert.equal(selectMyContestantId(useGameStore.getState()), null);
  useGameStore.setState({
    spectator: {
      id: "s1",
      name: "A",
      tokens: 100,
      positions: [],
      ownedContestantId: "c9",
      agentsRemaining: 0,
      notify: false,
    },
  });
  assert.equal(selectMyContestantId(useGameStore.getState()), "c9");
});

test("selectMyPositions reads spectator.positions, defaults to empty array", () => {
  useGameStore.setState({ spectator: null });
  assert.deepEqual(selectMyPositions(useGameStore.getState()), []);
  const positions = [
    { spectatorId: "s1", contestantId: "c1", yesShares: 1, noShares: 0, yesSpent: 5, noSpent: 0 },
  ];
  useGameStore.setState({
    spectator: {
      id: "s1",
      name: "A",
      tokens: 100,
      positions,
      ownedContestantId: null,
      agentsRemaining: 1,
      notify: false,
    },
  });
  assert.deepEqual(selectMyPositions(useGameStore.getState()), positions);
});

test("normalizedWinProbs filters to living, unsettled markets only", () => {
  const markets: Record<string, MarketPublic> = {
    a: market({ contestantId: "a", priceYes: 0.5 }),
    b: market({ contestantId: "b", priceYes: 0.5, settled: true }), // settled: excluded
    c: market({ contestantId: "c", priceYes: 0.5 }), // dead: excluded
  };
  const contestants: Record<string, PublicContestant> = {
    a: contestant("a", true),
    b: contestant("b", true),
    c: contestant("c", false),
  };
  const probs = normalizedWinProbs(markets, contestants);
  assert.equal(probs.has("a"), true);
  assert.equal(probs.has("b"), false);
  assert.equal(probs.has("c"), false);
});

test("removeConversation retains the transcript in history when flags.conversationHistory is on", () => {
  islandFlags.conversationHistory = true;
  try {
    useGameStore.getState().startConversation({ id: "conv1", participantIds: ["a", "b"], x: 0, y: 0 });
    useGameStore.getState().addConvMessage({ convId: "conv1", speakerId: "a", text: "hi there", tone: "neutral" });
    useGameStore.getState().endConversation({
      convId: "conv1",
      outcome: "alliance",
      fightInitiatorId: null,
    } as never);
    useGameStore.getState().removeConversation("conv1");
    const hist = useGameStore.getState().conversationHistory;
    const kept = hist.find((c) => c.id === "conv1");
    assert.ok(kept, "expected conv1 to survive in history");
    assert.equal(kept?.outcome, "alliance");
    assert.equal(kept?.messages.length, 1);
    // pruned from the live map either way
    assert.equal(useGameStore.getState().conversations["conv1"], undefined);
  } finally {
    islandFlags.conversationHistory = false;
  }
});

test("removeConversation does not retain history when the flag is off (flags-off parity)", () => {
  islandFlags.conversationHistory = false;
  useGameStore.getState().startConversation({ id: "conv2", participantIds: ["a", "b"], x: 0, y: 0 });
  const before = useGameStore.getState().conversationHistory.length;
  useGameStore.getState().removeConversation("conv2");
  assert.equal(useGameStore.getState().conversationHistory.length, before);
});

test("hydrate restores active conversation markers so post-reload messages are accepted", () => {
  useGameStore.setState({ room: null, conversations: {}, conversationHistory: [] });
  useGameStore.getState().hydrate(roomSnapshot("ABCDE", true), null);

  const restored = useGameStore.getState().conversations["live-conv"];
  assert.ok(restored);
  assert.equal(restored.x, 20);
  assert.equal(restored.y, 30);

  useGameStore.getState().addConvMessage({
    convId: "live-conv",
    speakerId: "a",
    text: "still talking",
    tone: "neutral",
  });
  assert.equal(useGameStore.getState().conversations["live-conv"]?.messages.length, 1);
});

test("same-room resnapshot removes stale ongoing markers but keeps ended markers briefly", () => {
  useGameStore.setState({
    room: roomSnapshot("ABCDE").room,
    conversations: {
      stale: {
        id: "stale",
        participantIds: ["a", "b"],
        x: 0,
        y: 0,
        messages: [],
        outcome: null,
        endedAt: null,
      },
      ended: {
        id: "ended",
        participantIds: ["a", "b"],
        x: 0,
        y: 0,
        messages: [],
        outcome: "amicable",
        endedAt: 2,
      },
    },
  });

  useGameStore.getState().hydrate(roomSnapshot("ABCDE"), null);
  assert.equal(useGameStore.getState().conversations.stale, undefined);
  assert.ok(useGameStore.getState().conversations.ended);
});

test("hydrate clears room-scoped overlays and selection when switching islands", () => {
  useGameStore.setState({
    room: roomSnapshot("AAAAA").room,
    selectedContestantId: "a",
    followedContestantId: "a",
    openConversationId: "old-conv",
    conversationHistory: [{
      id: "old-conv",
      participantIds: ["a", "b"],
      x: 0,
      y: 0,
      messages: [],
      outcome: null,
      endedAt: null,
    }],
    results: { winnerContestantId: "a" } as never,
  });

  useGameStore.getState().hydrate(roomSnapshot("BBBBB"), null);
  const state = useGameStore.getState();
  assert.equal(state.selectedContestantId, null);
  assert.equal(state.followedContestantId, null);
  assert.equal(state.openConversationId, null);
  assert.deepEqual(state.conversationHistory, []);
  assert.equal(state.results, null);
});
