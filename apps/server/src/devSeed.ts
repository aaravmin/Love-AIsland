import type { Class, Contestant, Stats } from "@arena/shared";
import { STAT_BUDGET, STAT_KEYS, STAT_MAX, STAT_MIN } from "@arena/shared";
import { MAX_CONTESTANTS, maybeScheduleAutoStart } from "./lifecycle.js";
import { seedMarket } from "./market.js";
import { createContestant } from "./protocol.js";
import { activate, mainRoom, type Room } from "./rooms.js";
import { aliveCount, state, toMarketPublic, toPublicContestant } from "./state.js";
import { runSeed } from "./social.js";
import { generatePersona } from "./personas.js";
import type { ArenaServer } from "./io.js";

// DEV_SEED=<n> populates a fresh lobby with n house-owned contestants at
// boot and after every reset. Local-testing and rehearsal convenience only:
// the movement gate needs a full island without 12 phones creating
// islanders. Unset (the default) it does nothing.

const NAMES = [
  "Rico", "Savannah B", "Chad W", "Blaze T", "Nova", "Duke R", "Kiki M",
  "Trey J", "Zara K", "Bronson", "Coral V", "Maverick", "Sunny D", "Diesel P",
  "Vixen", "Rex T", "Amber L", "Tanner Q", "Jazzy R", "Colt B", "Roxie",
  "Big Country", "Foxy J", "Stone C", "Lacey V", "Bullet", "Peaches M",
  "Duke Jr", "Skye T", "Rowdy", "Misty K", "Ace H", "Honey B", "Tank R",
  "Ginger P", "Wolf", "Chardonnay", "Slick D", "Dolly K", "Bear",
];

const CLASSES: Class[] = ["bold", "timid", "schemer", "charmer", "wildcard"];

// Random legal build: every stat starts at the minimum, then the remaining
// budget is sprinkled one point at a time across stats with headroom, so the
// result always satisfies shared validateStats.
function randomStats(): Stats {
  const stats: Stats = {
    charisma: STAT_MIN,
    cunning: STAT_MIN,
    grit: STAT_MIN,
    strength: STAT_MIN,
    charm: STAT_MIN,
    instinct: STAT_MIN,
    resolve: STAT_MIN,
  };
  let remaining = STAT_BUDGET - STAT_MIN * STAT_KEYS.length;
  while (remaining > 0) {
    const open = STAT_KEYS.filter((k) => stats[k] < STAT_MAX);
    const key = open[Math.floor(Math.random() * open.length)]!;
    stats[key]++;
    remaining--;
  }
  return stats;
}

// Seed up to `count` house-owned islanders into `room` (lobby or a running
// game -- not once it's settled), respecting the 50-islander cap. Used by the
// boot seeder and the operator "Seed players" button. When seeding into a
// running game the new islanders spawn alive (createContestant already puts
// every islander at a walkable position with HP and a wander intent, whether
// or not the game has started) and get a market immediately, but auto-start
// scheduling only makes sense pre-game. Returns how many were actually added.
export function seedContestants(room: Room, count: number): number {
  if (!Number.isInteger(count) || count <= 0) return 0;
  activate(room);
  if (state.phase === "settled") return 0;
  const now = Date.now();
  const already = Object.keys(state.contestants).length;
  const toAdd = Math.min(count, MAX_CONTESTANTS - already);
  if (toAdd <= 0) return 0;

  // The whole batch joins at the same instant, so every new market seeds at
  // 1/N of the FINAL alive count rather than 1/1 for the first.
  const created: Contestant[] = [];
  const seed = runSeed();
  for (let i = 0; i < toAdd; i++) {
    const idx = already + i;
    const klass = CLASSES[idx % CLASSES.length]!;
    const stats = randomStats();
    const persona = generatePersona(seed, idx, klass, stats);
    const contestant = createContestant({
      name: NAMES[idx % NAMES.length]! + (idx >= NAMES.length ? ` ${Math.floor(idx / NAMES.length) + 1}` : ""),
      klass,
      stats,
      persona,
      ownerName: "House",
      ownerPhone: "",
      ownerClientId: "house-seed",
      now,
    });
    state.contestants[contestant.id] = contestant;
    created.push(contestant);
  }
  for (const contestant of created) {
    const market = seedMarket(contestant.id, aliveCount(), now);
    state.markets[contestant.id] = market;
    room.io.emit("contestant:joined", {
      contestant: toPublicContestant(contestant),
      market: toMarketPublic(market),
    });
  }
  if (state.phase === "lobby") maybeScheduleAutoStart(room.io, now, room);
  return created.length;
}

export function seedDevContestants(_io: ArenaServer): void {
  const count = Number(process.env.DEV_SEED ?? 0);
  const added = seedContestants(mainRoom(), count);
  if (added > 0) console.log(`[dev] seeded ${added} contestants into MAIN`);
}
