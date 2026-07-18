import type { Class, Stats } from "@arena/shared";

// A seeded RNG that produces the same sequence given the same seed.
// Uses mulberry32, matching the PRNG used elsewhere in the codebase.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Trait pools for persona composition. All entries are dash-free.
// Each pool is curated to work in natural blurb templates.

const JOBS = [
  "nurse", "bartender", "gym trainer", "chef", "photographer",
  "florist", "graphic designer", "pilot", "coach", "teacher",
  "real estate agent", "personal trainer", "artist", "electrician", "mechanic",
  "software engineer", "dancer", "model", "actor", "musician",
  "hairstylist", "accountant", "architect", "sommelier", "therapist",
];

const QUIRKS = [
  "can't whistle", "collects vintage sunglasses", "always humming",
  "reads celebrity gossip", "talks to animals", "laughs too loud",
  "obsessed with coffee", "never wears socks", "writes terrible poetry",
  "quotes old movies", "does bad impressions", "makes up song lyrics",
  "argues about everything", "knows all the old dances", "overshares about exes",
  "hums off key", "wears mismatched shoes", "tells dad jokes constantly",
  "always late to everything", "plant lover with a black thumb",
];

const WANTS = [
  "winning", "finding love", "being adored", "peace",
  "the perfect tan", "genuine connection", "travel",
  "proving something", "non stop parties", "understanding",
  "fame and fortune", "adventure and chaos", "trust",
  "respect and recognition", "loyalty", "fun and laughter",
  "meaningful conversations", "adrenaline", "quiet moments",
];

const FEARS = [
  "being alone", "looking foolish", "being forgotten", "betrayal",
  "deep water", "loud noises", "not being good enough", "missing out",
  "confrontation", "commitment", "rejection", "snakes", "public speaking",
  "failure", "being ordinary", "abandonment", "secrets getting out",
];

/**
 * Generate a persona blurb for a contestant, deterministically seeded by
 * a run seed and the contestant's index in the creation order.
 *
 * @param runSeed The game's run seed, used to initialize the PRNG
 * @param contestantIndex The 0-based index of this contestant in creation order
 * @param klass The contestant's class
 * @param stats The contestant's stat block
 * @returns A persona blurb under 140 characters, dash-free, or empty string if generation fails
 */
export function generatePersona(
  runSeed: number,
  contestantIndex: number,
  klass: Class,
  stats: Stats,
): string {
  // Seed the RNG with both the run seed and the contestant index to ensure
  // different islanders get different personas even in the same run.
  const seed = (runSeed + contestantIndex * 73) >>> 0;
  const rand = mulberry32(seed);

  // Select traits based on class and stats for personality coherence.
  const jobIndex = Math.floor(rand() * JOBS.length);
  const job = JOBS[jobIndex]!;

  // Bias quirk selection by class: schemers and charmers lean people-focused
  let quirkIndex = Math.floor(rand() * QUIRKS.length);
  if ((klass === "schemer" || klass === "charmer") && quirkIndex > 8) {
    quirkIndex = quirkIndex % 8;
  }
  const quirk = QUIRKS[quirkIndex]!;

  // Bias want selection by class and stats
  let wantIndex = Math.floor(rand() * WANTS.length);
  if (klass === "bold" && stats.strength > 5) {
    wantIndex = wantIndex % 6; // Prefer winning, proving, adventure
  } else if (klass === "timid" && stats.resolve < 4) {
    wantIndex = (wantIndex + 3) % WANTS.length; // Prefer peace, connection, understanding
  } else if (klass === "charmer") {
    wantIndex = (wantIndex + 1) % WANTS.length; // Prefer being adored, connection
  }
  const want = WANTS[wantIndex]!;

  // Fear selection based on personality type
  let fearIndex = Math.floor(rand() * FEARS.length);
  if (klass === "timid") {
    fearIndex = fearIndex % 7; // Timid fears: alone, foolish, forgotten, betrayal, etc.
  } else if (klass === "bold" && stats.resolve > 6) {
    fearIndex = (fearIndex + 5) % FEARS.length; // Bold fears: ordinary, abandonment
  }
  const fear = FEARS[fearIndex]!;

  // Compose a natural-sounding blurb: "I'm a [job]. [quirk]. Loves [want], fears [fear]."
  // Aim for under 140 chars (create-form.tsx limit).
  const blurb = `I'm a ${job}. ${quirk}. Loves ${want}, fears ${fear}.`;

  // Safety check: if the blurb exceeds the limit, truncate it gracefully.
  if (blurb.length > 140) {
    return blurb.slice(0, 137) + "...";
  }

  return blurb;
}
