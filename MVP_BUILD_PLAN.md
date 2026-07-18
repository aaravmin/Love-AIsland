# Reality Island — MVP Build Plan

A live reality-TV survival simulation. Players scan a QR code, build a contestant, and drop it onto a top-down island. From then on the player has no control. Each contestant is an autonomous LLM agent. The agents roam, talk, form alliances, betray each other, and fight. Fights kill. The last contestant standing wins. While all this runs, spectators bet a fixed pool of tokens on who survives, on a Polymarket-style prediction market whose prices move in real time. Two winners at the end. The surviving contestant, and the spectator with the best portfolio.

Theme is Love Island meets Survivor meets Big Brother. Not fantasy RPG. Classes are personality archetypes, not mage or archer.

---

## How to run this build (read this first, Claude Code)

You are being driven by Fable for planning and design. Follow this operating model exactly.

1. **Plan and design first. Do not write feature code yet.** Read this whole document. Then ask the team the questions in the Open Questions section below. Wait for answers. Produce an architecture doc, the data models, and a task graph. Get team approval before any implementation.

2. **Spawn sub-agents at the right tier.** After the plan is approved, break work into tasks and assign each task to a sub-agent at an effort and model tier matched to its difficulty and token cost. Use the tier table below. Do not run everything on the top model. Reserve the top tier for reasoning-heavy work. Push boilerplate to cheap models.

3. **Build phase by phase.** Follow the phase order in the Build Phases section. Each phase produces something visible and runnable.

4. **Screenshot and sign-off at every gate.** After each phase, run the app, capture screenshots of the new feature (use a headless browser like Playwright to load the running app and screenshot the relevant screens, both a desktop width and a mobile width around 390px). Show the team the screenshots. State what was built. Wait for approval or changes before moving to the next phase. Do not skip a gate.

5. **Keep the repo splittable.** Four people are working across this. Keep the frontend, the sim server, the agent swarm, and the shared types package as clean separate modules so people do not collide.

### Model and effort tiers

- **Tier A. Max reasoning. Opus Max, high effort.** Use for architecture, the market math, agent prompt and persona design, combat balancing, and any decision that needs judgement. Small number of calls, high value.
- **Tier B. Strong coding. Strong model, medium to high effort.** Use for the sim loop, the socket layer, the LMSR market implementation, the agent scheduler, and settlement. Correctness matters here.
- **Tier C. Efficient coding. Mid model.** Use for Phaser scenes, React and shadcn UI components, character creation, the panels, and the market view. High volume, lower risk.
- **Tier D. Cheap glue. Cheapest fast model.** Use for config, type definitions, wiring, asset loading, and boilerplate.

Separate point. The agents inside the running game are not a build concern. At runtime they call the cheapest fast model with tiny context. See Cost Control.

---

## Open questions to ask before coding

Ask the team these before you write feature code. The spec below picks a sensible default for each. Confirm or change.

1. Agent count for the demo. Default is 50, with the system able to run fewer if fewer people join.
2. Starting tokens per spectator. Default is 50.
3. Combat model. Option one is single-exchange, one fight equals one death, resolved by stats plus randomness. Option two is HP with damage over a few exchanges and slow regen, which enables the surrounded-and-weak dynamic. Default is HP with regen because it makes the swarm behavior richer and the demo better.
4. Market model. Default is a per-contestant binary LMSR market, one market per contestant, priced continuously. Confirm the liquidity feel you want.
5. Number and timing of events. Default is 3 events fired at population or time thresholds.
6. Can a player both enter a contestant and bet, or do spectators only bet. Default is anyone can do both.
7. Prize handling. Default is a fixed cash prize for the surviving contestant and one for the best portfolio, awarded manually. Keep tokens as play money with no buy-in.
8. Should the architecture and swarm view be built for the demo. Default is yes, it is a scored differentiator.
9. Primary surface on mobile. Default is the island is the ambient view and the market list is the main interaction surface on small screens.
10. Which cheap model powers the swarm at runtime, and what is the token budget cap for the whole demo.

---

## Core loop

1. People scan a QR code and onboard with name and email.
2. They build a contestant. Pick a class. Allocate stat points on sliders. Write a one or two line personality blurb.
3. The contestant appears on the island as a sprite with a name and live odds above its head.
4. When enough contestants exist, the game starts.
5. Contestants roam. When two get close, a conversation can trigger. They talk, then decide to ally, avoid each other, or fight.
6. Fights kill. Kills raise your notoriety, which makes others more likely to target you.
7. Spectators watch and bet. Prices move as bets come in.
8. Two or three events fire during the run and shake up incentives.
9. One contestant is left. Markets settle. Two winners are shown.

