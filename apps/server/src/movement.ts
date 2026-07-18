import { TICK_MS, tunables } from "@arena/shared";
import type { Contestant } from "@arena/shared";
import { isWalkable, TILE_SIZE, WORLD_HEIGHT, WORLD_WIDTH } from "./map.js";
import { rand } from "./social.js";
import { state } from "./state.js";

// Intent execution (ARCHITECTURE.md 6.2). Positions are world pixels;
// every candidate step is clamped to the island's walkable mask. Heading is
// server-internal movement bookkeeping, deliberately NOT on the shared
// Contestant type -- it means nothing to any other module.

const BASE_SPEED = 30; // px/s; ~2 tiles/s
const INSTINCT_SPEED_BONUS = 2; // px/s per instinct point

// Per-intent pace: wandering is an amble, steering intents move with
// purpose, laying low is deliberately slow.
const PACE: Record<string, number> = {
  wander: 0.7,
  approach: 1,
  attack: 1,
  flee: 1,
  layLow: 0.5,
};

// Minimum breathing room between two living islanders. Below this the
// separation pass pushes them apart so sprites never stack (which made
// conversing pairs glitch on top of each other).
const MIN_SEP = 0.8 * TILE_SIZE;

const WANDER_JITTER = 0.35; // radians of heading drift per tick
const RETARGET_MS_MIN = 2_000; // full re-pick cadence keeps paths organic
const RETARGET_MS_MAX = 6_000;
const FLEE_JITTER = 0.5;

type Heading = { angle: number; retargetAt: number };

// Per-room movement state (Phase 9). `cur` is pointed at the room being
// processed by useMovement(); the module body reads it, so no signatures change.
export type MovementState = { headings: Map<string, Heading> };
export function createMovementState(): MovementState {
  return { headings: new Map() };
}
let cur: MovementState = createMovementState();
export function useMovement(s: MovementState): void {
  cur = s;
}

export function resetMovement(): void {
  cur.headings.clear();
}

function headingFor(id: string, now: number): Heading {
  let h = cur.headings.get(id);
  if (!h) {
    h = { angle: rand() * Math.PI * 2, retargetAt: now };
    cur.headings.set(id, h);
  }
  return h;
}

function angleTo(from: Contestant, x: number, y: number): number {
  return Math.atan2(y - from.y, x - from.x);
}

// Quadrant with the fewest living contestants; layLow drifts toward its
// center.
function lowestDensityPoint(): { x: number; y: number } {
  const counts = [0, 0, 0, 0];
  for (const c of Object.values(state.contestants)) {
    if (!c.alive) continue;
    const q = (c.x >= WORLD_WIDTH / 2 ? 1 : 0) + (c.y >= WORLD_HEIGHT / 2 ? 2 : 0);
    counts[q]!++;
  }
  const q = counts.indexOf(Math.min(...counts));
  return {
    x: (q % 2 === 0 ? 1 : 3) * (WORLD_WIDTH / 4),
    y: (q < 2 ? 1 : 3) * (WORLD_HEIGHT / 4),
  };
}

// The other living participant of `convId`, if one is still around.
function conversePartner(c: Contestant, convId: string): Contestant | undefined {
  for (const other of Object.values(state.contestants)) {
    if (other.id === c.id || !other.alive) continue;
    if (other.intent.kind === "converse" && other.intent.convId === convId) return other;
  }
  return undefined;
}

// Desired heading for this tick given the contestant's intent. Targets that
// no longer resolve (dead/unknown) degrade to wander rather than freezing
// the sprite.
function desiredAngle(c: Contestant, h: Heading, now: number): number {
  const intent = c.intent;
  switch (intent.kind) {
    case "approach":
    case "attack": {
      const target = state.contestants[intent.target];
      if (target?.alive) return angleTo(c, target.x, target.y);
      break;
    }
    case "flee": {
      const threat = intent.from ? state.contestants[intent.from] : undefined;
      if (threat) {
        return angleTo(c, threat.x, threat.y) + Math.PI + (rand() - 0.5) * FLEE_JITTER;
      }
      break;
    }
    case "layLow": {
      const p = lowestDensityPoint();
      return angleTo(c, p.x, p.y) + (rand() - 0.5) * WANDER_JITTER;
    }
    case "converse": {
      // Only reachable with calmConversations on (the pin below returns first
      // otherwise). Lean toward whoever is in the same conversation so the
      // small talking-pace steps read as two people shifting their weight
      // around each other rather than drifting apart; separate() pushes back
      // once they close inside MIN_SEP, which is what keeps the pair hovering
      // at a fixed, natural-looking gap. No partner (they just left, or the
      // record is gone) degrades to a wander rather than freezing the sprite.
      const partner = conversePartner(c, intent.convId);
      if (partner) return angleTo(c, partner.x, partner.y) + (rand() - 0.5) * WANDER_JITTER;
      break;
    }
    default:
      break;
  }
  // Wander: heading persistence with per-tick jitter and an occasional full
  // re-pick.
  if (now >= h.retargetAt) {
    h.angle = rand() * Math.PI * 2;
    h.retargetAt = now + RETARGET_MS_MIN + rand() * (RETARGET_MS_MAX - RETARGET_MS_MIN);
  }
  return h.angle + (rand() - 0.5) * 2 * WANDER_JITTER;
}

