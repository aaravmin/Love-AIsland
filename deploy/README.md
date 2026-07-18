# Deploying the sim server (task 3.5)

The web app is on Vercel (`practice-arena-web.vercel.app`); the sim server runs on a DigitalOcean droplet, behind Caddy for TLS, under pm2 for auto-restart.
The browser talks to the droplet over `wss://`.

## What is actually deployed (as of Phase 3)

- **Droplet**: DigitalOcean, Ubuntu 24.04, public IP `67.207.82.96` (a small 512 MB box, so a 2 GB swapfile is configured).
- **Public socket endpoint**: `wss://67-207-82-96.sslip.io` (sslip.io wildcard DNS + Let's Encrypt via Caddy; no domain was purchased - see the Caddyfile for the swap-in path once a real domain exists).
- **Deploy layout**: `/opt/love-aisland` holds a trimmed workspace - only `apps/server` + `packages/shared` + `assets/island-map.json`, not the full monorepo, so Next/Phaser never install on the server box.
- **Process**: pm2 app `arena-server`, running `node --import tsx src/index.ts` directly (not through a `pnpm` wrapper - the wrapper leaves the real server as a grandchild that pm2 can't restart cleanly, causing an `EADDRINUSE` crash-loop). pm2 boot-persistence is enabled via `pm2 startup` (`systemctl is-enabled pm2-root`).
- **Secrets**: `/etc/arena.env` (chmod 600), sourced into the shell before `pm2 start`; `pm2 save` bakes the env into the resurrect dump so a reboot restores it.

### `/etc/arena.env`

```
NODE_ENV=production
PORT=4000
CORS_ORIGINS=https://practice-arena-web.vercel.app
OPERATOR_KEY=<generated with: openssl rand -hex 24>
ISLAND_MAP_PATH=/opt/love-aisland/assets/island-map.json
ANTHROPIC_API_KEY=<sk-ant-... the swarm's Haiku key; server-only, never in the client>
SWARM_BACKEND=anthropic
# DEV_SEED=12   # uncomment for a populated rehearsal lobby; leave unset for the real event

# Behavior. ISLAND_BEHAVIOR_ALL already defaults to 1 in code; it is written
# here so the deployed configuration is legible on the box, and so a rollback to
# the pre-spec game is a one-line env edit rather than a deploy.
ISLAND_BEHAVIOR_ALL=1
# ISLAND_BEHAVIOR_ALL=0   # the exact pre-spec build, all behavior off
# Every individual ISLAND_* flag overrides the master switch in both
# directions, so a single feature can be disabled in production without
# touching the rest. See .env.example at the repo root for the full list with
# defaults, and for the flag dependencies (several flags are no-ops on their
# own, e.g. ISLAND_GOSSIP does nothing without ISLAND_OVERHEARING).
# ISLAND_OVERHEARING=0
# ISLAND_FOLLOW_CAMERA=0
# ISLAND_RICH_NOTIFICATIONS=0
# ISLAND_RUN_SEED=0       # 0 picks a seed at start and reports it in the boot log

# SMS. All three must be set or every send falls to a [sms:noop] console line.
# These are NOT currently provisioned, so alerting on the droplet is log-only.
# TWILIO_ACCOUNT_SID=
# TWILIO_AUTH_TOKEN=
# TWILIO_FROM=
```

The trimmed droplet workspace now includes `packages/swarm` (Phase 4).
After editing `/etc/arena.env`, the pm2 process must be recreated (`pm2 delete` + `pm2 start` with the env sourced) so a newly-added variable like `ANTHROPIC_API_KEY` or `ISLAND_BEHAVIOR_ALL` enters the process env.
`pm2 restart --update-env` merges the current shell env but does not pick up a var that wasn't present when the process was first started under that shell.
This applies to every variable added above, so flipping a behavior flag is a recreate, not a restart.
`ANTHROPIC_API_KEY` on its own does nothing: the backend factory only reads it when `SWARM_BACKEND=anthropic`, which is why that line is now set explicitly alongside it.
The swarm's $10 spend cap is a per-game backstop; also set an org-level budget cap in the Anthropic Console.

### Vercel

`NEXT_PUBLIC_SOCKET_URL=wss://67-207-82-96.sslip.io` is set for Production, Preview, and Development.
It is a build-time inlined variable, so **changing it requires a redeploy** (`vercel --prod` from `apps/web`), not just an env edit.

## First-time droplet setup (reference)

```bash
# Node 22 + pnpm + pm2
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs
npm install -g pnpm@11.7.0 pm2

# Caddy
apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
apt-get update && apt-get install -y caddy

# Swap (small box)
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

## Pushing code to the droplet

The Phase 3 work is not on the GitHub remote (only the old prototype commit is), so code is copied straight from a working tree with rsync - no commit/push needed:

```bash
rsync -az --exclude node_modules --exclude .next --exclude dist --exclude .git \
  packages/shared/ root@67.207.82.96:/opt/love-aisland/packages/shared/
rsync -az --exclude node_modules --exclude .next --exclude dist --exclude .git \
  apps/server/ root@67.207.82.96:/opt/love-aisland/apps/server/
rsync -az tsconfig.base.json root@67.207.82.96:/opt/love-aisland/tsconfig.base.json
rsync -az apps/web/public/assets/island-map.json \
  root@67.207.82.96:/opt/love-aisland/assets/island-map.json
```

The trimmed workspace root on the droplet is a hand-written `/opt/love-aisland/package.json` + `pnpm-workspace.yaml` listing only `apps/server` and `packages/shared` (with `allowBuilds: { esbuild: true }` so tsx's esbuild binary builds).
After an rsync, run `cd /opt/love-aisland && pnpm install && pm2 restart arena-server`.

## Caddy

Copy `deploy/Caddyfile` to `/etc/caddy/Caddyfile`, then `systemctl reload caddy`.

## Verify

- `curl https://67-207-82-96.sslip.io/healthz` returns `ok`.
- On the Vercel site, the `/admin` console shows **Server: Live**; Start/Reset work with the operator key.
- Creating an islander on the deployed site makes a sprite appear with a seeded market (proves the cross-origin socket both ways).