---

## Tech stack (locked)

- **Frontend.** Next.js with React and TypeScript. One repo. Deploy on Vercel.
- **Island rendering.** Phaser on a canvas. Top-down. Pixel art with a single cohesive asset pack. Set pixelArt true and use integer camera zoom so art stays crisp.
- **UI chrome.** React and Tailwind. shadcn/ui for sliders, dialogs, cards, buttons, and inputs. The chrome sits in the DOM above the Phaser canvas.
- **Architecture and swarm view.** React Flow for the live node graph shown during the demo.
- **Realtime.** Socket.IO between clients and the sim server.
- **Sim server.** A Node process. It is authoritative. It holds world state, runs the tick loop, runs the agent scheduler, runs the LMSR markets, and settles. Host it on the DigitalOcean droplet.
- **State.** In memory on the sim server for a single game session. Add Redis or Postgres only if you want crash recovery. For the demo, in memory is fine.
- **Shared types.** A small package of TypeScript types imported by both the frontend and the server.

Two clocks. A fast clock for physics and rendering. A slow clock for agent thinking. The user only ever feels the fast one.

---

## Core data models

Use these as the starting shapes. Refine in planning.

```ts
type Class =
  | "bold"       // aggressor, seeks fights
  | "timid"      // survivor, stays under the radar
  | "schemer"    // manipulator, works the social game
  | "charmer"    // socialite, builds big alliances
  | "wildcard";  // chaotic, unpredictable

type Stats = {
  charisma: number;    // social influence, alliance forming, swaying votes
  cunning: number;     // deception, betrayal payoff, strategy
  grit: number;        // survivability, HP pool, endurance
  strength: number;    // combat power
  charm: number;       // public favor, softens notoriety
  instinct: number;    // threat detection, avoiding ambush, reaction
};

type Contestant = {
  id: string;
  name: string;
  ownerEmail: string;
  klass: Class;
  stats: Stats;        // allocated from a fixed budget, capped per stat
  persona: string;     // the one or two line blurb
  hp: number;          // current health
  maxHp: number;       // derived from grit
  alive: boolean;
  kills: number;
  notoriety: number;   // rises with kills, drives targeting
  x: number;
  y: number;
  intent: Intent;      // current behavior between think ticks
  allies: string[];    // contestant ids
  memory: MemoryItem[];// short rolling log of recent events witnessed
};

type Intent =
  | { kind: "wander" }
  | { kind: "approach"; target: string }
  | { kind: "attack"; target: string }
  | { kind: "flee" }
  | { kind: "layLow" };

type MemoryItem = { t: number; text: string }; // keep this list short

type Conversation = {
  id: string;
  participants: string[];
  messages: { speaker: string; text: string; tone: Tone }[];
  outcome: "alliance" | "truce" | "fight" | "nothing" | "ongoing";
  fightInitiator: string | null;
  startedAt: number;
  endedAt: number | null;
};

type Tone = "friendly" | "hostile" | "neutral" | "deceptive";

type Market = {
  contestantId: string;
  qYes: number;        // shares bought that they win
  qNo: number;         // shares bought that they do not win
  b: number;           // liquidity parameter
  priceHistory: { t: number; price: number }[]; // yes price over time
};

type Position = {
  spectatorId: string;
  contestantId: string;
  yesShares: number;
  noShares: number;
};

type Spectator = {
  id: string;
  name: string;
  email: string;
  tokens: number;      // starts at 50
};

type GameEvent = {
  id: string;
  kind: "ceremony" | "cull" | "twist";
  firedAt: number;
  resolved: boolean;
};

type GameState = {
  phase: "lobby" | "running" | "settled";
  startedAt: number | null;
  contestants: Record<string, Contestant>;
  conversations: Record<string, Conversation>;
  markets: Record<string, Market>;
  positions: Position[];
  spectators: Record<string, Spectator>;
  events: GameEvent[];
  winnerContestantId: string | null;
  winnerPortfolioId: string | null;
};
```

---

## Systems in detail

### 1. Character creation

Two steps. Onboarding then creation.

- **Onboarding.** A single mobile screen. Name and email. Reached by scanning a QR code that points at a join URL with a room code.
- **Creation.** Pick a class from a set of cards. Allocate stats with sliders. The total points are a fixed budget so choices trade off. Cap each stat so nothing maxes everything. Write a one or two line personality blurb. Show a live preview sprite with the chosen name tag.
- On submit, the contestant is written to game state and its sprite appears on the island.
- Keep looks identical across contestants except the name tag and odds. Differentiation is by name, class, stats, and odds, seen on tap. This was a deliberate call to avoid clutter and latency.

