import type {
  AgentContextView,
  Class,
  EventModifier,
  NearbyAgent,
  OverheardFragment,
  RelOutcome,
  SelfOddsView,
  Stats,
} from "@arena/shared";
import { describeRecentEvents, describeWorldState, tunables } from "@arena/shared";
import { chooseTopic, deflectionPlan, rankVoteTargets, type Topic } from "./fallback.js";

// ---------------------------------------------------------------------------
// Task 4.1: prompt design. The request shape targets < 350 input tokens
// (ARCHITECTURE.md 7.2): a fleet-wide shared rules block, a per-agent persona
// block (both marked cacheable), and a tiny dynamic user block rebuilt each
// think. Haiku answers by a forced tool call, so the output is always
// schema-shaped JSON.
//
// The behavior spec's additions are all conditional on a tunable flag and read
// their scoring from fallback.ts, so the model is steered by the same numbers
// the no-model brain acts on. Every flag off reproduces these prompts byte for
// byte, which is what keeps the two builds comparable.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Flag-derived rule text, computed lazily behind a memo.
//
// These strings used to be plain module-level consts evaluated once at import.
// That made every one of them a silent lie the moment reloadTunables() ran
// after the import: `tunables` mutates in place, so every property READ picks
// up a flag change, but a const that already captured the value cannot. A test
// that reloaded the tunables and then built a prompt was therefore exercising
// flags-off prompt text while believing otherwise, and a runtime flag change
// never reached the model at all.
//
// The memo is keyed on exactly the flags that feed the text, so the fleet-wide
// system block stays byte-identical across the whole cast between flag changes.
// That property is load-bearing: anthropic.ts marks it cache_control ephemeral
// and it is one cache entry for the entire villa. Rebuilding it on a flag
// change costs one cache miss, which is the correct price for correctness.
// ---------------------------------------------------------------------------

type RuleText = {
  dashRule: string;
  sharedRules: string;
  // The one-clause version of the dash rule, repeated in every tool
  // description because that is the text closest to the token the model is
  // about to write.
  noDashHint: string;
  // The private thought is the other place an exact self-percentage could leak.
  noOddsHint: string;
};

// Only the flags that actually change the text below. Adding a flag here that
// nothing reads would cost a spurious cache invalidation on every toggle.
function ruleSignature(): string {
  const f = tunables.flags;
  return [f.stripDashes, f.conversationVariety, f.voteReasoning, f.selfOdds, f.gossip]
    .map((b) => (b ? "1" : "0"))
    .join("");
}

function computeRules(): RuleText {
  // The house rule on dashes. Nothing downstream trusts it (fallback.ts strips
  // them at the chokepoints regardless), but asking costs nothing and a model
  // that never emits one needs no rewriting.
  const dashRule = tunables.flags.stripDashes
    ? "Never use a dash of any kind: no em dash, no en dash, no hyphen, not even in a compound word. A comma, a full stop, or two plain words instead."
    : "Never use the em dash character; use a plain dash.";

  // Fleet-wide additions. They land in system[0] so they still cost exactly one
  // cache entry across the whole cast.
  const extra: string[] = [];
  if (tunables.flags.conversationVariety) {
    extra.push(
      "Almost nothing said in this villa is about the game. You talk about where you grew up, the food, the heat, the birds, what you miss, what makes you laugh, who you fancy. Talk tactics only when the moment actually forces it, and even then like a person, not an analyst.",
    );
  }
  if (tunables.flags.voteReasoning) {
    extra.push(
      "If you think about who should go, think like a real player: how dangerous are they if they stay, how loved are they by everyone else, and do the votes to do it actually exist. Never move on somebody purely because you dislike them, and never push a vote you cannot count to.",
    );
  }
  if (tunables.flags.selfOdds) {
    extra.push(
      "You have no idea what your odds are. You only have a feeling about where you stand, built from who talks to you and who does not. Never state a percentage or any number about your own chances, out loud or in your own head.",
    );
  }
  if (tunables.flags.gossip) {
    extra.push(
      "Anything you overheard, you overheard. Nobody told you and nobody knows you caught it. If you pass it on it comes out the way gossip does, half sure and lowered voice, never as a report.",
    );
  }

  // system[0] - byte-identical across ALL agents so one cache entry serves the
  // fleet. Keep this stable; any edit invalidates every agent's cache.
  const sharedRules = [
    "You are a contestant on Love AIsland, a reality dating-and-survival show filmed in a sun-drenched villa on a remote island. The cameras never stop. Last islander standing wins, but most days you are simply living here with these people.",
    "You are a whole human being, not a strategy engine. You flirt, get bored, crave shade and a cold drink, miss home, catch feelings, get jealous, gossip, crack jokes, and only sometimes think about the game. Sound like a real person on a show, never like a bot working a spreadsheet.",
    "The percentage beside each name is the public's live favor, who the audience is falling for right now. Being liked keeps you safe; playing the villain paints a target on you.",
    "Strategy is the seasoning, not the meal. Most of what islanders say to each other is just human: getting to know someone, teasing, venting, flirting, gossiping, connecting. Reach for alliance or threat talk only when the moment genuinely calls for it.",
    "Resolve is willpower: a strong-willed islander is hard to sweet-talk, guilt, or pressure into anything. If someone clearly will not bend, stop working an angle and just be real with them.",
    `Never use robotic, stock, contestant-cliche phrasing. Banned forever: 'stronger together', 'we make a great team', 'you and me could run this', 'the numbers', and any generic pitch that would fit any islander. ${dashRule}`,
    "Stay fully in character for your class, stats, and persona. Respond ONLY through the tool you are given, in one in-character action or line.",
    ...extra,
  ].join("\n");

  return {
    dashRule,
    sharedRules,
    noDashHint: tunables.flags.stripDashes ? "No dashes of any kind." : "No em dashes.",
    noOddsHint: tunables.flags.selfOdds
      ? " Never a percentage or any number about your own chances."
      : "",
  };
}

