import { test } from "node:test";
import assert from "node:assert/strict";
import type { MarketPublic, PublicContestant } from "@arena/shared";
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
