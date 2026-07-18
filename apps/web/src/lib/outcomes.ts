import type { ConvEndedPayload } from "@arena/shared";

// The ONE place a conversation outcome turns into something a viewer sees.
//
// This used to live in three places -- the island's interaction-node glyph, the
// transcript panel's header badge, and the activity feed's outcome line -- which
// is how truce ended up as a dove in the panel and a generic speech balloon on
// the island. Everything that renders an outcome now reads this table, so the
// three surfaces cannot drift apart again.

export type Outcome = ConvEndedPayload["outcome"];

export type OutcomePresentation = {
  // Glyph shown on the island marker and in the panel badge.
  icon: string;
  // Short noun for the panel header badge.
  label: string;
  // Sentence fragment for the activity feed ("Ada & Bo - <phrase>").
  phrase: string;
  // Tailwind classes for the panel's badge.
  badgeClass: string;
};

const MUTED = "bg-muted text-muted-foreground";

// Icon choices, all single-codepoint so they render identically in Phaser text
// and in the DOM:
//   alliance  handshake      - the two agreed to work together
//   fight     crossed swords - open conflict (matches the combat spark)
//   truce     dove           - a legacy sixth outcome, kept beside the spec's
//                              five rather than removed (golden rule: extend,
//                              never rename or remove). It keeps its own icon
//                              and badge here, but isNotableOutcome below no
//                              longer treats it as notable -- see that comment.
//   tension   storm cloud    - negative but not open conflict, reads as brewing
//   amicable  sparkles       - positive but not an alliance, a warm moment
//   nothing   speech balloon - nothing came of it; the island suppresses this
//                              one entirely (see isNotableOutcome), the panel
//                              and feed still need something to show
const PRESENTATION: Record<Outcome, OutcomePresentation> = {
  ongoing: { icon: "💬", label: "Conversation", phrase: "they are still talking", badgeClass: MUTED },
  nothing: { icon: "💬", label: "Conversation", phrase: "they walk away", badgeClass: MUTED },
  alliance: {
    icon: "🤝",
    label: "Alliance",
    phrase: "an alliance forms",
    badgeClass: "bg-emerald-500/15 text-emerald-400",
  },
  fight: { icon: "⚔", label: "Fight!", phrase: "it turns into a fight!", badgeClass: "bg-rose-500/15 text-rose-400" },
  truce: { icon: "🕊", label: "Truce", phrase: "they call a truce", badgeClass: "bg-sky-500/15 text-sky-400" },
  tension: {
    icon: "🌩",
    label: "Tension",
    phrase: "it leaves tension behind",
    badgeClass: "bg-amber-500/15 text-amber-400",
  },
  amicable: {
    icon: "✨",
    label: "Warm",
    phrase: "they part on good terms",
    badgeClass: "bg-fuchsia-500/15 text-fuchsia-400",
  },
};

// Never throws and never returns undefined: an outcome this build has not heard
// of (an older/newer server) falls back to the neutral ongoing presentation
// rather than blanking a badge or crashing a render.
export function outcomePresentation(outcome: Outcome | null | undefined): OutcomePresentation {
  if (!outcome) return PRESENTATION.ongoing;
  return PRESENTATION[outcome] ?? PRESENTATION.ongoing;
}

// Did the conversation actually produce something worth flagging on the island?
// "Most conversations end in nothing" (spec section 2), and a badge that fires
// on every single talk is noise, so the island only celebrates the rest.
//
// `truce` is EXCLUDED here even though it is a real outcome with its own
// glyph above. The spec's outcome set is five: none, alliance, fight, tension,
// amicable. Truce is the legacy sixth outcome the rule engine still produces,
// and before this change it popped the same dove badge as a real outcome on
// the island, which visually amplified the "everything ends in a truce"
// problem this build exists to fix (swarmBridge's allowed-outcome ordering is
// the mechanical half of that fix; this is the render-side half). Truce still
// renders in the transcript panel and the activity feed via
// outcomePresentation -- it only stops popping a notable badge on the island.
export function isNotableOutcome(outcome: Outcome | null | undefined): boolean {
  return outcome != null && outcome !== "ongoing" && outcome !== "nothing" && outcome !== "truce";
}
