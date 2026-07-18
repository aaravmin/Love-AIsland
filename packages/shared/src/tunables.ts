import type { Class } from "./types.js";

// ---------------------------------------------------------------------------
// The one config surface for everything the behavior/market spec adds.
//
// Two rules govern this file.
//
//   1. Nothing the spec adds is hardcoded. Every threshold, radius, weight, and
//      probability introduced by the new behavior lives here and nowhere else.
//   2. Every feature flag resolves through ISLAND_BEHAVIOR_ALL, which now
//      defaults to ON. Setting ISLAND_BEHAVIOR_ALL=0 restores the pre-spec
//      build exactly.
//
// Rule 2 was the opposite until the behavior work landed, and the inversion is
// deliberate rather than a drift, so it is worth stating why. Every flag in
// this file defaulted to off, and a repo-wide search found the master switch
// set in exactly three test files and nowhere else: no .env, no package script,
// no deploy config. So the entire spec shipped dark. Conversation variety,
// relationship memory, vote reasoning, deflection, self odds, overhearing,
// world and spatial awareness, multi-member alliances, calm conversations and
// outcome icons were all correct, tested code that never once executed in a
// real run. The game a player actually saw was the pre-spec game.
//
// The spec's cross-cutting rule ("all flags off means today's behavior") is
// preserved as a REACHABLE CONFIGURATION rather than as the default:
//
//   ISLAND_BEHAVIOR_ALL=0                            the exact pre-spec build
//   ISLAND_BEHAVIOR_ALL=0 ISLAND_STRIP_DASHES=1      pre-spec plus one feature
//   ISLAND_OVERHEARING=0                             everything except one
//
// Individual flags override the master switch in BOTH directions, which is what
// keeps that A/B usable. behavior.test.ts guards the flags-off path against a
// recorded golden so it stays a first-class configuration and not a claim.
//
// This sits alongside packages/swarm/src/config.ts rather than absorbing it.
// That file owns the model backend seam (which provider answers a think), was
// already shipped, and is read at swarm module load. This file owns game
// behavior. Keeping them separate keeps the backend selection usable by the
// swarm package without dragging the whole game-tuning surface into it.
//
// Read once at module load so a single run never straddles two configurations.
//
// FLAG DEPENDENCIES. Several flags are no-ops or actively misleading on their
// own. They are independent env reads, so a degenerate combination is a
// reachable production config, not just a test artifact. With the master switch
// on these all resolve together and none of it bites; it bites when someone
// disables one flag to isolate a behavior.
//
//   voteDeflection    needs worldAwareness. The deflection check requires a
//                     world posture, and ctx.world is only populated under
//                     worldAwareness, so voteDeflection alone yields nothing.
//   selfOdds          degrades without relationshipMemory. Two of its three
//                     inputs come from the relationship store, so the band
//                     collapses to a function of ally count and HP.
//   multiAlliances    needs relationshipMemory. Without it every trust lookup
//                     returns a fresh zero record, mean trust is 0, and
//                     cohesion pins at its fixed point above the defection
//                     floor forever, so blocs can never crack.
//   outcomeIcons      needs relationshipMemory to show more than two of its
//                     four glyphs, since tension and amicable are the outcomes
//                     the relationship store admits.
//   earlyAggression   needs worldAwareness for a smooth ramp. Without a world
//                     snapshot the ramp has no elapsed-time input to key off.
//   gossip            needs overhearing. overhearing gates CAPTURE of a
//                     fragment; gossip gates whether it is ever passed on.
//   spatialBehavior   needs spatialAwareness. spatialAwareness gates the
//                     crowded/secluded SIGNAL; spatialBehavior gates whether
//                     anything acts on it.
// ---------------------------------------------------------------------------

function flag(env: NodeJS.ProcessEnv, name: string, dflt: boolean): boolean {
  const v = env[name];
  if (v == null || v === "") return dflt;
  return v !== "0" && v.toLowerCase() !== "false" && v.toLowerCase() !== "off";
}

function num(env: NodeJS.ProcessEnv, name: string, dflt: number): number {
  const n = Number(env[name]);
  return Number.isFinite(n) ? n : dflt;
}

