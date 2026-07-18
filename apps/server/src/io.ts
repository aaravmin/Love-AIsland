import type { Server, Socket } from "socket.io";
import type { ClientToServerEvents, ServerToClientEvents } from "@arena/shared";

export type ArenaServer = Server<ClientToServerEvents, ServerToClientEvents>;
export type ArenaSocket = Socket<ClientToServerEvents, ServerToClientEvents>;