let ruleMemoKey = "";
let ruleMemo: RuleText | null = null;

// The one accessor. Every prompt builder calls it first, which is what keeps
// the exported mirrors below in sync without anyone having to remember to
// refresh them.
export function promptRules(): RuleText {
  const key = ruleSignature();
  if (ruleMemo && ruleMemoKey === key) return ruleMemo;
  const next = computeRules();
  ruleMemo = next;
  ruleMemoKey = key;
  // Keep the long-standing exported surfaces pointing at the current text.
  // SHARED_RULES is an ESM live binding, so reassigning it here reaches every
  // module that imported it by name. The tool objects are mutated in place for
  // the same reason: backends read `.input_schema` and `.description` at call
  // time, never destructuring them at import.
  SHARED_RULES = next.sharedRules;
  DECIDE_TOOL.input_schema.properties.reasoning.description = decideReasoningDescription(next);
  SPEAK_TOOL.input_schema.properties.text.description = speakTextDescription(next);
  return next;
}

// Convenience accessors kept beside the object form, because a caller that
// wants one string should not have to know the memo's shape.
export function sharedRules(): string {
  return promptRules().sharedRules;
}

// system[0], exported as a live binding for backward compatibility with the
// backends that already import it by name (anthropic.ts, backends/ollama.ts,
// backends/hosted.ts). Prefer sharedRules(): a direct read of this binding is
// correct only once some prompt builder has run since the last flag change,
// whereas the function is always correct.
export let SHARED_RULES = "";

// Per-class archetype behavior (3 lines each), the heart of system[1].
const CLASS_BLOCKS: Record<Class, string> = {
  bold:
    "Class: BOLD. The big, brash energy of the villa. You are loud, cocky, competitive, and allergic to being bored. You rib people, throw playful shade, and say what everyone else is only thinking. Under the swagger you badly want to be liked. You will scrap when it truly counts, but you flirt, joke, and stir the pot far more than you threaten.",
  timid:
    "Class: TIMID. The soft, anxious sweetheart. You are shy, easily flustered, quick to apologize, and happiest well away from drama. You overthink what people meant, downplay yourself, and warm up slowly once you feel safe. You would rather share a quiet laugh than pick a fight.",
  schemer:
    "Class: SCHEMER. The clever, watchful one. You read the room better than anyone and keep your real read behind an easy, warm smile. Out loud you are charming, curious, and generous with compliments; the calculations stay in your head. Honestly, most of the time you just love the gossip and the puzzle of people.",
  charmer:
    "Class: CHARMER. The sunshine of the villa. You are warm, funny, flirty, and impossible not to like. You remember the small details, hand out easy compliments, and make whoever you are with feel like the only person on the island. You collect friends because you genuinely adore them, and being adored back happens to keep you safe.",
  wildcard:
    "Class: WILDCARD. The unpredictable live wire. Your mind jumps sideways; you blurt strange thoughts, swerve from silly to weirdly deep, and surprise even yourself. You are playful and a little chaotic, never cruel for no reason, and nobody can guess what you will say next.",
};

// Map a 1-8 stat to a short adjective clause so the persona reads naturally.
function statWord(name: string, value: number): string {
  if (value >= 7) return `very ${name}`;
  if (value >= 5) return name;
  if (value <= 2) return `not ${name}`;
  return `a little ${name}`;
}

export function statsToWords(stats: Stats): string {
  return [
    statWord("charismatic", stats.charisma),
    statWord("cunning", stats.cunning),
    statWord("tough", stats.grit),
    statWord("strong", stats.strength),
    statWord("charming", stats.charm),
    statWord("sharp", stats.instinct),
    statWord("strong-willed", stats.resolve),
  ].join(", ");
}

