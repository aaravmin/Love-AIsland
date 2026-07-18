# Love AIsland Behavior, Awareness, and Market Update Spec

This is a build spec for Claude Code. It contains no code. It describes behavior, ownership, and acceptance criteria only. The game is already built. The prime directive is to extend the existing systems, not replace or overwrite them.

---

## 0. How to run this

Do these in order. Do not skip.

1. Run `/compact` first.
2. Read this entire file before editing anything.
3. Inventory the existing codebase before writing. Find and note where each of these already lives so you extend it instead of rebuilding it.
   - the agent decision loop and the persona prompt system
   - the conversation system and where speech text is produced
   - the movement system
   - the render layer for sprites, bubbles, nodes, and the odds shown above heads
   - the prediction market and odds logic
   - the alliance and voting logic
   - any existing memory or relationship state
   - any existing event or world state tracking
   - the model client that calls the Anthropic API
4. Golden rule. Extend, do not overwrite. Keep every existing public interface and file that is not named in a task. If a task needs a new field, add it next to the old one rather than renaming the old one.
5. Work on a branch. Make small commits, one behavior per commit.
6. Run the game before you start and capture the current behavior as a baseline. Run it again after each task. If a task changes something a spectator sees, capture a screenshot and stop for sign-off before moving on.
7. Every new behavior in this spec sits behind a config flag and can be turned off. With all flags off the game must behave exactly as it does today.
8. Nothing added here may hard crash the sim. Every new path degrades to a safe default. If a model call fails, if a value is missing, if state is unexpected, the sim keeps running.
9. Ask clarifying questions before coding anything ambiguous.

---

## 1. Execution plan and sub-agent layout

Run this in three phases. Phase 1 builds the shared contracts that later tasks read from. Phase 2 is parallel feature work. Phase 3 is integration and tuning.

Sub-agents do not talk to each other freely. They coordinate through the shared contracts from Phase 1 and through the event feed. Any two tasks that write the same file must not run at the same time. Tasks that write different files run in parallel. The list below marks which is which.

### Phase 1. Foundations. One owner, sequential

Build the shared contracts in section 2 first. Then Task A and Task F. Everything in Phase 2 depends on these existing.

### Phase 2. Features. Parallel

Task B, Task C, Task D, Task E, and Task G touch mostly separate areas and can run in parallel. The one shared surface is the awareness signals from Task D, which B and C read. Build Task D signals first inside Phase 2, then B and C.

### Phase 3. Integration and tuning

Wire everything together, run full games, and tune the config knobs so early game has some conflict without swinging to chaos.

### Suggested model and effort per task

Match the harder reasoning tasks to your top tier and the mechanical tasks to cheaper models. This follows your usual split of Fable for planning then graded sub-agents for execution.

| Task | Nature | Suggested tier |
| --- | --- | --- |
| Shared contracts | Schema and wiring | Mid |
| A Model backend | Infra, low reasoning | Mid |
| B Cognition and dialogue | High reasoning | Top tier, high effort |
| C Social mechanics | High reasoning | Top tier, high effort |
| D Awareness | Medium reasoning | Mid to high |
| E Market odds | Mechanical | Mid |
| F Memory and outcomes | Schema and wiring | Mid |
| G Render and UI | Mechanical, visual | Mid |
| Phase 3 integration | Judgement | Top tier |

---

## 2. Shared contracts. Build these first

These are the pieces every task reads from. Build them once so parallel tasks do not each invent their own version.

### Config file for tunables

Create one config surface that holds every knob added by this spec. Nothing in this spec is hardcoded. At minimum it holds the conflict warmup window, the base conflict and vote likelihood, the personality multipliers, the ouster threshold, the tie rule, the odds shift sizes on each event type, the overhearing radius, the crowded and secluded thresholds, the movement speed while idle versus while talking, and the chosen model backend. Every flag defaults to off or to today's behavior.

### Interaction outcome set

A conversation ends in exactly one outcome. The set is these five.

