import type { Stats } from "./types.js";

export const STAT_BUDGET = 35;
export const STAT_MIN = 1;
export const STAT_MAX = 8;

export const STAT_KEYS = [
  "charisma",
  "cunning",
  "grit",
  "strength",
  "charm",
  "instinct",
  "resolve",
] as const;

export function validateStats(
  stats: Stats
): { ok: true } | { ok: false; error: string } {
  const sum = STAT_KEYS.reduce((total, key) => total + stats[key], 0);

  // Check sum
  if (sum !== STAT_BUDGET) {
    return { ok: false, error: `Stats must sum to ${STAT_BUDGET}, got ${sum}` };
  }

  // Check each stat is within range and is an integer
  for (const key of STAT_KEYS) {
    const value = stats[key];
    if (!Number.isInteger(value)) {
      return { ok: false, error: `${key} must be an integer, got ${value}` };
    }
    if (value < STAT_MIN || value > STAT_MAX) {
      return {
        ok: false,
        error: `${key} must be between ${STAT_MIN} and ${STAT_MAX}, got ${value}`,
      };
    }
  }

  return { ok: true };
}

export function maxHpFromGrit(grit: number): number {
  return 60 + 8 * grit;
}
