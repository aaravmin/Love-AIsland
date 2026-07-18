# Love AIsland - Operator Runbook

How to run a live game.
Everything an operator does goes through the admin console; nothing here needs a shell.

## Surfaces

- Spectate / play: `https://web.example.com/`
- Swarm architecture (for a second display): `/demo`
- Printable QR flyer: `/flyer`
- Operator console: `/admin`
- Sim server health: `https://server.example.com/healthz`

## Operator console (`/admin`)

Enter the operator key once (prefilled to `dev-operator` on localhost; on production paste the real `OPERATOR_KEY`).
The key is checked server-side on every command.

- **Start** - lobby -> running. Available in the lobby (or the game auto-starts ~90 s after 10 islanders join).
- **Reset** - wipe back to a fresh lobby. Clears contestants, markets, bets, feed, results, and the swarm budget. Every viewer re-syncs automatically.
- **Force interaction** - starts a conversation between the two nearest available islanders (running only).
- **Force next event** - fires the next scheduled event (Purge, then Weakest Link) immediately, skipping its 60 s countdown (running only).
- **Force fallback** - forces the LLM swarm onto the rule engine, exactly as the $10 spend cap would. Proves graceful degradation; the `/demo` view flips to CAPPED (running only).
- **Sudden death** - turns on hostile mode now (regen decays to 0, alliances dissolve, everyone hunts). Guarantees the game converges to one winner (running only).

## Running a show

1. Open `/admin`, confirm **Server: Live**, and **Reset** to a clean lobby.
2. Put `/flyer` (or the QR) on screen. Players scan, create one islander each (one per person).
   - The game auto-starts at 10 islanders after ~90 s, or hit **Start** manually.
3. Optionally put `/demo` on a second display to show the live LLM swarm + spend meter.
4. Let it run (~15-20 min): combat thins the field, the Purge and Weakest Link cull on the timeline, then hostile mode forces a single winner.
   - To speed a demo up: **Force next event**, then **Sudden death**.
5. At the last islander standing the results screen appears (winner + owner, top betting portfolio, leaderboard, recap). Betting is frozen.
6. **Reset** for the next game.

## Dress rehearsal checklist (task 8.6)

- [ ] Game 1 - full run to a natural or forced winner; confirm the results screen and that a winning bet redeemed.
- [ ] Game 2 - hit **Force fallback** mid-run; confirm `/demo` shows CAPPED and agents keep deciding (rule engine). This proves the spend-cap path with no real spend.
- [ ] **Reset** between games and confirm every viewer returns to a clean lobby.

## If something looks wrong

- Server shows **Down**: check `https://server.example.com/healthz` returns 200; the server auto-restarts under pm2.
- Viewers stuck: a **Reset** forces every client to re-sync from a fresh snapshot.
- Spend near the cap: the swarm falls back to the rule engine on its own at $10; the game keeps running, just without live LLM reasoning.