// system[1] - per-agent, stable all game (name, class card, persona blurb,
// stats in words). Cacheable per agent.
export function buildPersonaBlock(ctx: AgentContextView): string {
  // Refresh the flag-derived surfaces here too. Every backend builds the system
  // blocks by pairing SHARED_RULES with this call, so refreshing on the way
  // through keeps the pair consistent without the backends having to know the
  // memo exists.
  promptRules();
  const { self } = ctx;
  const lines = [
    `You are ${self.name}.`,
    CLASS_BLOCKS[self.klass],
    `You are ${statsToWords(self.stats)}.`,
  ];
  // Spell out what this agent's resolve means for the way it plays, since the
  // stat governs how easily it can be talked into (or out of) anything.
  lines.push(
    self.stats.resolve >= 6
      ? "Your resolve is high: flattery and pressure slide right off you. You decide your own moves and cannot be smooth-talked into an alliance or a betrayal."
      : self.stats.resolve <= 3
        ? "Your resolve is low: a good pitch can genuinely sway you. The right words can talk you into an alliance, or into turning on one."
        : "Your resolve is middling: you can be persuaded by a strong case, but you are not easily fooled.",
  );
  if (self.klass === "schemer" || self.klass === "charmer") {
    lines.push(
      "When you work a target, read their will: if they will not bend to charm or pressure they are too resolute to sway, so change tactics or cut your losses instead of wasting the con.",
    );
  }
  if (self.persona) lines.push(`Your owner describes you: "${self.persona}"`);
  return lines.join("\n");
}

function describeNearby(n: NearbyAgent): string {
  const health = n.hpFraction > 0.66 ? "healthy" : n.hpFraction > 0.33 ? "hurt" : "weak";
  const bits = [n.klass, health, `${n.kills} kills`, `${Math.round(n.priceYes * 100)}%`];
  if (n.allied) bits.push("YOUR ALLY");
  return `${n.name} (${bits.join(", ")})`;
}

// Turns a coming (or active) event into the emotional weather of the villa, so
// the model's words and choices carry genuine awareness of what is bearing down
// on everyone. Shared by the decision prompt and the conversation prompt.
function eventMood(kind: EventModifier["kind"]): string {
  switch (kind) {
    case "purge":
      return "A Purge is coming: soon the least-loved islanders get sent home. You are nervous, and nerves pull people close, and you want the ones you trust beside you, and you want the audience to see you being warm and human, not scheming.";
    case "weakestLink":
      return "A Weakest Link vote is coming: the islanders themselves choose who walks. This is the moment to be liked, so turn on the charm, campaign gently, remind people why they would keep you, and patch up anything you have bruised.";
    case "hostile":
      return "It has turned brutal. There is nowhere left to hide and no allies anymore, just the last few of you. The warmth is gone; this is survival now.";
  }
}

// ---------------------------------------------------------------------------
// Behavior-spec prompt fragments. Each returns null when its flag is off or the
// optional context it needs was never populated, and every caller drops a null,
// so the assembled prompt is unchanged in that case.
// ---------------------------------------------------------------------------

// What the agent is allowed to know about its own standing: a feeling and the
// handful of things it could have counted for itself. Never the number, which
// is why this replaces the self percentage rather than sitting beside it.
//
// Three phrasings per band rather than one. The band changes rarely, so a
// single fixed sentence per band meant an agent whose standing held steady got
// the byte-identical standing line on every think for minutes at a time, which
// anchors the model onto the same private thought over and over. The variant is
// picked by hash rather than by a generator so the prompt layer stays free of
// randomness and a run remains reproducible.
const SELF_ODDS_FEELINGS: Record<SelfOddsView["band"], string[]> = {
  precarious: [
    "You feel like you are on the outside of this villa, and one bad day from being sent home.",
    "Something is off and you know it. Conversations end when you arrive and nobody is fighting to keep you.",
    "You have the sinking feeling of being the easy name, the one nobody would have to argue about.",
  ],
  shaky: [
    "You do not feel safe here, though you are not in trouble yet either.",
    "You are fine, probably. You keep checking, which tells you something.",
    "Nobody is coming for you today. You would not bet on next week.",
  ],
  steady: [
    "You feel reasonably settled here, for now.",
    "You have a place in this villa. Not the best one, but a place.",
    "Things are steady enough that you can breathe and actually enjoy being here.",
  ],
  strong: [
    "You feel genuinely well placed here, and you know better than to say so out loud.",
    "You are doing well and you are careful not to look like you know it.",
    "People come to you. That is a nice feeling and a dangerous one, so you keep it quiet.",
  ],
};

function selfOddsPhrase(odds: SelfOddsView, salt: string): string {
  const variants = SELF_ODDS_FEELINGS[odds.band];
  const feel = variants[Math.floor(steerRoll(salt) * variants.length) % variants.length] ?? variants[0];
  const counted =
    odds.allianceCount === 0
      ? "Nobody in here is really yours."
      : `${odds.allianceCount} of them you would call yours.`;
  return `${feel} ${counted} You never see a number for yourself and never state one.`;
}

