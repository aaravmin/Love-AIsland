import { existsSync, readFileSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

// A simple append-only contacts database: one JSON line ({ name, phone, t })
// per unique phone number, so every person who signs up is saved for later.
// Path from CONTACTS_FILE (default ./contacts.jsonl, i.e. the server cwd, which
// survives redeploys since it isn't part of the source tree). Deduped by phone
// and loaded once at boot so restarts never re-append. Read it back with
// readContacts() (exposed via the operator-gated /contacts endpoint in index.ts).

const FILE = process.env.CONTACTS_FILE ?? "contacts.jsonl";
const seen = new Set<string>();
let loaded = false;
// Keep writes ordered without blocking Socket.IO's event loop. Sign-in acks no
// longer wait on disk I/O, so a burst of people joining cannot serialize every
// client behind appendFileSync.
let writeQueue: Promise<void> = Promise.resolve();

function normalize(phone: string): string {
  return phone.replace(/\D/g, "");
}

export function initContacts(): void {
  if (loaded) return;
  loaded = true;
  try {
    if (!existsSync(FILE)) return;
    for (const line of readFileSync(FILE, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line) as { phone?: string };
        if (o.phone) seen.add(normalize(o.phone));
      } catch {
        // skip a corrupt line
      }
    }
  } catch {
    // unreadable file: start fresh, recordContact will (re)create it
  }
}

export function recordContact(name: string, phone: string): void {
  initContacts();
  const key = normalize(phone);
  if (!key || seen.has(key)) return;
  seen.add(key);
  const line = JSON.stringify({ name, phone, t: Date.now() }) + "\n";
  writeQueue = writeQueue.then(async () => {
    try {
      const dir = dirname(FILE);
      if (dir && dir !== ".") await mkdir(dir, { recursive: true });
      await appendFile(FILE, line);
    } catch {
      // Best-effort: a write failure must never break signup or the queue.
    }
  });
}

export function readContacts(): string {
  try {
    return existsSync(FILE) ? readFileSync(FILE, "utf8") : "";
  } catch {
    return "";
  }
}