// A map of name -> number, overridden from a comma-separated `name:ms` list.
//
// Used for the per-category notification windows, where the set of categories
// belongs to the message layer rather than to this file. Overriding merges onto
// the defaults instead of replacing them, so tuning one category does not
// silently drop the rest, and a malformed entry is ignored rather than thrown:
// a typo in a deploy env must not stop the sim from booting.
function numMap(
  env: NodeJS.ProcessEnv,
  name: string,
  dflt: Record<string, number>,
): Record<string, number> {
  const raw = env[name];
  if (raw == null || raw === "") return { ...dflt };
  const out = { ...dflt };
  for (const pair of raw.split(",")) {
    const idx = pair.indexOf(":");
    if (idx <= 0) continue;
    const key = pair.slice(0, idx).trim();
    const value = Number(pair.slice(idx + 1).trim());
    if (key === "" || !Number.isFinite(value)) continue;
    out[key] = value;
  }
  return out;
}

// Per-class multipliers. A "personality multiplier" in the spec means: the same
// situation pushes a bold agent and a timid agent by different amounts. These
// scale the base likelihoods below rather than replacing them, so tuning the
// base moves everyone together and tuning a class moves only that class.
export type ClassMultipliers = Record<Class, number>;

export type Tunables = {
  // Feature flags. Each resolves through ISLAND_BEHAVIOR_ALL (default on) and
  // each overrides it in both directions. ISLAND_BEHAVIOR_ALL=0 == today's
  // behavior.
  flags: {
    conversationVariety: boolean; // ordinary topics, not only game talk
    stripDashes: boolean; // no dashes in islander speech
    voteReasoning: boolean; // threat / likability / vote math
    voteDeflection: boolean; // a threatened target redirects votes
    earlyAggression: boolean; // raised early-game conflict baseline
    selfOdds: boolean; // coarse private sense of own standing
    multiAlliances: boolean; // alliances of three or more
    allianceDefection: boolean; // cohesion decay and defection
    spontaneousOuster: boolean; // agent-driven elimination push
    voteResolution: boolean; // plurality + the one tie rule (health, then seed)
    worldAwareness: boolean; // event feed / world state in the prompt
    spatialAwareness: boolean; // crowded vs secluded
    overhearing: boolean; // pick up nearby conversations
    marketEventDrift: boolean; // odds move on observable events
    relationshipMemory: boolean; // per-pair trust / threat / affinity
    outcomeIcons: boolean; // tension + amicable icons on the island
    calmConversations: boolean; // reduced movement while talking

    // Added alongside the behavior work above. Same resolution rule.
    //
    // Two of these deliberately sit beside an existing flag rather than
    // reusing it, because capturing a signal and acting on it are separate
    // decisions and an operator debugging one wants to hold the other still.
    followCamera: boolean; // camera can follow an islander or a portfolio
    richNotifications: boolean; // event-aware SMS about your islander and bets
    gossip: boolean; // overheard fragments reach speech and decisions
    spatialBehavior: boolean; // crowded/secluded changes what an agent does
    perTickCallBudget: boolean; // cap model calls per tick, degrade to rules
    conversationHistory: boolean; // client retains ended transcripts
    phasePacing: boolean; // gentler opening, quicker late game
  };

  // Conflict ramps in over a warmup window rather than switching on at once, so
  // early game goes quiet -> lively instead of quiet -> chaos. Within the
  // window the base likelihoods are scaled from 0 up to 1.
  conflict: {
    warmupMs: number;
    baseConflictChance: number; // per eligible conversation, after warmup
    baseVotePushChance: number; // per think, after warmup
    conflictMultipliers: ClassMultipliers;
    votePushMultipliers: ClassMultipliers;
    // A pair that just fought will not immediately fight again.
    pairCooldownMs: number;
  };

  // Social mechanics.
  social: {
    // Outside a formal voting event, a target needs at least this fraction of
    // living islanders agreeing before an ouster can be pushed.
    ousterThreshold: number; // 1/3
    maxAllianceSize: number;
    // Cohesion starts here, rises on shared good outcomes, falls on betrayal.
    // A member below the defection floor may leave.
    cohesionStart: number;
    cohesionGainPerGoodOutcome: number;
    cohesionLossPerBetrayal: number;
    defectionFloor: number;
    // The spec's main POSITIVE cohesion driver: a bloc whose members converged
    // on the same eliminated target just proved it can move the vote. Larger
    // than the per-outcome gain because it is rarer and much harder to fake.
    cohesionGainPerJointVote: number;
    // How many islanders a formal vote eliminates. The spec phrases this in the
    // singular, but the shipped build eliminates a purge-equivalent slice of the
    // field. Zero preserves that behavior; set it to 1 to match the spec's
    // wording literally.
    voteEliminationCount: number;
  };

  // Alliance bookkeeping cadence. Separate from the social weights above
  // because these are scan intervals, not behavioral magnitudes.
  alliances: {
    // A bloc that re-evaluates itself constantly never holds together long
    // enough to matter, so cohesion drift runs on a slow scan, not per tick.
    cohesionScanMs: number;
    // Ouster support is not a permanent signature. The villa moves on, so a
    // supporter older than this stops counting toward quorum.
    ousterSupportTtlMs: number;
  };

  // Personality-dependent response to the room, applied on top of the base
  // likelihoods in `conflict`. The signal (crowded vs secluded) is separate
  // from the reaction: one agent plays to a crowd, another only schemes alone,
  // so a single global "crowds raise conflict" number would be wrong for both.
  spatial: {
    crowdedMultipliers: ClassMultipliers;
    secludedMultipliers: ClassMultipliers;
  };

  // Overheard fragments. Position on the map only matters if what is picked up
  // is bounded and eventually goes stale.
  overhear: {
    // Most recent fragments retained per listener. Small on purpose: an agent
    // that remembers everything it half-heard stops being an eavesdropper and
    // starts being a transcript.
    capPerAgent: number;
    // A fragment this old is no longer worth passing on. Gossip that never
    // expires keeps the villa talking about a conversation nobody remembers.
    shareDecayMs: number;
  };

  // The swarm's behavioral constants. These live here rather than in
  // packages/swarm/src/config.ts because they tune how an agent reasons and
  // speaks, not which provider answers the call. config.ts stays the backend
  // seam and nothing else.
  swarm: {
    // Model calls admitted per tick, shared across thinks and conversation
    // turns. An over-budget call degrades to the rule engine rather than
    // stalling, so this is a quality knob, never a liveness one.
    callsPerTick: number;
    // Ceilings the aggression ramp reaches in each phase of the run. Early game
    // is capped well under half so it reads as lively, not chaotic; the endgame
    // has no real ceiling because by then hiding has stopped working.
    rampEarlyCap: number;
    rampMid: number;
    rampLate: number;
    // How a vote target is scored. Threat dominates, likability discounts it
    // (a beloved target costs an extra body to move), and a personal grievance
    // is the smallest term on purpose: the spec asks for Survivor reasoning,
    // not raw dislike.
    voteWeightThreat: number;
    voteWeightLikability: number;
    voteWeightGrievance: number;
    // How often a pleasant ordinary exchange is worth remembering as one. Kept
    // under half so "nothing came of it" stays the common ending.
    amicableChance: number;
    // After this many consecutive "nothing" outcomes between the same pair,
    // the rule resolver must let the next eligible exchange become a real
    // social outcome. Zero disables the drought breaker.
    conversationDroughtLimit: number;
    // Per-agent ring of recently spoken line ids, excluded from selection so a
    // line does not recur across conversations the way it does today.
    recentlySaidWindow: number;
    // Circuit breaker in front of the model backend. Consecutive failures
    // before the primary is skipped outright, and how long it is skipped for.
    breakerFailuresToOpen: number;
    breakerCooldownMs: number;
    // Agent thought cadence by run phase. One is the original 15-30 second
    // interval; above one slows it, below one speeds it up.
    thinkEarlyScale: number;
    thinkMidScale: number;
    thinkLateScale: number;
    thinkEndgameScale: number;
  };

  // Decision-engine constants. These tune how the rule-based fallback engine
  // (packages/swarm/src/fallback.ts) reads relationship heat, gossip, alliance
  // pacing, and vote deflection into its scores. They started as local module
  // constants in that file because tunables.ts predated the workstream that
  // needed them; the spec's "nothing is hardcoded" rule (section 2) pulled them
  // here once ownership allowed it, unchanged in value.
  decision: {
    // Full accumulated bad blood with the worst person nearby at most doubles
    // conflictChance. See grievanceHeat in fallback.ts.
    grievanceConflictGain: number;
    // Multiplier on vote-push urgency when an agent overhears its own name in a
    // conversation it was not part of. See targetedHeat in fallback.ts.
    targetedVotePushGain: number;
    // Minimum gap between one agent's alliance proposals. One of the two brakes
    // on the 73%-of-conversations-end-in-a-pact problem, so it especially must
    // be tunable. See opensAlliance in fallback.ts.
    allianceOpenCooldownMs: number;
    // How strongly physical proximity breaks ties when ranking alliance
    // prospects, underneath relationship warmth. See bestProspect in fallback.ts.
    prospectProximityWeight: number;
    // Below this warmth, someone is not an alliance prospect at any distance.
    // See bestProspect in fallback.ts.
    prospectHostilityFloor: number;
    // Small tiebreak weight so deflection targets are chosen on more than raw
    // positional order when trust is tied. See deflectionPlan in fallback.ts.
    deflectTiebreakWeight: number;
    // Where the aggression ramp sits when there is no elapsed-time input at
    // all: low on purpose, since "cannot tell how long this has been going"
    // should read as "probably early", not "assume the worst". See
    // aggressionRamp in fallback.ts.
    earlyRampFloor: number;
    // An out-of-sight vote candidate scores lower than an equivalent one
    // standing in front of the agent, because you campaign against the person
    // in the room. See the vote-scoring section of fallback.ts.
    offscreenScoreScale: number;
    // How many out-of-sight names are worth carrying on a vote plan. The
    // record is villa-wide, but a plan naming everyone is not a plan. See the
    // vote-scoring section of fallback.ts.
    offscreenCandidates: number;
    // How much accumulated threat with one specific person raises the urge to
    // swing at them, at threat's ceiling. See escalationScore in swarmBridge.ts.
    grievanceThreatGain: number;
    // How much soured trust with one specific person raises that same urge, at
    // trust's most soured. See escalationScore in swarmBridge.ts.
    grievanceDistrustGain: number;
    // How much warm trust with one specific person pulls the same urge back,
    // at trust's warmest. See escalationScore in swarmBridge.ts.
    goodwillDamping: number;
  };

  // SMS alerting. The shipped build has one global window per spectator shared
  // across every alert type with no priority, so a low-value surge alert can
  // silently swallow a death. These knobs are what let a category carry its own
  // window and let a high-priority alert pre-empt a low one.
  notify: {
    // Legacy global window, still honored and still written, so existing
    // callers keep working while the per-category buckets phase in.
    cooldownMs: number;
    // A price move worth a text, in probability points from the tracked recent
    // extreme. Symmetric: the drop side did not exist at all before.
    surgeDelta: number;
    dropDelta: number;
    // Window for a category with no explicit entry below.
    defaultCategoryCooldownMs: number;
    // Per-category windows, keyed by the notification category name. Kept as an
    // open record rather than a closed union so the message layer can add a
    // category without a change here; unknown keys fall back to the default.
    perCategoryCooldownMs: Record<string, number>;
    // Whether a social alert also tells the reader what the event did (or is
    // likely to do) to their position. Off returns every message to the plain
    // "here is what happened" wording it had before the market-impact copy.
    marketImpactCopy: boolean;
  };

  // Awareness.
  awareness: {
    // An agent this close to a conversation it is not in can pick up part of it.
    overhearRadiusPx: number;
    // Density is measured as living islanders within this radius, then bucketed.
    densityRadiusPx: number;
    crowdedCount: number; // >= this many neighbors reads as crowded
    secludedCount: number; // <= this many reads as secluded
    // How strongly each class notices its own weak standing. The same weak
    // position worries one agent and not another.
    selfOddsSensitivity: ClassMultipliers;
  };

  // Relationship memory. Outcomes fade in weight but are never erased.
  relationships: {
    historyLength: number;
    halfLifeMs: number; // weight of an outcome halves over this span
    // How far one outcome moves each axis, before decay.
    trustPerAlliance: number;
    trustPerAmicable: number;
    trustPerTension: number; // negative
    trustPerFight: number; // negative
    threatPerFight: number;
    threatPerKillWitnessed: number;
    affinityPerAmicable: number;
    affinityPerTension: number; // negative
  };

  // Market drift on observable events. Deliberately much smaller than the
  // effect of a death.
  //
  // Death is intentionally absent. The board already shows a normalized chance
  // to win (each market's price over the sum across living markets), so a death
  // shrinks the denominator and every survivor's displayed percentage rises on
  // its own. Nudging raw shares on death too would count the same thing twice.
  // Death stays the dominant signal precisely by being left alone.
  market: {
    driftOnAlliance: number;
    driftOnFight: number; // negative
    driftOnTension: number; // negative
    driftOnAmicable: number;
    driftOnPurgeSurvival: number;
    // No single event may move a price more than this, and drift never pushes
    // a price outside the LMSR's usable band.
    maxDriftPerEvent: number;
    priceFloor: number;
    priceCeil: number;
    // Betting mechanics that predate the spec but were hardcoded in the market
    // module. Surfaced here so the "nothing is hardcoded" rule holds across the
    // whole config surface rather than only across the new behavior.
    perTradeCap: number; // tokens per bet, keeps a whale off the tails
    priceHeartbeatMs: number; // how often prices are republished
    // How much of a fight's (negative) drift lands on the islander who STARTED
    // it. Well under one because throwing the first punch is evidence that you
    // are dangerous, not that you are about to lose; the person who got jumped
    // takes the full move. See the fight-resolution section of swarmBridge.ts.
    initiatorDriftScale: number;
  };

  // Movement. Talking islanders are currently pinned outright; the spec asks
  // for "moves much less", not "frozen", so this is a fraction of normal pace
  // rather than a hard stop.
  movement: {
    idlePaceScale: number;
    talkingPaceScale: number;
    earlyPaceScale: number;
    midPaceScale: number;
    latePaceScale: number;
    endgamePaceScale: number;
    // Radius sampled around the sprite's feet when checking terrain. A center
    // point alone lets half a body hang over the coast or a pond.
    footprintRadiusPx: number;
  };

  // One run seed makes a run reproducible and betting auditable. Zero means
  // "pick one at start and report it", which is the shipped behavior.
  seed: number;
};