// The vote read, narrated. Two names is enough: the case and the alternative.
//
// Two strengths rather than one. The sharp read is injected when the villa is
// actually facing a vote. Outside that, a SOFT one-name version still goes in,
// because the previous all-or-nothing gate meant relationship-derived vote
// reasoning colored nothing at all during ordinary conversation: an islander
// who has quietly clocked the most dangerous person in the villa should carry
// that read around with them, they just should not announce it. The soft
// version is deliberately one line, since it pays its token cost on every
// think.
function voteBlock(ctx: AgentContextView): string | null {
  const reads = rankVoteTargets(ctx);
  if (reads.length === 0) return null;
  const pressed =
    ctx.event != null || ctx.world?.posture === "imminent" || ctx.world?.posture === "active";
  if (!pressed) {
    const top = reads[0];
    if (!top) return null;
    return `No vote is on the table, but you have a private read on this villa. ${top.line} You would not say any of that out loud unasked.`;
  }
  const top = reads.slice(0, 2).map((r) => r.line);
  return `If names come up, this is your honest read. ${top.join(" ")} Weigh danger, how loved they are, and whether the votes exist. Not who annoys you.`;
}

function deflectBlock(ctx: AgentContextView): string | null {
  const plan = deflectionPlan(ctx);
  if (!plan) return null;
  const lean = plan.ally
    ? `${plan.ally.name} still trusts you, so go to them first`
    : "you have nobody left who would take your side, so be careful who you go to";
  const toward = plan.toward ? ` Put ${plan.toward.name}'s name in the air instead of yours.` : "";
  return `You can feel this vote turning toward you. Do not sit and wait for it: ${lean}.${toward} Persuade, do not beg, and never mention odds or a number.`;
}

// A nudge rather than an instruction: the actual roll happens in the rule
// engine, and a model that is told it is spoiling for something behaves like it
// without being ordered to swing.
function aggressionBlock(ctx: AgentContextView): string | null {
  if (!tunables.flags.earlyAggression) return null;
  if (ctx.self.klass !== "bold" && ctx.self.klass !== "schemer") return null;
  return ctx.self.klass === "bold"
    ? "You are bored of everyone being polite. If somebody here has earned it, say the thing out loud rather than sitting on it."
    : "Start laying the groundwork on somebody now, quietly, so that when it matters the villa thinks it got there by itself.";
}

// ---------------------------------------------------------------------------
// Context blocks.
//
// Everything below narrates a field the server has been computing on every
// single think and shipping across the seam, where nothing read it. The world
// snapshot, the recent event list, the relationship records, the overheard
// fragments, the room's density and the alliance bloc were all populated and
// all dropped on the floor, which is the mechanical reason two islanders who
// have fought three times got a byte-identical prompt to two who just met.
//
// Every block returns null when its flag is off or when the optional context it
// needs was never populated, and every caller drops a null, so with the
// behavior flags off the assembled prompt is unchanged.
//
// These land in the DYNAMIC user block, which is uncached by construction, so
// each one is paid for on every call on every backend. That is why the assembly
// below is budgeted rather than unbounded: blocks go in strictly by salience
// and stop when the budget is spent.
// ---------------------------------------------------------------------------

// Roughly 180 tokens at the ~4 characters per token that English prose runs at.
// A ceiling rather than a target: most turns spend far less, and a turn that
// would blow past it drops its least salient context instead of its most.
const CONTEXT_CHAR_BUDGET = 720;

// Where the villa is, and what just happened to it.
//
// describeWorldState and describeRecentEvents are both written, correct
// narrators in @arena/shared that had zero call sites anywhere in the repo,
// which is why an islander could not say "four of us left" or "that just
// happened" no matter which backend was answering.
function worldBlock(ctx: AgentContextView): string | null {
  if (!tunables.flags.worldAwareness) return null;
  const bits: string[] = [];
  if (ctx.world) bits.push(describeWorldState(ctx.world));
  // Prefer the per-agent unread slice; fall back to the snapshot's own tail so
  // the block still narrates something when only one of the two is populated.
  const events = ctx.recentEvents ?? ctx.world?.recent ?? [];
  const narrated = describeRecentEvents(events.slice(-3), ctx.self.id);
  if (narrated) bits.push(narrated);
  // The AFTER half of an event, which the villa had no voice for at all: the
  // event modifier goes silent the instant the thing fires, so the moment with
  // the most to react to was the one moment nothing in the prompt mentioned.
  if (ctx.world?.posture === "justPassed") {
    bits.push("Nobody in here is over it yet, and acting like it did not happen would look strange.");
  }
  if (bits.length === 0) return null;
  return bits.join(" ");
}