- None. Nothing came of it. No icon. Most conversations end here.
- Alliance. The two agreed to work together. Shown as a handshake.
- Fight. Open conflict. Shown as a fight icon.
- Tension. Negative but not open conflict. A soft bad outcome.
- Amicable. Positive but not an alliance. A soft good outcome.

Outcomes are not forced. A conversation only produces one when the content warrants it.

### Relationship memory schema

Each ordered pair of agents has a relationship record. It accumulates outcomes over time. It holds running trust, perceived threat, and affinity, plus the recent outcome history. All five outcome types are remembered, including tension and amicable, which are the easy ones to drop. Accumulated tension raises the odds of a future fight or a vote against that agent. Accumulated amicable and alliances raise trust and the odds of joining an alliance. Old outcomes fade in weight but are not erased.

### Event feed and world state

One central feed that records world events and one snapshot of current world state. Events include a death, a purge or forced elimination, an alliance forming or breaking, a vote result, and the living count changing. World state exposes how many are alive, what phase the game is in, and whether an event is imminent, active, or just passed. Agents read from this rather than each polling raw game state. If a feed like this already exists, extend it.

### Model backend abstraction

A single seam the agent brain calls to think and to speak. The game logic never names a provider. The backend behind the seam is chosen in config. This is what makes Task A possible without touching game logic.

---

## 3. Tasks

Each task lists its goal, what to preserve, what to add, and when it is done. No code.

### Task A. Model backend and offline fallback

**Goal.** Let the game run on something other than the Anthropic API, including with no paid API at all.

**Preserve.** The current Anthropic path stays as one selectable backend and remains the default. Do not delete it.

**Add.** Route every model call through the backend seam from section 2. Add these backends behind config.
- The existing Anthropic path.
- A local model path for running models on your own machine at no per call cost.
- A free tier hosted path.
- A rule based fallback that needs no model at all. It drives decisions from the relationship and world state and produces speech from templates and variation. It is the always available safety net. When no model backend is reachable or a call fails, the sim falls back to this instead of stopping.

Add call batching per tick, a per tick call budget, and caching of the stable parts of each prompt such as persona and rules, so only the changing context is sent. This cuts cost and load on every backend.

See section 5 for the plain explanation and the recommended setup.

**Done when.** The game plays a full run with the Anthropic backend turned off. It also plays a full run with every model backend turned off, using only the rule based fallback, without crashing.

### Task B. Agent cognition and dialogue

**Goal.** Make agents reason like Survivor players and talk like people.

**Preserve.** The persona system and existing traits. Do not flatten personalities into one voice.

**Add.**
- Conversation variety. Right now they always talk about the game. Give them ordinary topics too, such as backstory, small talk, jokes, likes, and reactions to the setting. Game talk becomes one topic among several, weighted by personality and situation, not the only one.
- No dashes in speech. Islander speech contains no dashes of any kind. Strip them at the point speech is produced so nothing slips through.
- Survivor style vote reasoning. An agent does not vote someone out only because it dislikes them. It weighs whether the target is a threat, how well liked the target is, and whether the votes to pull it off actually exist. Read the relationship record and the living count to make this call.
- Vote deflection. In a voting event, a target that senses danger tries to steer votes away from itself and toward someone else, by persuasion and by leaning on its relationships.
- Early game aggression. Agents currently almost never fight or push votes early. Raise the baseline slightly so it can happen sooner, scaled by personality, and ramped in by the warmup window rather than switched on all at once. A bold or scheming personality may actively stir trouble and try to build a case against someone. A timid one still mostly holds back.
- Use of self odds. Read the coarse self odds signal from Task D and let it change behavior. A low estimate makes some personalities push harder and others withdraw. This changes choices, not personality.

**Done when.** Reading a batch of transcripts, most conversations are not about the game, none contain dashes, and vote talk cites threat or likability or vote math rather than raw dislike.

### Task C. Social mechanics