// Step 2 of the tick: execute every living agent's intent. Returns only the
// sprites that actually moved, already shaped for the tick diff.
export function moveContestants(now: number): [id: string, x: number, y: number][] {
  const dt = TICK_MS / 1000;

  const living = Object.values(state.contestants).filter((c) => c.alive);
  // Snapshot pre-move positions so the returned diff includes anything the
  // separation pass nudges (including conversing sprites, which are pinned
  // outright unless calmConversations is on).
  const origin = new Map<string, [number, number]>();
  for (const c of living) origin.set(c.id, [c.x, c.y]);

  // "Moves much less than an idle one" (spec Task G), not "frozen": with
  // calmConversations on, a conversing islander keeps stepping at a fraction of
  // normal pace instead of being pinned. The flag-off path is the original hard
  // pin, byte for byte, so today's build is unchanged when it is off.
  const calm = tunables.flags.calmConversations;
  const talkingPace = Math.max(0, tunables.movement.talkingPaceScale);
  const idlePace = Math.max(0, tunables.movement.idlePaceScale);

  for (const c of living) {
    const conversing = c.intent.kind === "converse";
    if (conversing && !calm) continue; // pinned in place mid-conversation

    const h = headingFor(c.id, now);
    const paceScale = calm ? (conversing ? talkingPace : idlePace) : 1;
    const speed =
      (BASE_SPEED + INSTINCT_SPEED_BONUS * c.stats.instinct) * (PACE[c.intent.kind] ?? 1) * paceScale;
    const step = speed * dt;
    const angle = desiredAngle(c, h, now);

    // Walkable clamping: try the desired heading, then rotations away from
    // the obstacle, so coastline contact turns sprites instead of pinning
    // them.
    for (const delta of [0, Math.PI / 3, -Math.PI / 3, (2 * Math.PI) / 3, (-2 * Math.PI) / 3, Math.PI]) {
      const a = angle + delta;
      const nx = c.x + Math.cos(a) * step;
      const ny = c.y + Math.sin(a) * step;
      if (isWalkable(nx, ny)) {
        c.x = nx;
        c.y = ny;
        h.angle = a;
        break;
      }
    }
  }

  separate(living);

  // Emit every sprite whose position actually changed this tick (moved or
  // separated), rounded for a compact diff.
  const moves: [string, number, number][] = [];
  for (const c of living) {
    const o = origin.get(c.id)!;
    if (Math.abs(c.x - o[0]) > 1e-4 || Math.abs(c.y - o[1]) > 1e-4) {
      moves.push([c.id, Math.round(c.x * 10) / 10, Math.round(c.y * 10) / 10]);
    }
  }
  return moves;
}

// Cheap deterministic O(n^2) de-overlap: any two living islanders closer than
// MIN_SEP are pushed apart along the line between them, symmetrically when both
// resulting spots are walkable, otherwise the whole push goes to whichever side
// stays on the island (and is skipped if neither can move). Conversing pairs are
// separated the same way, so a pinned pair ends up a small fixed gap apart
// instead of stacked.
function separate(living: Contestant[]): void {
  for (let i = 0; i < living.length; i++) {
    for (let j = i + 1; j < living.length; j++) {
      const a = living[i]!;
      const b = living[j]!;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.hypot(dx, dy);
      if (d >= MIN_SEP) continue;
      const overlap = MIN_SEP - d;
      // Unit vector a->b; on an exact stack pick a deterministic direction.
      const ux = d > 1e-6 ? dx / d : Math.cos(i + j);
      const uy = d > 1e-6 ? dy / d : Math.sin(i + j);
      const half = overlap / 2;
      const aX = a.x - ux * half;
      const aY = a.y - uy * half;
      const bX = b.x + ux * half;
      const bY = b.y + uy * half;
      const aOk = isWalkable(aX, aY);
      const bOk = isWalkable(bX, bY);
      if (aOk && bOk) {
        a.x = aX;
        a.y = aY;
        b.x = bX;
        b.y = bY;
      } else if (aOk) {
        // b is boxed in against the coast: push a the whole way instead.
        const ax = a.x - ux * overlap;
        const ay = a.y - uy * overlap;
        if (isWalkable(ax, ay)) {
          a.x = ax;
          a.y = ay;
        }
      } else if (bOk) {
        const bx = b.x + ux * overlap;
        const by = b.y + uy * overlap;
        if (isWalkable(bx, by)) {
          b.x = bx;
          b.y = by;
        }
      }
      // Neither can move without leaving the map: leave them (rare, transient).
    }
  }
}
