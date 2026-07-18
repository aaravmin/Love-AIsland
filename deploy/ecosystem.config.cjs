// pm2 process file for the sim server on the droplet.
//
// The live deploy was started with the equivalent `pm2 start` CLI form:
//   pm2 start node --name arena-server --cwd /opt/love-aisland/apps/server \
//     -- --import tsx src/index.ts
// Run node directly, NOT through `pnpm --filter ... start`: the pnpm wrapper
// leaves the real server as a grandchild pm2 can't kill on restart, so the
// old process keeps port 4000 and the new one crash-loops on EADDRINUSE.
//
// Secrets (OPERATOR_KEY) live in /etc/arena.env, sourced before `pm2 start`
// (`set -a; . /etc/arena.env; set +a`); they are never committed here.
module.exports = {
  apps: [
    {
      name: "arena-server",
      cwd: "/opt/love-aisland/apps/server",
      script: "node",
      args: "--import tsx src/index.ts",
      env: {
        NODE_ENV: "production",
        PORT: "4000",
        // The master behavior switch. It already defaults to on in
        // packages/shared/src/tunables.ts, so this is redundant by design: it
        // is here so an operator reading the process file can see which build
        // is deployed without going and reading the default. Set it to "0" to
        // roll the droplet back to the pre-spec game without a code change.
        ISLAND_BEHAVIOR_ALL: "1",
      },
    },
  ],
};