**Goal.** Alliances of more than two, and voting that resolves cleanly.

**Preserve.** Existing alliance and vote logic. Extend it to more than two members rather than replacing it.

**Add.**
- Multi person alliances. An alliance can hold two or more members. Reasons include self protection and forming a voting bloc. Track each alliance as a group, not only as pairs.
- Alliance cohesion and defection. A multi person alliance has a cohesion level that rises with shared amicable outcomes and successful joint votes and falls with betrayal or divergent interests. A member can defect when its own survival points elsewhere. This is the source of most drama, so make it possible, not constant.
- Spontaneous ouster threshold. Outside a formal voting event, an agent can be targeted for elimination only when at least one third of living islanders agree to target them.
- Voting event resolution. In a formal voting event, everyone votes and the most votes is eliminated. On a tie, eliminate whoever has the lower current health. If health is also tied, break it with a fixed deterministic rule tied to the run seed so the sim never deadlocks. State this rule once and use it everywhere.
- Attempt to act. Agents try to push an ouster when circumstances favor it and they have the numbers. This is situational, not forced. When the math is not there, they hold or switch targets.

**Done when.** A run produces at least one alliance with three or more members, a voting event resolves by plurality, and a manufactured tie resolves by lower health.

### Task D. Awareness

**Goal.** Agents notice the world, the room, and their own standing.

**Preserve.** Existing sensing or proximity logic if any. Extend it.

**Add.**
- World and event awareness. Agents read the event feed and world state. They know roughly how many are left and they react to events. Before a purge they brace and shift alliances. During and right after one they operate differently. They talk about and think about these events, and it influences what they do.
- Spatial awareness. An agent knows whether it is in a crowded area or a secluded one, using the thresholds in config. Crowded versus secluded changes behavior in a way that depends on personality. One agent gets bolder in a crowd, another only schemes when alone.
- Overhearing. An agent within the overhearing radius of a conversation it is not in can pick up part of it. Overheard information enters that agent's knowledge and can later be shared, so it spreads through the group as gossip. This makes position on the map matter.
- Coarse self odds. Each agent maintains a rough sense of its own standing without ever seeing an exact percentage. It is built from things it can observe, such as how many alliances it holds, how many it has fallen out with, and how active it has been. If it cannot make alliances or has done little, it notices and thinks about it privately. This signal is what Task B and Task C read. Awareness level varies by personality, so the same weak position worries one agent and not another.

**Done when.** Behavior visibly shifts around a purge, an agent placed near a private talk later references what it overheard, and no agent ever states an exact odds number about itself.

### Task E. Prediction market odds

**Goal.** Odds move with the game, not only with bets.

**Preserve.** The existing betting flow, the token pool, and the Polymarket style display. Do not change how bets are placed.

**Add.**
- Odds shift on death. When an islander dies, the survivors' odds of winning rise, since the field is smaller. An everyone lives style line rises as deaths accumulate. This happens on death specifically, separate from betting.
- Odds drift on observable events. Odds also move on events a spectator can see, such as an alliance forming, a fight, tension, or a purge. Keep these moves smaller than the move on a death so death stays the dominant signal. Sizes live in config.

**Done when.** With no bets placed at all, odds still change across a run as agents die and events fire.

### Task F. Memory and outcomes

**Goal.** Detect conversation outcomes, remember them, and let agents recall them.

**Preserve.** Any existing memory. Extend the schema from section 2 rather than starting a new store.

**Add.**
- Outcome detection. At the end of a conversation, decide which of the five outcomes it produced, if any.
- Persistence. Write the outcome into the relationship record for both agents. Update trust, threat, and affinity. All five outcomes persist, tension and amicable included.
- Recall. Expose the relationship record to Task B, C, and D so past outcomes shape future speech, alliance choices, and votes. Two agents with a history of tension carry it forward. Two with amicable history lean friendly.

**Done when.** An agent behaves differently toward someone it had tension with earlier in the same run, and toward someone it had an amicable moment with, and this survives across many ticks.