// How a past outcome reads when it is being recalled rather than recorded.
// "nothing" is deliberately unrenderable: an exchange that came to nothing is
// not something a person carries around.
function relOutcomeWord(o: RelOutcome): string | null {
  switch (o) {
    case "alliance":
      return "an alliance";
    case "amicable":
      return "a good moment";
    case "truce":
      return "a truce";
    case "tension":
      return "friction";
    case "fight":
      return "a fight";
    case "witnessedKill":
      return "you watching them kill somebody";
    case "nothing":
      return null;
    default:
      return null;
  }
}

// What this agent carries about the person in front of it (or, on the decision
// path with no single partner, about the two people it feels most strongly
// about).
//
// `line` is the sentence describeRelationship pre-renders specifically for
// prompt injection and which nothing in packages/swarm referenced; `recent` is
// the outcome window, which nothing anywhere referenced. Both are the fix for
// the spec's Task F acceptance on the SPEECH path, which the vote machinery's
// use of the same records could never satisfy.
function relationshipBlock(ctx: AgentContextView, partnerName: string | null): string | null {
  if (!tunables.flags.relationshipMemory) return null;
  const all = ctx.relationships ?? [];
  if (all.length === 0) return null;

  if (partnerName != null) {
    const target = partnerName.toLowerCase();
    const r = all.find((s) => s.name.toLowerCase() === target);
    if (!r) return null;
    const bits: string[] = [];
    if (r.line) bits.push(r.line);
    // The outcome window says what happened; the line says how it feels. A
    // history of three frictions reads differently from one fight, and only
    // the window can tell them apart.
    const history = r.recent
      .slice(-3)
      .map(relOutcomeWord)
      .filter((w): w is string => w != null);
    if (history.length > 0) {
      bits.push(`Between you, oldest first: ${history.join(", ")}.`);
    }
    if (bits.length === 0) return null;
    return `${bits.join(" ")} Carry that into how you talk to them, without narrating it.`;
  }

  // Decision path: no single partner, so the strongest feelings win. They are
  // already sorted by magnitude on the way in.
  const lines = all
    .map((s) => s.line)
    .filter((l): l is string => l != null)
    .slice(0, 2);
  if (lines.length === 0) return null;
  return `How you read people right now: ${lines.join(" ")}`;
}

// A callback the server can install so the speech path can retire a fragment
// once it has actually been put in front of a speaker.
//
// The seam exists because the fragment store lives in apps/server (awareness.ts
// owns it) and packages/swarm may never import the server. Default is a no-op,
// so an unwired build behaves exactly as it does today rather than crashing on
// a missing hook.
export type OverheardUsedHook = (listenerId: string, fragment: OverheardFragment) => void;

let overheardUsedHook: OverheardUsedHook | null = null;

export function setOverheardUsedHook(hook: OverheardUsedHook | null): void {
  overheardUsedHook = hook;
}

// The gossip block. This is the literal Task D acceptance criterion ("an agent
// placed near a private talk later references what it overheard") and nothing
// consumed the field at all, so enabling overhearing populated fragments and
// produced byte-identical behavior.
//
// Only ONE fragment goes in, the freshest. An agent that recites everything it
// half-heard stops being an eavesdropper and becomes a transcript, and each
// extra fragment is uncached tokens on every turn.
//
// Returns the fragment alongside the text rather than retiring it here: the
// budget below may still drop this block, and a fragment that never reached a
// prompt must not be marked as passed on. That is precisely the bug the
// `fresh` contract exists to fix, so it would be poor form to reintroduce it
// one layer down.
type ContextBlock = { text: string; onAccepted?: () => void };

function overheardBlock(ctx: AgentContextView): ContextBlock | null {
  if (!tunables.flags.gossip) return null;
  const fresh = (ctx.overheard ?? []).filter((f) => f.fresh);
  const f = fresh[fresh.length - 1];
  if (!f) return null;

  // aboutId is an id; the prompt needs a name. Nearby and the relationship
  // summaries are the two places a name is already available, and if neither
  // has it the agent genuinely does not know who was being discussed, which is
  // a truthful thing for a half-heard fragment to be vague about.
  let aboutName: string | null = null;
  if (f.aboutId) {
    aboutName =
      ctx.nearby.find((n) => n.id === f.aboutId)?.name ??
      (ctx.relationships ?? []).find((r) => r.id === f.aboutId)?.name ??
      null;
  }
  const about = aboutName ? ` about ${aboutName}` : "";
  return {
    text: `You overheard ${f.speakerName} say "${f.text}"${about}. You were not meant to hear it. Whether you use it is your call.`,
    onAccepted: () => {
      if (!overheardUsedHook) return;
      try {
        overheardUsedHook(ctx.self.id, f);
      } catch {
        // A bookkeeping hook must never be able to take the villa down. A
        // fragment that fails to retire gets repeated; that is a far cheaper
        // failure than a thrown prompt build.
      }
    },
  };
}