### 2. Classes, stats, skills

- **Stats.** Six, listed in the model. This is the cap. Each maps to both social and combat mechanics so no stat is dead weight.
- **Classes.** Five personality archetypes. Each does two things. It seeds a starting stat lean, and it flavors the agent system prompt so behavior reads as that archetype. Bold seeks fights. Timid hides and endures. Schemer allies and betrays. Charmer builds a following. Wildcard behaves erratically.
- **Skills.** One signature ability per class. Bold gets a first-strike damage bonus. Timid gets reduced chance of being targeted. Schemer gets a betrayal surprise bonus. Charmer can pull an ally into a fight. Wildcard gets a random buff each event.

### 3. Bird's eye island and sprite tags

- Top-down island built from a proper tileset. Layered water, sand, and grass. Not flat rectangles.
- Sprites move on the island. Camera can pan and pinch-zoom, which is how you handle many sprites on a phone.
- Above each living sprite sits a compact tag. The contestant name and the live odds percentage. Color the percentage by recent trend, green when rising, red when falling. This is the whole reason odds live above the head.
- On small screens, only render tags for on-screen sprites, and let the market list carry the detail.

### 4. Movement and the sim loop

- The sim server runs a fast tick around every 100 to 200 milliseconds. It updates positions and resolves combat. No LLM call is in this hot path.
- Movement is wander by default. Small random drift, a light bias toward the current intent. When intent is approach, drift toward the target. When flee, drift away.
- The server broadcasts only what changed each tick over the socket. Moved sprites, new conversations, fights, deaths, and price updates. A full snapshot goes out only when a client joins.
- The client interpolates between position updates so motion looks smooth at 60fps even though updates are sparse.

### 5. Agent swarm (decisions)

- Agents think on a slow clock, around every 15 to 30 seconds, staggered so they do not all fire at once.
- On a think tick, for each living agent the scheduler builds a tiny context. The persona, the class, own stats and HP, own kill count and notoriety, a short list of nearby contestants with their public info, the last few memory items, and any active event modifier. It calls the cheap model and gets back a structured decision.
- Decision schema returned by the model.

```json
{
  "action": "wander | approach | attack | flee | layLow | proposeAlliance",
  "target": "contestantId or null",
  "reasoning": "one short line, used for the architecture view and debugging"
}
```

- The server applies the decision by setting the agent intent. The fast loop then carries it out until the next think tick.
- Fire the 50 calls in parallel with a concurrency cap. Apply each decision the moment it lands. One slow call never stalls the others.

### 6. Conversations, alliances, reputation

- **Trigger.** When two or more living agents are within an interaction radius, a conversation can start. Gate it with a probability plus a condition so it does not fire constantly. Good conditions are low HP, a nearby high-notoriety threat, or an unmet neighbor.
- **Exchange.** A conversation is a short bounded back and forth. Two to four total messages. Each message is one cheap-model call conditioned on the speaker persona, the stats, the other party public info, and the conversation so far. Keep each line short.
- **Resolution.** When the exchange ends the model returns an outcome. Alliance, truce, fight, or nothing, and a fight initiator if any. Store the whole conversation with participants, transcript, tones, and outcome.
- **Alliances.** Allied agents do not attack each other and may defend each other. Alliances can break. A betrayal is a schemer breaking an alliance to land a surprise attack. Betrayals are dramatic and good for the demo.
- **Reputation.** Every kill raises notoriety. High notoriety makes other agents more likely to pick you as a target. This is the gang-up-on-the-threat balance. Charm softens how much notoriety hurts you. This whole loop is what produces the emergent social behavior, and it is the technical story you tell judges.
- **Message schema.**

```json
{ "speaker": "contestantId", "text": "short line", "tone": "friendly | hostile | neutral | deceptive" }
```

### 7. Interaction nodes (the UI piece)

- A node appears on the island only while contestants are interacting. It sits between the involved sprites and connects to each with a thin line.
- The node exists only for the duration of the interaction. When the conversation ends the node fades out.
- Tap a node to open the conversation panel and read the exchange. See section 10.
- Tap a sprite instead to open the contestant panel. Two different taps, two different panels. Keep them separate.

### 8. Combat and death

