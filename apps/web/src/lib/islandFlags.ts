import type { Snapshot, Tunables } from "@arena/shared";

// Client-visible mirror of the behavior flags, adopted from the server.
//
// Why this exists rather than reading `tunables.flags` directly in the scene:
// tunables resolves ISLAND_* out of process.env with a DYNAMIC lookup. On the
// server that is exactly right. In the browser it can never work, because Next
// only exposes NEXT_PUBLIC_-prefixed variables to client bundles and only when
// they are referenced STATICALLY, since the value is inlined at build time. A
// dynamic env[name] read compiles to a lookup on an empty object, so every flag
// would silently be false and the render work behind them would be dead code.
//
// Rather than maintain a parallel set of NEXT_PUBLIC_ twins, which would be two
// sources of truth that can drift apart, the server publishes its resolved
// flags in the Snapshot and the client adopts them. There is no client-side
// configuration at all: switch a flag on the server and the island follows.
//
// The object is MUTATED in place rather than reassigned. Consumers read it by
// property path at call time (`islandFlags.outcomeIcons`), so mutation reaches
// every reader through the same reference, including the Phaser scene, which
// captured this module long before the first snapshot arrived.
//
// WIDENING NOTE: this used to mirror only 2 of the (now 23) server flags --
// outcomeIcons and calmConversations -- so 15+ flags' worth of client-visible
// reaction (follow camera, rich notifications, gossip, spatial behavior, ...)
// were computed server-side and simply discarded on arrival, every snapshot,
// every run. The type below is `Tunables["flags"]` itself rather than a
// hand-copied subset, so a future flag added to the server's tunables surface
// widens this mirror for free instead of silently being dropped again.

export type IslandFlags = Tunables["flags"];

// Off until the server says otherwise, which matches the spec's default and
// means a client that has not yet connected renders today's island.
export const islandFlags: IslandFlags = {
  conversationVariety: false,
  stripDashes: false,
  voteReasoning: false,
  voteDeflection: false,
  earlyAggression: false,
  selfOdds: false,
  multiAlliances: false,
  allianceDefection: false,
  spontaneousOuster: false,
  voteResolution: false,
  worldAwareness: false,
  spatialAwareness: false,
  overhearing: false,
  marketEventDrift: false,
  relationshipMemory: false,
  outcomeIcons: false,
  calmConversations: false,
  followCamera: false,
  richNotifications: false,
  gossip: false,
  spatialBehavior: false,
  perTickCallBudget: false,
  conversationHistory: false,
  phasePacing: false,
};

export function adoptServerFlags(flags: Snapshot["flags"] | undefined): void {
  if (!flags) return; // an older server that does not publish them: stay off
  // Assigned field by field (not a spread-and-reassign) so the mutation lands
  // on the SAME object reference every existing reader captured, and so a
  // malformed/older payload missing a key coerces that key to false rather
  // than leaving `undefined` sitting in a boolean field.
  islandFlags.conversationVariety = flags.conversationVariety === true;
  islandFlags.stripDashes = flags.stripDashes === true;
  islandFlags.voteReasoning = flags.voteReasoning === true;
  islandFlags.voteDeflection = flags.voteDeflection === true;
  islandFlags.earlyAggression = flags.earlyAggression === true;
  islandFlags.selfOdds = flags.selfOdds === true;
  islandFlags.multiAlliances = flags.multiAlliances === true;
  islandFlags.allianceDefection = flags.allianceDefection === true;
  islandFlags.spontaneousOuster = flags.spontaneousOuster === true;
  islandFlags.voteResolution = flags.voteResolution === true;
  islandFlags.worldAwareness = flags.worldAwareness === true;
  islandFlags.spatialAwareness = flags.spatialAwareness === true;
  islandFlags.overhearing = flags.overhearing === true;
  islandFlags.marketEventDrift = flags.marketEventDrift === true;
  islandFlags.relationshipMemory = flags.relationshipMemory === true;
  islandFlags.outcomeIcons = flags.outcomeIcons === true;
  islandFlags.calmConversations = flags.calmConversations === true;
  islandFlags.followCamera = flags.followCamera === true;
  islandFlags.richNotifications = flags.richNotifications === true;
  islandFlags.gossip = flags.gossip === true;
  islandFlags.spatialBehavior = flags.spatialBehavior === true;
  islandFlags.perTickCallBudget = flags.perTickCallBudget === true;
  islandFlags.conversationHistory = flags.conversationHistory === true;
}
