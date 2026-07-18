import { createServer } from "node:http";
import { Server } from "socket.io";
import type { ClientToServerEvents, ServerToClientEvents } from "@arena/shared";
import { operatorKey } from "./admin.js";
import { initContacts, readContacts } from "./contacts.js";
import { seedDevContestants } from "./devSeed.js";
import { registerHandlers } from "./protocol.js";
import { initRooms } from "./rooms.js";
import { startSwarmLoop } from "./swarmBridge.js";
import { startTickLoop } from "./tick.js";

// Boot: http + Socket.IO + tick loop. The swarm wires in here in Phase 4.

const PORT = Number(process.env.PORT ?? 4000);

// CORS allowlist (ARCHITECTURE.md 8): Vercel prod + preview domains in
// deployment, localhost in dev. Comma-separated env override.
const configuredCorsOrigins = process.env.CORS_ORIGINS;
const corsOrigins = (configuredCorsOrigins ?? "http://localhost:3000")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

// A QR opened by a phone reaches the dev machine over its private LAN IP,
// not localhost. Permit ordinary private-network Next dev origins when no
// explicit allowlist was supplied; production remains strictly configured by
// CORS_ORIGINS.
const devLanOrigin = /^http:\/\/(?:localhost|127\.0\.0\.1|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}):3000$/;
const allowedOrigins =
  !configuredCorsOrigins && process.env.NODE_ENV !== "production"
    ? [...corsOrigins, devLanOrigin]
    : corsOrigins;

operatorKey(); // fail fast in production if OPERATOR_KEY is missing

const httpServer = createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }
  // Operator-gated dump of the saved name+phone contacts (?key=OPERATOR_KEY).
  if (req.url && req.url.startsWith("/contacts")) {
    const key = new URL(req.url, "http://x").searchParams.get("key");
    if (key !== operatorKey()) {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("forbidden");
      return;
    }
    res.writeHead(200, { "content-type": "application/x-ndjson" });
    res.end(readContacts());
    return;
  }
  res.writeHead(404);
  res.end();
});

const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
  cors: { origin: allowedOrigins },
});

initContacts(); // load saved phones so restarts don't re-append
initRooms(io); // create the always-present MAIN room before anything touches state
registerHandlers(io);
seedDevContestants(io); // seeds the MAIN room (only when DEV_SEED is set)
startTickLoop(io);
startSwarmLoop(io);

httpServer.listen(PORT, () => {
  console.log(`[server] listening on :${PORT} (cors: ${allowedOrigins.join(", ")})`);
});
