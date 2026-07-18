// packages/swarm: when/how agents think, all prompts, model calls, spend cap,
// fallback behavior. Consumed as source by apps/server, which runs it
// in-process (ARCHITECTURE.md section 3). The swarm reads the world only
// through WorldView and writes only through DecisionSink (the frozen contract
// in @arena/shared).
//
// Model calls go through the ModelBackend seam (backend.ts): the game logic
// asks for a decision or a line and never learns which provider, if any,
// served it. Backends live in ./backends.
export { fallbackDecision, stripSpeechDashes, resetAllianceCooldowns } from "./fallback.js";
export { createBatchThinker } from "./decisions.js";
export { createSwarmScheduler, ruleThinker } from "./scheduler.js";
export type { SwarmScheduler, SwarmSchedulerOptions, Thinker, ThinkResult } from "./scheduler.js";
export { createThinker } from "./decisions.js";
export { runConversation } from "./conversation.js";
export type { ConversationDeps } from "./conversation.js";
export { createAnthropic } from "./anthropic.js";
export { SpendTracker } from "./spend.js";
export type { Usage } from "./spend.js";

// The backend seam.
export type { ModelBackend, LLMResult, ConvTurn, ConvFinal, TranscriptLine } from "./backend.js";
export {
  createBackend,
  toBackend,
  createAnthropicBackend,
  createOllamaBackend,
  createResilientBackend,
  createRuleBackend,
  wrapAnthropicClient,
} from "./backends/index.js";
export { readSwarmConfig, swarmConfig } from "./config.js";
export type { BackendKind, SwarmConfig } from "./config.js";