- Default combat is HP based. Each contestant has HP derived from grit. A fight is a few damage exchanges. Whoever hits zero dies.
- Hit chance and damage scale with strength and instinct, with randomness so upsets happen. Upsets are what keep the betting interesting.
- HP regenerates slowly when not fighting. So a contestant who just won a fight is weak for a moment. Fighting while surrounded is risky because another agent can finish you. This is the intended dynamic, and it comes for free from HP plus regen plus notoriety.
- On death, play a simple death animation, flip alive to false, remove the sprite tag, credit the killer with a kill, and raise the killer notoriety.
- If the team picks the simpler model instead, a fight resolves in one exchange and the loser dies immediately, with win probability from a combined power score. Keep the interface the same so you can swap models.

### 9. Prediction market (LMSR, Polymarket-style)

This is the part to get exactly right. Each contestant has its own binary market. The question is will this contestant win. It behaves like a Polymarket binary market. You buy Yes to bet they win, or No to bet they do not.

Use a Logarithmic Market Scoring Rule automated market maker. It gives continuous moving prices that respond to trades, which is the Polymarket feel.

For one binary market with Yes and No shares, let qYes and qNo be the total shares bought of each, and b be a liquidity parameter.

- **Cost function.**

```
C(qYes, qNo) = b * ln( exp(qYes / b) + exp(qNo / b) )
```

- **Instant Yes price. This is the implied probability and the odds shown above the head.**

```
priceYes = exp(qYes / b) / ( exp(qYes / b) + exp(qNo / b) )
priceNo  = 1 - priceYes
```

priceYes is always between 0 and 1. Show it as a percent and as cents where 1.00 token equals 100 cents. priceYes plus priceNo always equals 1.

- **Cost to buy shares.** To buy a quantity d of Yes shares, the spectator pays

```
cost = C(qYes + d, qNo) - C(qYes, qNo)
```

Buying Yes pushes priceYes up, so the next buyer pays more. Buying No pushes priceYes down. This is the live price movement. Deduct the cost from the spectator token balance and add the shares to their position.

- **Settlement.** When one contestant is left, settle every market. For the winning contestant, each Yes share redeems for 1 token and each No share redeems for 0. For every eliminated contestant, each No share redeems for 1 token and each Yes share redeems for 0. Credit redemptions to each spectator balance.

- **Why payout depends on price.** You pay the price at the moment you buy. Buy Yes cheap early and you profit big if they win. Buy Yes when the price is already high and your upside is small. Buy No on a favorite when everyone thinks they will win, which is cheap No, and you profit a lot if they get eliminated. This is the intended mechanic.

- **Tuning b.** Pick b so a typical five to ten token buy moves the price a few points. Too small and prices swing wildly on one bet. Too large and prices barely move. Tune it against the 50 token budget and the expected number of bettors.

- **Best portfolio.** At settlement, each spectator final token balance is starting tokens minus spend plus redemptions. Highest balance wins the portfolio prize.

Keep it play money. No buy-in. A fixed cash prize avoids looking like gambling.

### 10. Odds display, click-sprite panel, click-node panel

Make the market read like Polymarket.

- **Over the head.** A small pill with the name and the live Yes percent, colored by trend.
- **Contestant panel.** Opens on tapping a sprite. Show a compact set of things and nothing more. The name and class. The kill count. The six stats in a compact bar row. The Polymarket-style odds block. A link to past conversations via swipe. The odds block has the big Yes percent, the Yes and No price in cents which sum to 100, a green Buy Yes and a red Buy No, the spectator current position and potential payout, and a small price history sparkline.
- **Buying.** Tapping Buy Yes or Buy No sends the trade over the socket. Update the balance and the price optimistically on the client, then reconcile when the server confirms. The user never waits on a round trip.
- **Conversation panel.** Opens on tapping an interaction node. Show participant chips and the transcript, live-updating as lines stream in. Tone can drive small color accents. This is separate from the contestant panel.
- **Market list.** A full list view of all contestants as Polymarket-style rows. Name, Yes percent, price bar, and the spectator position. Sortable by probability. On mobile this is the primary way to bet, with the island as the ambient view.

### 11. Events (the 2 or 3, kept simple)

Three scheduled events. Fire them at time or population thresholds. Each one changes agent incentives for the next few think ticks by injecting a line into their context, or eliminates directly. Frame each as reality-TV.

1. **Elimination ceremony.** The contestants lowest in public favor, or the loser of an agent vote, get eliminated. Drives alliance and social play.
2. **The cull.** A timed sudden-death window. Anyone who does not secure a kill or an alliance in the window is at risk of random elimination. Spikes fighting.
3. **The twist.** An immunity drop appears. Agents scramble for it. Whoever gets it is safe from the next event. Creates a race.

Show an event banner or modal when one fires. Keep the logic simple. This is not the hard part.

### 12. Settlement and results