// Crowded or alone, and what THIS personality does about it.
//
// The signal is computed on every think and read by nothing. A single global
// "crowds raise conflict" steer would be wrong for most of the cast, which is
// the whole reason the reaction is per class rather than global.
const SPATIAL_STEER: Record<Class, { crowded: string; secluded: string }> = {
  bold: {
    crowded: "There is a crowd around you and you love it. This is where you perform.",
    secluded: "It is just the two of you out here. Nobody to play to, so you are oddly straightforward.",
  },
  timid: {
    crowded: "There are a lot of people around you and it is a lot. You are quieter than usual.",
    secluded: "It is quiet and nobody is watching, which is the only time you say what you actually think.",
  },
  schemer: {
    crowded: "Too many ears here. Keep it light and say nothing you would mind repeated.",
    secluded: "Nobody is within earshot. This is the conversation you have been waiting for a chance to have.",
  },
  charmer: {
    crowded: "A crowd, which is your natural habitat. Include people, land a joke, be the warm one.",
    secluded: "Just the two of you. This is where you go past charming and actually get somewhere.",
  },
  wildcard: {
    crowded: "Lots of people, lots of noise, and your brain is bouncing off all of it.",
    secluded: "Nobody around. Your thoughts get stranger and more honest when there is no audience.",
  },
};

function spatialBlock(ctx: AgentContextView): string | null {
  if (!tunables.flags.spatialBehavior) return null;
  const s = ctx.spatial;
  if (!s || s.density === "normal") return null;
  const steer = SPATIAL_STEER[ctx.self.klass];
  return s.density === "crowded" ? steer.crowded : steer.secluded;
}

// The bloc, as a group rather than as three loose ids in self.allies. Without
// this "our four" is structurally unspeakable: nothing on the context names the
// group or reports how it is holding.
const SIZE_WORD = ["", "one", "two", "three", "four", "five", "six", "seven", "eight"];

function allianceBlock(ctx: AgentContextView): string | null {
  if (!tunables.flags.multiAlliances) return null;
  const a = ctx.alliance;
  if (!a || a.size < 2) return null;
  const holding =
    a.cohesionBand === "solid"
      ? "and it is holding"
      : a.cohesionBand === "strained"
        ? "and it has started to strain"
        : "and it is coming apart under you";
  const word = SIZE_WORD[a.size] ?? String(a.size);
  const others = a.memberNames.filter((n) => n !== ctx.self.name).slice(0, 4);
  const withWho = others.length > 0 ? ` with ${others.join(", ")}` : "";
  return `You are one of ${word}${withWho}, ${holding}. You can talk about it as your ${word} when it fits, and you never spell the arrangement out to somebody outside it.`;
}

// Assemble the optional context, most salient first, and stop at the budget.
//
// Order is the whole design here. Deflection outranks everything because an
// islander who can feel the vote turning toward it is not going to discuss the
// weather. The world comes next because a purge that just fired outranks any
// private feeling. The relationship with the person actually in front of you
// beats a bloc-level read, which beats gossip, which beats the room.
function contextBlocks(ctx: AgentContextView, partnerName: string | null): string[] {
  const plain = (text: string | null): ContextBlock | null => (text ? { text } : null);
  const candidates: (ContextBlock | null)[] = [
    plain(worldBlock(ctx)),
    plain(relationshipBlock(ctx, partnerName)),
    plain(allianceBlock(ctx)),
    overheardBlock(ctx),
    plain(spatialBlock(ctx)),
  ];
  const out: string[] = [];
  let spent = 0;
  for (const block of candidates) {
    if (!block) continue;
    if (spent + block.text.length > CONTEXT_CHAR_BUDGET) continue;
    out.push(block.text);
    spent += block.text.length;
    block.onAccepted?.();
  }
  return out;
}

