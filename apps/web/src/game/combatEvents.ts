// A tiny transient event bus for one-shot combat visuals the Phaser scene
// plays but that aren't game state (a fight-start flash). Death is NOT here --
// it flows through the game store (killContestant) and the scene's roster sync,
// which drives the death animation. Positions/HP have their own channels; this
// only carries "flash these two sprites now".

type FightListener = (attackerId: string, defenderId: string, betrayal: boolean) => void;

const fightListeners = new Set<FightListener>();

export function onFight(listener: FightListener): () => void {
  fightListeners.add(listener);
  return () => fightListeners.delete(listener);
}

export function emitFight(attackerId: string, defenderId: string, betrayal: boolean): void {
  for (const l of fightListeners) l(attackerId, defenderId, betrayal);
}