- Detect endgame when one contestant is alive.
- Settle every market per section 9.
- Compute the two winners. The surviving contestant. The spectator with the highest final balance.
- Show a results screen with both winners, the final leaderboard of portfolios, and a short recap.

### 13. Realtime sync and the architecture view

- The sim server is the single source of truth. Clients render what it broadcasts and send only bets and joins.
- Colocate the sim server and the swarm scheduler in the same region as the model endpoint. You make many calls and cross-region hops add up.
- Build a separate architecture view for the demo using React Flow. Nodes for the agents, the scheduler, and the model. Edges light up as agents talk and as decisions flow. This is what goes on the TV to show the swarm is real.

---

## Build phases (the task graph)

Each phase ends in a screenshot and a sign-off gate. Tier tags map to the model table.

### Phase 0. Planning and design
- Read this doc. Ask the Open Questions. [Tier A]
- Produce the architecture doc, the data models, and the task graph. [Tier A]
- Gate. The team approves the plan.

### Phase 1. Skeleton and island
- Next.js app, repo structure, shared types package. [Tier D]
- Phaser top-down island scene with a tileset. [Tier C]
- Static sprites placed with name and dummy odds tags above heads. [Tier C]
- Camera pan and pinch-zoom. Responsive shell for mobile. [Tier C]
- Gate. Screenshot the island at desktop and mobile widths.

### Phase 2. Onboarding and character creation
- QR join flow and onboarding screen for name and email. [Tier C]
- Creation screen. Class cards, bounded stat sliders, personality blurb, live preview. [Tier C]
- Write a contestant into state so its sprite appears on the island. [Tier C]
- Gate. Screenshot onboarding, creation, and the new sprite on the island.

### Phase 3. Sim server and movement
- Node sim server and Socket.IO wiring. [Tier B]
- Authoritative fast tick and wander movement. [Tier B]
- State diffs on the socket and client interpolation. [Tier B]
- Gate. Screen recording or screenshots of many sprites moving smoothly on two devices.

### Phase 4. Agent swarm and conversations
- Think-tick scheduler with staggered parallel calls and a concurrency cap. [Tier B]
- Per-agent decision calls with the decision schema. [Tier A for the prompt design, Tier B for the plumbing]
- Proximity-triggered conversations with the message schema and outcomes. [Tier A for prompts, Tier B for plumbing]
- Alliance and notoriety state. [Tier B]
- Conversation storage. Interaction nodes rendered on the island. Tap-node conversation panel. [Tier C]
- Gate. Screenshot two contestants with a live node and an open conversation panel.

### Phase 5. Combat and death
- Fight triggers from conversation outcomes and attack intents. [Tier B]
- HP damage exchanges, regen, and death by stats plus randomness. [Tier A for balancing, Tier B for code]
- Death animation, kill counts, notoriety updates. [Tier C]
- Gate. Screenshot a fight and a death, and a contestant panel showing an updated kill count.

### Phase 6. Prediction market
- LMSR per-contestant markets on the server. Cost, price, buy, and settlement functions. [Tier B, with Tier A checking the math]
- Live Yes price driving the over-head odds tags. [Tier C]
- Contestant panel with the Polymarket-style odds block and Buy Yes and Buy No. [Tier C]
- Token balances and optimistic updates. Market list view. Price history sparkline. [Tier C]
- Gate. Screenshot the odds block, a placed bet moving the price, and the market list.

### Phase 7. Events
- The three events as triggers that alter incentives or eliminate. [Tier B]
- Event banner or modal. [Tier C]
- Gate. Screenshot each event firing and its effect.

### Phase 8. Settlement, results, and the demo view
- Endgame detection, market settlement, payouts, two-winner results screen. [Tier B]
- The React Flow architecture and swarm view for the demo. [Tier C]
- Mobile polish. QR flyer asset for marketing. [Tier C and Tier D]
- Gate. Screenshot the results screen and the architecture view on a large display.

---

## Cost control

The swarm is the only expensive part. Keep it cheap.

- Put every runtime agent call on the cheapest fast model. The build uses stronger models, the running game does not.
- Keep each agent context under a few hundred tokens. Persona, own state, a few nearby contestants, the last few memory items. Cache the static persona.
- Cap agent memory to the last handful of events. Summarize older history into one line if you need longer memory. Do not let context grow every tick.
- Think ticks every 15 to 30 seconds, not sub-second. Cap total rounds if needed.
- Gate conversations so only a fraction of eligible pairs talk each tick. Cap each conversation at two to four messages.
- If budget allows, reserve a stronger model only for the highest-stakes moments, a kill decision or a betrayal, and keep everything else on the cheap model.