// The dynamic user block, rebuilt every think and left uncached.
export function buildDecisionUser(ctx: AgentContextView): string {
  promptRules();
  const { self, nearby, memory, event } = ctx;
  const lines: string[] = [];
  const hpPct = Math.round(self.hpFraction * 100);
  // An agent never sees its own market price, on ANY path.
  //
  // This used to fall back to `Your market: 43%` whenever selfOdds was off,
  // which is exactly the "exact odds number about itself" the spec forbids
  // absolutely, not conditionally. A flag may gate a feature; it may not gate a
  // cross-cutting prohibition, so the raw-price branch is gone rather than
  // merely defaulted away from. With the coarse band unavailable the agent gets
  // the honest thing instead: it does not know.
  const standing = ctx.selfOdds
    ? selfOddsPhrase(ctx.selfOdds, `${self.id}|${self.kills}|${self.hp}|${nearby.length}`)
    : "You have no idea what the audience makes of you, and you never see a number for yourself.";
  lines.push(`HP ${self.hp}/${self.maxHp} (${hpPct}%). Kills ${self.kills}. ${standing}`);
  if (nearby.length > 0) {
    lines.push("Nearby: " + nearby.slice(0, 5).map(describeNearby).join(" | "));
  } else {
    lines.push("Nobody is nearby.");
  }
  if (memory.length > 0) {
    lines.push("You remember: " + memory.slice(-3).map((m) => m.text).join("; "));
  }
  if (event) {
    lines.push(event.line);
    lines.push(eventMood(event.kind));
  }
  // Deflection first: an islander who can feel the vote turning toward it is
  // not going to sit and think about the weather. Then the world, the people
  // and the room, then the vote read and the aggression nudge.
  const deflect = deflectBlock(ctx);
  if (deflect) lines.push(deflect);
  for (const block of contextBlocks(ctx, null)) lines.push(block);
  for (const block of [voteBlock(ctx), aggressionBlock(ctx)]) {
    if (block) lines.push(block);
  }
  lines.push(
    "Choose the one action your class and this exact moment call for. If you are approaching someone to campaign against a different islander, put that islander's exact name in voteTarget; otherwise use null. Your reasoning is a PRIVATE first-person thought only the audience hears, never the other islanders, so make it vivid and honest about what is really going on in you right now, whether that is a scheme, a crush, nerves, boredom, or a grudge. Do not narrate the obvious, and never fall back on a generic line.",
  );
  return lines.join("\n");
}

// The tool descriptions that carry flag-derived text. Held as builders so
// promptRules() can rewrite them in place whenever the flags change; the
// backends read `.input_schema` at call time, so the rewrite reaches them.
function decideReasoningDescription(r: RuleText): string {
  return `A vivid FIRST-PERSON private thought, one sentence, in your own voice: what you are really feeling or planning right now, be it a scheme, a crush, nerves, boredom, or a grudge. The audience hears this; the other islanders never do. Never generic. ${r.noDashHint}${r.noOddsHint}`;
}

function speakTextDescription(r: RuleText): string {
  return `At most 20 words. A real, human line to the person in front of you: react to what they just said, in your own voice. Warm, funny, flirty, awkward, curious, or vulnerable as the moment fits, not a strategy speech. No stock phrases like 'stronger together'. If you are quietly scheming, the words still sound genuine and easy. ${r.noDashHint}`;
}

// The decide tool. Forcing this tool guarantees Haiku returns valid JSON.
export const DECIDE_TOOL = {
  name: "decide",
  description: "Choose this contestant's single next action, in character.",
  input_schema: {
    type: "object" as const,
    properties: {
      action: {
        type: "string" as const,
        enum: ["wander", "approach", "attack", "flee", "layLow", "proposeAlliance"],
        description:
          "wander: drift. approach: move toward target. attack: fight target. flee: run from target. layLow: hide. proposeAlliance: try to befriend target.",
      },
      target: {
        type: ["string", "null"] as const,
        description: "The exact name of a nearby contestant, or null for wander/layLow.",
      },
      voteTarget: {
        type: ["string", "null"] as const,
        description:
          "The exact name you are campaigning to vote out while approaching a confidant, or null when this is not a vote plan.",
      },
      reasoning: {
        type: "string" as const,
        // Rewritten by promptRules() on every flag change; the initial value is
        // primed at the bottom of this module.
        description: "",
      },
    },
    required: ["action", "target", "voteTarget", "reasoning"],
  },
};

// ---------------------------------------------------------------------------
// Conversation prompts (task 4.6). A turn is built from the speaker's cached
// system blocks plus the transcript so far plus the partner's public info.
// ---------------------------------------------------------------------------

export const SPEAK_TOOL = {
  name: "speak",
  description: "Say one line to the other contestant, in character.",
  input_schema: {
    type: "object" as const,
    properties: {
      text: {
        type: "string" as const,
        // Rewritten by promptRules() on every flag change; primed at the bottom
        // of this module.
        description: "",
      },
      tone: {
        type: "string" as const,
        enum: ["friendly", "hostile", "neutral", "deceptive"],
      },
      wantsToEnd: { type: "boolean" as const, description: "True if you are done talking." },
    },
    required: ["text", "tone", "wantsToEnd"],
  },
};

// The final turn additionally chooses an outcome from the allowed set (the
// class system bounds the physics; ARCHITECTURE.md 7.3).
export function resolveTool(allowedOutcomes: string[]) {
  const r = promptRules();
  return {
    name: "resolve",
    description: "Say your final line and decide how this encounter ends.",
    input_schema: {
      type: "object" as const,
      properties: {
        text: {
          type: "string" as const,
          description:
            `At most 20 words. Your parting line to this islander, honest to how the talk actually went, in your own voice, human first and not a pitch. No stock phrases like 'stronger together'. A schemer can still sound warm; the plan lives in your head, not your mouth. ${r.noDashHint}`,
        },
        tone: {
          type: "string" as const,
          enum: ["friendly", "hostile", "neutral", "deceptive"],
        },
        outcome: {
          type: "string" as const,
          enum: allowedOutcomes,
          description: "How this ends. Only these outcomes are possible for you here.",
        },
      },
      required: ["text", "tone", "outcome"],
    },
  };
}