### Task G. Render and UI

**Goal.** Calmer, clearer visuals during conversation and outcome cues.

**Preserve.** Existing sprites, the name and odds shown above heads, the interaction nodes, click to read, and swipe to view past conversations. Do not disturb these.

**Add.**
- Reduce movement while talking. An islander in a conversation moves much less than an idle one, using the two speeds in config.
- Speech as a bubble only. While speaking, show the line only as a chat bubble above the head. Keep whatever routes full text into the node view.
- Outcome icons. When a conversation produces an outcome, briefly show a small icon by the pair. Handshake for alliance, a fight icon for fight, a tension icon for tension, and an amicable icon. No icon when the outcome is none, which is most of the time.

**Done when.** During a talk the two sprites mostly hold still and show bubbles, and an icon appears only on the conversations that produced an outcome.

---

## 4. Cross cutting rules

- No dashes in any islander speech, anywhere.
- One tie rule everywhere. Lower current health, then the seeded deterministic fallback if health ties too.
- Every new behavior is behind a config flag and tunable from the config surface. All flags off means today's behavior.
- Use one run seed so a run can be reproduced for debugging and so betting outcomes are auditable.

---

## 5. Running without the Anthropic API

Short answer. Yes, this can run without the Anthropic API. You have three real paths, and the clean setup uses more than one.

**Option 1. Local models on your own machine.** Run a local model runner and point the backend at it. There is no per call cost, so the swarm can make as many calls as your hardware allows and rate limits do not apply. The tradeoff is that smaller local models reason less well and run slower on weak hardware. A GPU helps a lot. Pick a small to mid size open model and a quantized version if memory is tight. This is the best fit for an agent swarm that makes many calls, if your machine can take it.

**Option 2. A free tier hosted model.** Several providers offer a free tier with fast, capable models. The catch is rate limits. Fifty agents making parallel calls will hit those limits quickly, so this only works with the batching, the per tick call budget, and backoff from Task A. Good for higher quality speech on a small cast or a slow tick.

**Option 3. The rule based fallback.** No model at all. Decisions come from the relationship and world state you already track. Speech comes from templates with variation. The game stays fully playable at zero cost and never depends on any quota. The dialogue is less lifelike, but the sim, the alliances, the voting, and the market all still work. This is also your safety net for when a model backend is down or out of quota.

**Recommended setup.** Build the backend seam, then run local models as the primary offline brain with the rule based fallback underneath it for when nothing is reachable. If you want better dialogue on the moments that matter, send only pivotal calls such as vote reasoning to a free tier hosted model, and let routine chatter run local or rule based. This tiering also cuts your cost sharply once you do have Anthropic credits again, so it is worth building either way.

---

## 6. What I added

Beyond your list, I put these in the spec. Each one is optional and can be turned off.

- A three phase plan that builds shared contracts before parallel work, so two sub-agents cannot overwrite each other. This is the main guard against breaking what already works.
- One config surface for every knob, so nothing is hardcoded and every new behavior can be toggled and compared against today's build.
- Feature flags on all new behavior, with all flags off equal to current behavior.
- A single event feed and world state snapshot, so event awareness is decoupled and low risk.
- A weighted relationship record with trust, threat, and affinity, since your Survivor style vote logic needs more than like and dislike anyway.
- A private self odds sense so agents can gauge and worry about their standing without ever seeing a number.
- Overheard information that spreads as gossip, so map position actually matters.
- Alliance cohesion and defection, so multi person alliances can crack and create drama instead of being permanent.
- A vote math check, so an agent estimates whether it has the numbers before pushing and backs off or redirects when it does not.
- A warmup window and cooldowns on conflict, so early game goes from quiet to lively smoothly rather than swinging to chaos.
- A run seed and a stated final tie fallback, so runs are reproducible and the sim never deadlocks on a health tie.
- A rule based fallback brain, market drift on visible events, and call batching and caching, which together make the offline mode work and cut model cost.
