// ---------------------------------------------------------------------------
// Swarm backend configuration.
//
// One flag decides whether the seam is used at all, and one setting picks the
// active backend behind it. Everything is read once at module load so a single
// game never straddles two configurations.
//
//   SWARM_BACKEND_ENABLED=0   restore the exact pre-seam wiring (hosted client
//                             constructed and threaded as before). The escape
//                             hatch: the whole feature is behind this flag.
//   SWARM_BACKEND=local       active backend. local | anthropic | hosted | rules.
//
// SWARM_BACKEND order of preference when unset. Leaving SWARM_BACKEND unset is
// not the same as choosing "local" - it means "pick for me", and the pick is:
//
//   1. anthropic, if ANTHROPIC_API_KEY is set (best quality, already paid for)
//   2. local, otherwise (free; the resilient wrapper and the boot health probe
//      in backends/index.ts degrade cleanly to rules if Ollama turns out not
//      to be reachable)
//
// An explicit SWARM_BACKEND always wins over this, in either direction:
// SWARM_BACKEND=local with ANTHROPIC_API_KEY set spends nothing, deliberately.
// backends/index.ts warns at boot either way, so which case happened is never
// silent.
//
// Local (Ollama) knobs:
//   SWARM_LOCAL_HOST=http://127.0.0.1:11434
//   SWARM_LOCAL_MODEL              unset by default. An explicit value always
//                                  wins; left unset, backends/ollama.ts
//                                  auto-detects whatever is actually installed
//                                  by querying /api/tags, falling back to the
//                                  historic llama3.2 default only if that
//                                  probe itself fails. This is not cosmetic:
//                                  a hardcoded default model that was never
//                                  pulled on a given machine is why the whole
//                                  local path silently degraded to rule-engine
//                                  templates for every single call.
//   SWARM_LOCAL_TIMEOUT_MS=20000
//
// Hosted (any OpenAI-compatible chat-completions endpoint) knobs, spec Task A
// / section 5 option 2 - the free tier path, distinct from the paid Anthropic
// one:
//   SWARM_HOSTED_BASE_URL          e.g. https://api.groq.com/openai/v1. Unset
//                                  means the hosted backend is unavailable and
//                                  selecting it falls straight to rules.
//   SWARM_HOSTED_MODEL             defaults to gpt-4o-mini as a name every
//                                  OpenAI-compatible provider recognizes the
//                                  shape of; override to whatever the chosen
//                                  provider actually serves.
//   SWARM_HOSTED_API_KEY           optional - some free tiers need no key.
//   SWARM_HOSTED_TIMEOUT_MS=10000
//
// Whatever the active backend, the rule engine is wired underneath it as the
// automatic fallback (see backends/resilient.ts), so the sim keeps running with
// no model reachable at all.
// ---------------------------------------------------------------------------

export type BackendKind = "local" | "anthropic" | "hosted" | "rules";

// Both read from the passed environment, never from process.env directly, so
// readSwarmConfig stays injectable and testable.
function envFlag(env: NodeJS.ProcessEnv, name: string, dflt: boolean): boolean {
  const v = env[name];
  if (v == null || v === "") return dflt;
  return v !== "0" && v.toLowerCase() !== "false" && v.toLowerCase() !== "off";
}

function envInt(env: NodeJS.ProcessEnv, name: string, dflt: number): number {
  const n = Number(env[name]);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

function parseBackend(env: NodeJS.ProcessEnv): BackendKind {
  const raw = (env.SWARM_BACKEND ?? "").trim().toLowerCase();
  switch (raw) {
    case "anthropic":
      return "anthropic";
    case "hosted":
      return "hosted";
    case "rules":
    case "rule":
    case "none":
      return "rules";
    case "local":
    case "ollama":
      return "local";
    case "":
      // No explicit choice: order of preference (see header comment).
      return env.ANTHROPIC_API_KEY ? "anthropic" : "local";
    default:
      // An unrecognized value must not silently disable the game's brain.
      return "local";
  }
}

export type SwarmConfig = {
  // Master flag for the whole backend seam.
  enabled: boolean;
  backend: BackendKind;
  // True when SWARM_BACKEND was set to anything at all, recognized or not.
  // Distinguishes an operator's explicit choice from the order-of-preference
  // default, since only the latter should stay quiet about an unspent
  // ANTHROPIC_API_KEY.
  backendExplicit: boolean;
  local: { host: string; model: string | undefined; timeoutMs: number };
  anthropic: { apiKey: string | undefined; timeoutMs: number };
  hosted: { baseUrl: string; model: string; apiKey: string | undefined; timeoutMs: number };
};

export function readSwarmConfig(env: NodeJS.ProcessEnv = process.env): SwarmConfig {
  return {
    enabled: envFlag(env, "SWARM_BACKEND_ENABLED", true),
    backend: parseBackend(env),
    backendExplicit: (env.SWARM_BACKEND ?? "").trim() !== "",
    local: {
      host: (env.SWARM_LOCAL_HOST ?? "http://127.0.0.1:11434").replace(/\/+$/, ""),
      // No hardcoded fallback here on purpose - see the header comment.
      // backends/ollama.ts auto-detects when this is undefined.
      model: env.SWARM_LOCAL_MODEL,
      // Local inference is free but slower than the hosted path, especially on
      // the first call into a cold model, so this runs longer than the hosted
      // 10 s. A call that overruns it still costs nothing: it drops to the rule
      // engine for that turn and the breaker keeps a dead server cheap.
      timeoutMs: envInt(env, "SWARM_LOCAL_TIMEOUT_MS", 20_000),
    },
    anthropic: {
      apiKey: env.ANTHROPIC_API_KEY,
      timeoutMs: envInt(env, "SWARM_CALL_TIMEOUT_MS", 10_000),
    },
    hosted: {
      baseUrl: (env.SWARM_HOSTED_BASE_URL ?? "").replace(/\/+$/, ""),
      model: env.SWARM_HOSTED_MODEL ?? "gpt-4o-mini",
      apiKey: env.SWARM_HOSTED_API_KEY,
      timeoutMs: envInt(env, "SWARM_HOSTED_TIMEOUT_MS", 10_000),
    },
  };
}

export const swarmConfig: SwarmConfig = readSwarmConfig();