// What each topic asks the speaker to actually talk about. Deliberately a
// prompt for a subject and not a script: the persona still supplies the voice.
const TOPIC_STEER: Record<Topic, string> = {
  game:
    "This one is about the game. Say the real thing, the way a person does when they are worried and trying not to look it, not the way a strategist would.",
  smallTalk: "",
  backstory:
    "Talk about who you were before this place, or ask about theirs. Give a real detail, not a headline.",
  home:
    "Home is on your mind. Someone you miss, something small you would give anything for right now.",
  food: "Talk about the food, the cooking, the thing you are craving, or who keeps eating it all.",
  weather:
    "Talk about the heat, the rain, the sunburn, the hour of the day when this island is finally bearable.",
  setting:
    "React to where you are: the view, the birds, the pool, the cameras in the trees, the strangeness of it.",
  joke: "Be funny. Tease them, take the mickey out of yourself, tell them the stupid thing you did today.",
  likes:
    "Talk about what you love, or find out what they love. A song, a film, a habit nobody would guess.",
};

// The prompt layer has no random generator, so variety comes from a hash of the
// things that make this turn unique. Same turn, same steer; next turn, a
// different one. That keeps prompts reproducible for debugging.
function steerRoll(parts: string): number {
  let h = 2166136261;
  for (let i = 0; i < parts.length; i++) {
    h ^= parts.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
}

// The optional `event` colors the exchange with awareness of a coming Purge or
// Weakest Link (or active hostile mode). It is a trailing optional so existing
// callers stay valid; pass ctx.event to make the talk feel the pressure.
//
// `ctx` is a second trailing optional, added by the behavior spec: with it the
// turn gets a subject (so the villa is not permanently discussing the game) and,
// when the vote is closing in on this speaker, something to do about it. Without
// it the prompt is exactly what it was.
export function buildConversationUser(
  partnerName: string,
  transcript: { speaker: string; text: string }[],
  selfName: string,
  isFinal: boolean,
  event?: EventModifier | null,
  ctx?: AgentContextView | null,
): string {
  promptRules();
  const lines: string[] = [`You are talking one on one with ${partnerName}, cameras rolling.`];
  if (transcript.length === 0) {
    lines.push(
      `The conversation just started. Open it the way a real person would: a greeting, a tease, a question, something you noticed about the villa, the heat, or last night. Make it something only you would say to ${partnerName}, not a pitch.`,
    );
  } else {
    lines.push("So far:");
    for (const m of transcript) {
      lines.push(`  ${m.speaker === selfName ? "You" : partnerName}: ${m.text}`);
    }
  }
  if (event) lines.push(eventMood(event.kind));
  if (ctx) {
    // The context blocks the decision prompt has always had, and which this
    // builder had none of. Before this, two islanders who had fought three
    // times got a byte-identical prompt to two who had just met: the partner's
    // NAME and the transcript were the only per-pair inputs the model ever
    // saw, which is most of why the villa reads as unreactive.
    for (const block of contextBlocks(ctx, partnerName)) lines.push(block);
    // Deflection outranks the topic: an islander who can feel the vote turning
    // toward it is not going to sit and chat about the weather.
    const deflect = deflectBlock(ctx);
    if (deflect) {
      lines.push(deflect);
    } else if (tunables.flags.conversationVariety) {
      const last = transcript[transcript.length - 1]?.text ?? "";
      const topic = chooseTopic(ctx, steerRoll(`${selfName}|${partnerName}|${transcript.length}|${last}`));
      const steer = TOPIC_STEER[topic];
      if (steer) lines.push(steer);
    }
  }
  lines.push(
    `Reply as yourself in your class's voice. Actually react to what ${partnerName} just said, pick up their words, answer their question, tease them back, use their name when it feels natural. Be warm, funny, curious, flirty, or vulnerable as the moment fits. Vary your sentence length. Sound like a person, not a contestant reciting strategy. Do not recycle a line that would fit any islander, and never say things like "stronger together". If your class schemes, keep the words easy and genuine while any real plan stays in your head.`,
  );
  lines.push(
    isFinal
      ? "This is the last thing you say before you part. Give it a real, human closing line, then call the resolve tool."
      : "Say your next line with the speak tool.",
  );
  return lines.join("\n");
}

// Prime the flag-derived surfaces once at module load, so a consumer that reads
// SHARED_RULES or a tool description before any builder has run still gets real
// text. Every subsequent flag change is picked up lazily by promptRules(), which
// every builder calls first.
promptRules();
