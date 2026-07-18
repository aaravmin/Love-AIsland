import type Anthropic from "@anthropic-ai/sdk";
import type { ModelBackend } from "../backend.js";
import { swarmConfig, type SwarmConfig } from "../config.js";
import { createAnthropicBackend, wrapAnthropicClient } from "./anthropic.js";
import { createHostedBackend } from "./hosted.js";
import { createOllamaBackend } from "./ollama.js";
import { createResilientBackend } from "./resilient.js";
import { createRuleBackend } from "./rules.js";

export { createAnthropicBackend, wrapAnthropicClient } from "./anthropic.js";
export { createHostedBackend } from "./hosted.js";
export { createOllamaBackend } from "./ollama.js";
export { createResilientBackend } from "./resilient.js";
export { createRuleBackend } from "./rules.js";

// ---------------------------------------------------------------------------
// Backend selection. Reads the config, builds the chosen primary, and wraps it
// so the rule engine is underneath whatever was chosen. Selecting "rules"
// explicitly skips the wrapper because it would be wrapping itself.
//
// Note there is no failure mode that returns null: if the configured backend
// cannot be constructed at all (no API key, no hosted base URL, say), the rule
// engine is returned and the game runs on rules alone.
// ---------------------------------------------------------------------------

export function createBackend(
  config: SwarmConfig = swarmConfig,
  onStateChange?: (state: "primary" | "fallback", reason: string) => void,
): ModelBackend {
  const rules = createRuleBackend();

  let primary: ModelBackend | null = null;
  switch (config.backend) {
    case "local":
      primary = createOllamaBackend(config.local);
      break;
    case "anthropic":
      primary = config.anthropic.apiKey ? createAnthropicBackend(config.anthropic.apiKey) : null;
      break;
    case "hosted":
      primary = config.hosted.baseUrl ? createHostedBackend(config.hosted) : null;
      break;
    case "rules":
      primary = null;
      break;
  }

  // A configured paid key going unused is easy to miss until the bill never
  // arrives and the dialogue never improves either - this used to be a silent
  // no-op. It no longer is: an unset SWARM_BACKEND already prefers anthropic
  // when a key is present (see config.ts), so the two warnings below cover
  // the two ways this can still happen: an explicit override away from
  // anthropic, or the auto-selection itself, so which one occurred is never
  // ambiguous from the boot log.
  if (config.anthropic.apiKey && config.backendExplicit && config.backend !== "anthropic") {
    console.warn(
      `[swarm] ANTHROPIC_API_KEY is set but SWARM_BACKEND=${config.backend} was chosen explicitly, so the key goes unused. Set SWARM_BACKEND=anthropic to spend it, or unset SWARM_BACKEND to prefer it automatically.`,
    );
  } else if (config.anthropic.apiKey && !config.backendExplicit) {
    console.warn(
      `[swarm] ANTHROPIC_API_KEY is set and SWARM_BACKEND was not specified; auto-selecting anthropic. Set SWARM_BACKEND=local, hosted, or rules to use something else.`,
    );
  }

  if (!primary) return rules;

  const backend = createResilientBackend({ primary, rules, onStateChange });

  // Startup health probe. Today the only signal that the whole game has
  // fallen back to templates is a state-change log line that only fires once
  // the breaker actually trips - after a run of failed calls. This probes the
  // chosen primary once at boot, fire-and-forget, so "robotic dialogue" and
  // "no model reachable" stop being indistinguishable from the very first
  // tick rather than after several thinks have already failed.
  void primary
    .healthy()
    .then((ok) => {
      if (ok) {
        console.log(`[swarm] ${primary!.name} answered its boot health probe.`);
      } else {
        console.warn(
          `[swarm] ${primary!.name} did NOT answer its boot health probe. The game will run on rule-engine dialogue until it does - this is very likely why dialogue reads as templated.`,
        );
      }
    })
    .catch((err) => {
      console.warn(
        `[swarm] ${primary!.name}'s boot health probe threw (${err instanceof Error ? err.message : String(err)}). Falling back to rule-engine dialogue.`,
      );
    });

  return backend;
}

// Accept either a backend or a pre-seam client. Lets the call sites that used
// to be handed a vendor client keep their signatures while everything
// downstream of them speaks only ModelBackend.
export function toBackend(
  source: Anthropic | ModelBackend | null | undefined,
): ModelBackend | null {
  if (!source) return null;
  if (typeof (source as ModelBackend).decide === "function") return source as ModelBackend;
  return wrapAnthropicClient(source as Anthropic);
}
