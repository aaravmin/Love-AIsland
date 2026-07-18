const CLIENT_ID_KEY = "arena.clientId";

// Stable per-browser identity, generated once and cached in localStorage.
// The future socket layer sends this same value as `clientId` in every
// `hello` (see docs/ARCHITECTURE.md section 5.1) so a reload/reconnect maps
// back to the same Spectator on the server.
export function getClientId(): string {
  if (typeof window === "undefined") return "";
  let id = window.localStorage.getItem(CLIENT_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    window.localStorage.setItem(CLIENT_ID_KEY, id);
  }
  return id;
}