const ONE_THIRD = 1 / 3;

function classMul(
  env: NodeJS.ProcessEnv,
  prefix: string,
  d: ClassMultipliers,
): ClassMultipliers {
  return {
    bold: num(env, `${prefix}_BOLD`, d.bold),
    timid: num(env, `${prefix}_TIMID`, d.timid),
    schemer: num(env, `${prefix}_SCHEMER`, d.schemer),
    charmer: num(env, `${prefix}_CHARMER`, d.charmer),
    wildcard: num(env, `${prefix}_WILDCARD`, d.wildcard),
  };
}

export function readTunables(env: NodeJS.ProcessEnv = process.env): Tunables {
  // One switch to turn the whole spec on, so a run can flip between "today" and
  // "everything" without setting twenty variables. Individual flags still
  // override it in either direction.
  //
  // Defaults TRUE: the shipped game is the lively one. See the header for why
  // this inverted, and for the ISLAND_BEHAVIOR_ALL=0 escape hatch that restores
  // the pre-spec build exactly.
  const all = flag(env, "ISLAND_BEHAVIOR_ALL", true);
  const f = (name: string) => flag(env, name, all);

  return {
    flags: {
      conversationVariety: f("ISLAND_CONVERSATION_VARIETY"),
      stripDashes: f("ISLAND_STRIP_DASHES"),
      voteReasoning: f("ISLAND_VOTE_REASONING"),
      voteDeflection: f("ISLAND_VOTE_DEFLECTION"),
      earlyAggression: f("ISLAND_EARLY_AGGRESSION"),
      selfOdds: f("ISLAND_SELF_ODDS"),
      multiAlliances: f("ISLAND_MULTI_ALLIANCES"),
      allianceDefection: f("ISLAND_ALLIANCE_DEFECTION"),
      spontaneousOuster: f("ISLAND_SPONTANEOUS_OUSTER"),
      voteResolution: f("ISLAND_VOTE_RESOLUTION"),
      worldAwareness: f("ISLAND_WORLD_AWARENESS"),
      spatialAwareness: f("ISLAND_SPATIAL_AWARENESS"),
      overhearing: f("ISLAND_OVERHEARING"),
      marketEventDrift: f("ISLAND_MARKET_EVENT_DRIFT"),
      relationshipMemory: f("ISLAND_RELATIONSHIP_MEMORY"),
      outcomeIcons: f("ISLAND_OUTCOME_ICONS"),
      calmConversations: f("ISLAND_CALM_CONVERSATIONS"),
      followCamera: f("ISLAND_FOLLOW_CAMERA"),
      richNotifications: f("ISLAND_RICH_NOTIFICATIONS"),
      gossip: f("ISLAND_GOSSIP"),
      spatialBehavior: f("ISLAND_SPATIAL_BEHAVIOR"),
      perTickCallBudget: f("ISLAND_CALL_BUDGET"),
      conversationHistory: f("ISLAND_CONVERSATION_HISTORY"),
      phasePacing: f("ISLAND_PHASE_PACING"),
    },

    conflict: {
      warmupMs: num(env, "ISLAND_CONFLICT_WARMUP_MS", 120_000),
      baseConflictChance: num(env, "ISLAND_BASE_CONFLICT_CHANCE", 0.14),
      baseVotePushChance: num(env, "ISLAND_BASE_VOTE_PUSH_CHANCE", 0.1),
      // Bold picks fights, schemer builds cases, timid mostly holds back.
      conflictMultipliers: classMul(env, "ISLAND_CONFLICT_MUL", {
        bold: 1.6,
        timid: 0.35,
        schemer: 1.15,
        charmer: 0.7,
        wildcard: 1.2,
      }),
      // Scheming is where vote pushes come from, not raw aggression.
      votePushMultipliers: classMul(env, "ISLAND_VOTE_PUSH_MUL", {
        bold: 1.3,
        timid: 0.4,
        schemer: 1.7,
        charmer: 0.9,
        wildcard: 1.0,
      }),
      pairCooldownMs: num(env, "ISLAND_PAIR_CONFLICT_COOLDOWN_MS", 90_000),
    },

    social: {
      ousterThreshold: num(env, "ISLAND_OUSTER_THRESHOLD", ONE_THIRD),
      maxAllianceSize: num(env, "ISLAND_MAX_ALLIANCE_SIZE", 5),
      cohesionStart: num(env, "ISLAND_COHESION_START", 0.5),
      cohesionGainPerGoodOutcome: num(env, "ISLAND_COHESION_GAIN", 0.12),
      cohesionLossPerBetrayal: num(env, "ISLAND_COHESION_LOSS", 0.4),
      defectionFloor: num(env, "ISLAND_DEFECTION_FLOOR", 0.2),
      cohesionGainPerJointVote: num(env, "ISLAND_COHESION_GAIN_JOINT_VOTE", 0.2),
      voteEliminationCount: num(env, "ISLAND_VOTE_ELIMINATION_COUNT", 0),
    },

    alliances: {
      cohesionScanMs: num(env, "ISLAND_COHESION_SCAN_MS", 5_000),
      ousterSupportTtlMs: num(env, "ISLAND_OUSTER_SUPPORT_TTL_MS", 120_000),
    },

    spatial: {
      // A crowd is an audience to the bold and the charmer, and a risk to the
      // timid. The schemer is the one class a crowd actively suppresses.
      crowdedMultipliers: classMul(env, "ISLAND_CROWDED_MUL", {
        bold: 1.45,
        timid: 0.55,
        schemer: 0.75,
        charmer: 1.25,
        wildcard: 1.15,
      }),
      // Alone is where the scheming happens, and where the bold have nobody to
      // perform for.
      secludedMultipliers: classMul(env, "ISLAND_SECLUDED_MUL", {
        bold: 0.8,
        timid: 1.15,
        schemer: 1.55,
        charmer: 0.85,
        wildcard: 1.0,
      }),
    },

    overhear: {
      capPerAgent: num(env, "ISLAND_OVERHEARD_CAP", 5),
      shareDecayMs: num(env, "ISLAND_OVERHEARD_DECAY_MS", 180_000),
    },

    swarm: {
      callsPerTick: num(env, "ISLAND_CALL_BUDGET_PER_TICK", 24),
      rampEarlyCap: num(env, "ISLAND_RAMP_EARLY_CAP", 0.45),
      rampMid: num(env, "ISLAND_RAMP_MID", 0.7),
      rampLate: num(env, "ISLAND_RAMP_LATE", 0.9),
      voteWeightThreat: num(env, "ISLAND_VOTE_W_THREAT", 0.55),
      voteWeightLikability: num(env, "ISLAND_VOTE_W_LIKABILITY", 0.3),
      voteWeightGrievance: num(env, "ISLAND_VOTE_W_GRIEVANCE", 0.15),
      amicableChance: num(env, "ISLAND_AMICABLE_CHANCE", 0.35),
      conversationDroughtLimit: num(env, "ISLAND_CONVERSATION_DROUGHT_LIMIT", 2),
      recentlySaidWindow: num(env, "ISLAND_RECENTLY_SAID_WINDOW", 24),
      breakerFailuresToOpen: num(env, "ISLAND_BREAKER_FAILURES", 3),
      breakerCooldownMs: num(env, "ISLAND_BREAKER_COOLDOWN_MS", 30_000),
      thinkEarlyScale: num(env, "ISLAND_THINK_EARLY_SCALE", 1.25),
      thinkMidScale: num(env, "ISLAND_THINK_MID_SCALE", 1),
      thinkLateScale: num(env, "ISLAND_THINK_LATE_SCALE", 0.78),
      thinkEndgameScale: num(env, "ISLAND_THINK_ENDGAME_SCALE", 0.55),
    },

    decision: {
      grievanceConflictGain: num(env, "ISLAND_GRIEVANCE_CONFLICT_GAIN", 1),
      targetedVotePushGain: num(env, "ISLAND_TARGETED_VOTE_PUSH_GAIN", 1.6),
      allianceOpenCooldownMs: num(env, "ISLAND_ALLIANCE_OPEN_COOLDOWN_MS", 45_000),
      prospectProximityWeight: num(env, "ISLAND_PROSPECT_PROXIMITY_WEIGHT", 0.35),
      prospectHostilityFloor: num(env, "ISLAND_PROSPECT_HOSTILITY_FLOOR", -0.25),
      deflectTiebreakWeight: num(env, "ISLAND_DEFLECT_TIEBREAK_WEIGHT", 0.05),
      earlyRampFloor: num(env, "ISLAND_EARLY_RAMP_FLOOR", 0.4),
      offscreenScoreScale: num(env, "ISLAND_OFFSCREEN_SCORE_SCALE", 0.8),
      offscreenCandidates: num(env, "ISLAND_OFFSCREEN_CANDIDATES", 4),
      grievanceThreatGain: num(env, "ISLAND_GRIEVANCE_THREAT_GAIN", 0.35),
      grievanceDistrustGain: num(env, "ISLAND_GRIEVANCE_DISTRUST_GAIN", 0.2),
      goodwillDamping: num(env, "ISLAND_GOODWILL_DAMPING", 0.25),
    },

    notify: {
      cooldownMs: num(env, "ISLAND_NOTIFY_COOLDOWN_MS", 60_000),
      surgeDelta: num(env, "ISLAND_NOTIFY_SURGE_DELTA", 0.08),
      dropDelta: num(env, "ISLAND_NOTIFY_DROP_DELTA", 0.08),
      defaultCategoryCooldownMs: num(env, "ISLAND_NOTIFY_CATEGORY_COOLDOWN_MS", 60_000),
      // Ordered roughly by how much a recipient cares. The irreversible things
      // (a death, a purge, the final payout) get short windows so they are
      // never swallowed; ambient market noise gets long ones.
      perCategoryCooldownMs: numMap(env, "ISLAND_NOTIFY_CATEGORY_COOLDOWNS", {
        payout: 0,
        death: 0,
        purge: 0,
        fight: 45_000,
        allianceBroken: 60_000,
        allianceFormed: 90_000,
        voteResult: 30_000,
        ousterSupport: 120_000,
        tension: 150_000,
        amicable: 180_000,
        drop: 120_000,
        surge: 120_000,
      }),
      marketImpactCopy: f("ISLAND_NOTIFY_MARKET_IMPACT"),
    },

    awareness: {
      overhearRadiusPx: num(env, "ISLAND_OVERHEAR_RADIUS", 96),
      densityRadiusPx: num(env, "ISLAND_DENSITY_RADIUS", 160),
      crowdedCount: num(env, "ISLAND_CROWDED_COUNT", 4),
      secludedCount: num(env, "ISLAND_SECLUDED_COUNT", 1),
      selfOddsSensitivity: classMul(env, "ISLAND_SELF_ODDS_SENS", {
        bold: 0.6,
        timid: 1.5,
        schemer: 1.3,
        charmer: 0.9,
        wildcard: 0.7,
      }),
    },

    relationships: {
      historyLength: num(env, "ISLAND_REL_HISTORY", 12),
      halfLifeMs: num(env, "ISLAND_REL_HALF_LIFE_MS", 300_000),
      trustPerAlliance: num(env, "ISLAND_TRUST_ALLIANCE", 0.35),
      trustPerAmicable: num(env, "ISLAND_TRUST_AMICABLE", 0.15),
      trustPerTension: num(env, "ISLAND_TRUST_TENSION", -0.18),
      trustPerFight: num(env, "ISLAND_TRUST_FIGHT", -0.45),
      threatPerFight: num(env, "ISLAND_THREAT_FIGHT", 0.3),
      threatPerKillWitnessed: num(env, "ISLAND_THREAT_KILL", 0.5),
      affinityPerAmicable: num(env, "ISLAND_AFFINITY_AMICABLE", 0.25),
      affinityPerTension: num(env, "ISLAND_AFFINITY_TENSION", -0.25),
    },

    market: {
      driftOnAlliance: num(env, "ISLAND_DRIFT_ALLIANCE", 0.015),
      driftOnFight: num(env, "ISLAND_DRIFT_FIGHT", -0.02),
      driftOnTension: num(env, "ISLAND_DRIFT_TENSION", -0.01),
      driftOnAmicable: num(env, "ISLAND_DRIFT_AMICABLE", 0.008),
      driftOnPurgeSurvival: num(env, "ISLAND_DRIFT_PURGE", 0.02),
      maxDriftPerEvent: num(env, "ISLAND_MAX_DRIFT", 0.05),
      priceFloor: num(env, "ISLAND_PRICE_FLOOR", 0.02),
      priceCeil: num(env, "ISLAND_PRICE_CEIL", 0.98),
      perTradeCap: num(env, "ISLAND_PER_TRADE_CAP", 25),
      priceHeartbeatMs: num(env, "ISLAND_PRICE_HEARTBEAT_MS", 5_000),
      initiatorDriftScale: num(env, "ISLAND_INITIATOR_DRIFT_SCALE", 0.3),
    },

    movement: {
      idlePaceScale: num(env, "ISLAND_IDLE_PACE", 1),
      talkingPaceScale: num(env, "ISLAND_TALKING_PACE", 0.18),
      earlyPaceScale: num(env, "ISLAND_MOVE_EARLY_SCALE", 0.85),
      midPaceScale: num(env, "ISLAND_MOVE_MID_SCALE", 1),
      latePaceScale: num(env, "ISLAND_MOVE_LATE_SCALE", 1.12),
      endgamePaceScale: num(env, "ISLAND_MOVE_ENDGAME_SCALE", 1.25),
      footprintRadiusPx: num(env, "ISLAND_FOOTPRINT_RADIUS_PX", 5),
    },

    seed: num(env, "ISLAND_RUN_SEED", 0),
  };
}

// The live tunables every consumer reads. Consumers touch it by property path
// (`tunables.flags.overhearing`) rather than destructuring, so replacing its
// contents updates everyone at once.
export const tunables: Tunables = readTunables();

// Re-resolve the tunables in place.
//
// Mutating rather than rebinding is deliberate: a rebound `export let` would
// leave every module that already imported the old object pointing at stale
// values, whereas mutation reaches every reader through the same reference.
//
// Two callers need this. Tests, which cannot set the environment before ESM
// hoists the imports that capture it. And the client, which cannot read
// process.env at all and instead receives the server's already-resolved flags
// over the wire, so that both halves of the app agree on one source of truth
// rather than each reading its own environment.
export function applyTunables(next: Partial<Tunables>): void {
  Object.assign(tunables, next);
}

export function reloadTunables(env: NodeJS.ProcessEnv): void {
  applyTunables(readTunables(env));
}
