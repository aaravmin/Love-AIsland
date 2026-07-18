"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import type { RoomInfo } from "@arena/shared";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { setAdminKey, useAdminKey } from "@/lib/adminSession";
import { useGameStore } from "@/lib/gameStore";
import { adminCmd, listRooms } from "@/lib/socket";
import { cn } from "@/lib/utils";

// Ordering for the island list: MAIN pinned first, then in-progress games
// (the ones an operator most often needs to reach), then lobbies, then
// finished games; ties broken by name.
const PHASE_RANK: Record<RoomInfo["phase"], number> = { running: 0, lobby: 1, settled: 2 };
function compareRooms(a: RoomInfo, b: RoomInfo): number {
  if (a.isMain !== b.isMain) return a.isMain ? -1 : 1;
  if (a.phase !== b.phase) return PHASE_RANK[a.phase] - PHASE_RANK[b.phase];
  return a.name.localeCompare(b.name);
}

const PHASE_BADGE: Record<RoomInfo["phase"], string> = {
  running: "bg-emerald-500/15 text-emerald-400",
  lobby: "bg-chart-4/15 text-chart-4",
  settled: "bg-muted text-muted-foreground",
};

// Operator console (task 3.6): start/reset/force behind the operator key. The
// key is checked server-side on every command; storing it locally is a
// convenience for the person running the show, not an auth mechanism. Every
// command targets the currently-selected island (Phase 9 multi-room), so the
// operator can reach and edit any game -- lobby or in-progress -- not just MAIN.
export default function AdminPage() {
  const connected = useGameStore((s) => s.connected);

  const key = useAdminKey();
  const [keyDraft, setKeyDraft] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [seedN, setSeedN] = useState(12);
  const [countdownSec, setCountdownSec] = useState(60);
  const [eventKind, setEventKind] = useState<"purge" | "weakestLink">("purge");
  const [eventSec, setEventSec] = useState(30);
  const [lengthMin, setLengthMin] = useState(15);

  const [rooms, setRooms] = useState<RoomInfo[]>([]);
  const [selectedCode, setSelectedCode] = useState("MAIN");
  const keyInput = keyDraft ?? key;

  const refreshRooms = useCallback(async () => {
    const result = await listRooms(key);
    setIsAdmin(result.isAdmin);
    setRooms(result.rooms.slice().sort(compareRooms));
  }, [key]);

  async function signIn() {
    setBusy(true);
    try {
      const result = await listRooms(keyInput);
      if (!result.isAdmin) {
        setIsAdmin(false);
        toast.error("That operator key is not valid.");
        return;
      }
      setAdminKey(keyInput);
      setKeyDraft(null);
      setIsAdmin(true);
      setRooms(result.rooms.slice().sort(compareRooms));
      toast.success("Signed in as admin. All games are now available from the island menu.");
    } finally {
      setBusy(false);
    }
  }

  // Poll the island list so counts, phases, and newly-created games stay live
  // without a manual refresh. Also refreshed immediately after each command.
  useEffect(() => {
    if (!connected) return;
    // refreshRooms only setStates after an awaited network round-trip, so this
    // is a deferred data fetch, not the synchronous cascading render this rule
    // guards against.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshRooms();
    const t = window.setInterval(() => void refreshRooms(), 4000);
    return () => window.clearInterval(t);
  }, [connected, refreshRooms]);

  // If the selected island isn't in the current list (e.g. a finished friend
  // room was disposed server-side), fall back to MAIN for both display and
  // command targeting -- derived during render, so no state to resync.
  const selected =
    rooms.find((r) => r.code === selectedCode) ?? rooms.find((r) => r.code === "MAIN");
  const effectiveCode = selected?.code ?? selectedCode;

  const phase = selected?.phase ?? "lobby";
  const islanders = selected?.islanders ?? 0;
  const autoStartAt = selected?.autoStartAt ?? null;
  const running = phase === "running";
  const inLobby = phase === "lobby";

  const SUCCESS: Record<string, string> = {
    start: "Game started.",
    reset: "Game reset to a fresh lobby.",
    forceEvent: "Fired the next event.",
    forceEndgame: "Sudden death is on.",
    forceConversation: "Forced an interaction.",
    forceFallback: "Swarm forced to rule-engine fallback.",
    seed: "Islanders seeded.",
    countdown: "Countdown armed.",
    armEvent: "Event armed.",
    setLength: "Game length set.",
    forceVote: "Forced a vote off.",
  };

  async function run(
    cmd:
      | "start"
      | "reset"
      | "forceEvent"
      | "forceEndgame"
      | "forceConversation"
      | "forceFallback"
      | "seed"
      | "countdown"
      | "armEvent"
      | "setLength"
      | "forceVote",
    extra?: {
      count?: number;
      seconds?: number;
      minutes?: number;
      eventKind?: "purge" | "weakestLink";
    },
  ) {
    setBusy(true);
    try {
      const ack = await adminCmd(key, cmd, { room: effectiveCode, ...extra });
      if (ack.ok) {
        toast.success(SUCCESS[cmd] ?? "Done.");
      } else {
        toast.error("Command refused. Check the key, game phase, and islander count.");
      }
      await refreshRooms();
    } catch {
      toast.error("The island server did not respond.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex flex-1 items-center justify-center p-4">
      <Card className="w-full max-w-sm border border-border bg-card">
        <CardHeader>
          <CardTitle className="text-xl text-foreground">Operator console</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <dl className="grid grid-cols-3 gap-2 text-center">
            <div className="rounded-lg bg-muted px-2 py-2">
              <dt className="text-[11px] text-muted-foreground uppercase">Server</dt>
              <dd
                className={
                  connected
                    ? "text-sm font-bold text-emerald-400"
                    : "text-sm font-bold text-rose-500"
                }
              >
                {connected ? "Live" : "Down"}
              </dd>
            </div>
            <div className="rounded-lg bg-muted px-2 py-2">
              <dt className="text-[11px] text-muted-foreground uppercase">Phase</dt>
              <dd className="text-sm font-bold text-foreground capitalize">{phase}</dd>
            </div>
            <div className="rounded-lg bg-muted px-2 py-2">
              <dt className="text-[11px] text-muted-foreground uppercase">Islanders</dt>
              <dd className="text-sm font-bold text-foreground tabular-nums">{islanders}</dd>
            </div>
          </dl>

          {/* Island picker (Phase 9): every command below targets whichever
              island is selected here -- lobby or in-progress. */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold text-muted-foreground uppercase">
                Islands
              </span>
              <span className="text-[11px] text-muted-foreground tabular-nums">
                {rooms.length} live
              </span>
            </div>
            <div className="flex max-h-56 flex-col gap-1.5 overflow-y-auto">
              {rooms.length === 0 ? (
                <p className="py-2 text-center text-xs text-muted-foreground">
                  {connected ? "No islands yet." : "Connecting to the island server..."}
                </p>
              ) : (
                rooms.map((r) => {
                  const isSel = r.code === effectiveCode;
                  return (
                    <button
                      key={r.code}
                      type="button"
                      onClick={() => setSelectedCode(r.code)}
                      className={`flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left transition-colors ${
                        isSel
                          ? "border-primary bg-primary/10"
                          : "border-border bg-muted/40 hover:bg-muted"
                      }`}
                    >
                      <span className="flex min-w-0 flex-col">
                        <span className="flex items-center gap-1.5">
                          <span className="font-mono text-sm font-bold text-foreground">
                            {r.code}
                          </span>
                          {r.isMain ? (
                            <span className="rounded bg-chart-4/15 px-1 text-[10px] font-bold text-chart-4 uppercase">
                              Main
                            </span>
                          ) : null}
                        </span>
                        <span className="truncate text-[11px] text-muted-foreground">{r.name}</span>
                      </span>
                      <span className="flex shrink-0 flex-col items-end gap-1">
                        <span
                          className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${PHASE_BADGE[r.phase]}`}
                        >
                          {r.phase}
                        </span>
                        <span className="text-[10px] text-muted-foreground tabular-nums">
                          {r.islanders}p · {r.spectators}w
                        </span>
                      </span>
                    </button>
                  );
                })
              )}
            </div>
          </div>

          {autoStartAt !== null && inLobby ? (
            <p className="text-center text-xs font-medium text-chart-4">
              Auto-start armed for {new Date(autoStartAt).toLocaleTimeString()}.
            </p>
          ) : null}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="operator-key" className="text-muted-foreground">
              Operator key
            </Label>
            <Input
              id="operator-key"
              type="password"
              placeholder="operator key"
              value={keyInput}
              onChange={(e) => {
                setKeyDraft(e.target.value);
                setIsAdmin(false);
              }}
            />
            <div className="flex gap-2">
              <Button
                className="flex-1 font-bold"
                disabled={busy || !keyInput}
                onClick={() => void signIn()}
              >
                {isAdmin ? "Admin signed in" : "Sign in"}
              </Button>
              <Link
                href="/"
                className={cn(buttonVariants({ variant: "outline" }), "flex-1 font-bold")}
              >
                Back to island
              </Link>
            </div>
          </div>

          <div className="flex gap-3">
            <Button
              className="flex-1 font-bold"
              disabled={busy || !isAdmin || !inLobby}
              onClick={() => run("start")}
            >
              Start
            </Button>
            <Button
              variant="outline"
              className="flex-1 border-border font-bold text-foreground"
              disabled={busy || !isAdmin}
              onClick={() => run("reset")}
            >
              Reset
            </Button>
          </div>

          {/* Lobby tools: seed house islanders, arm an on-island countdown, set
              the game length. All target the selected island. */}
          <div className="flex flex-col gap-2 border-t border-border pt-3">
            <span className="text-[11px] font-semibold text-muted-foreground uppercase">Lobby</span>
            <div className="flex items-end gap-2">
              <div className="flex flex-1 flex-col gap-1">
                <Label htmlFor="seed-n" className="text-xs text-muted-foreground">Islanders</Label>
                <Input
                  id="seed-n"
                  type="number"
                  min={1}
                  max={50}
                  value={seedN}
                  onChange={(e) => setSeedN(Math.max(1, Math.min(50, Number(e.target.value) || 1)))}
                />
              </div>
              <Button
                className="font-bold"
                disabled={busy || !isAdmin || (!inLobby && !running)}
                onClick={() => run("seed", { count: seedN })}
              >
                Seed players
              </Button>
            </div>
            <div className="flex items-end gap-2">
              <div className="flex flex-1 flex-col gap-1">
                <Label htmlFor="cd-sec" className="text-xs text-muted-foreground">Countdown (sec)</Label>
                <Input
                  id="cd-sec"
                  type="number"
                  min={5}
                  max={600}
                  value={countdownSec}
                  onChange={(e) => setCountdownSec(Math.max(5, Math.min(600, Number(e.target.value) || 5)))}
                />
              </div>
              <Button
                variant="outline"
                className="border-border font-bold text-foreground"
                disabled={busy || !isAdmin || !inLobby || islanders === 0}
                onClick={() => run("countdown", { seconds: countdownSec })}
              >
                Start countdown
              </Button>
            </div>
            <div className="flex items-end gap-2">
              <div className="flex flex-1 flex-col gap-1">
                <Label htmlFor="length-min" className="text-xs text-muted-foreground">Game length (min)</Label>
                <Input
                  id="length-min"
                  type="number"
                  min={5}
                  max={30}
                  value={lengthMin}
                  onChange={(e) => setLengthMin(Math.max(5, Math.min(30, Number(e.target.value) || 5)))}
                  disabled={!inLobby}
                />
              </div>
              <Button
                variant="outline"
                className="border-border font-bold text-foreground"
                disabled={busy || !isAdmin || !inLobby}
                onClick={() => run("setLength", { minutes: lengthMin })}
              >
                Set length
              </Button>
            </div>
          </div>

          {/* Force powers (Phase 7): only meaningful while a game is running. */}
          <div className="flex flex-col gap-2 border-t border-border pt-3">
            <span className="text-[11px] font-semibold text-muted-foreground uppercase">
              Force
            </span>
            <div className="grid grid-cols-2 gap-2">
              <Button
                variant="outline"
                className="border-border font-bold text-foreground"
                disabled={busy || !isAdmin || !running}
                onClick={() => run("forceConversation")}
              >
                Interaction
              </Button>
              <Button
                variant="outline"
                className="border-border font-bold text-foreground"
                disabled={busy || !isAdmin || !running}
                onClick={() => run("forceEvent")}
              >
                Next event (Purge)
              </Button>
              <Button
                variant="outline"
                className="border-border font-bold text-foreground"
                disabled={busy || !isAdmin || !running}
                onClick={() => run("forceVote")}
              >
                Force vote
              </Button>
              <Button
                variant="outline"
                className="border-border font-bold text-foreground"
                disabled={busy || !isAdmin || !running}
                onClick={() => run("forceFallback")}
              >
                Force fallback
              </Button>
              <Button
                variant="outline"
                className="border-destructive/50 font-bold text-destructive"
                disabled={busy || !isAdmin || !running}
                onClick={() => run("forceEndgame")}
              >
                Sudden death
              </Button>
            </div>
          </div>

          {/* Arm a scheduled event on the island's own timer, rather than
              firing it immediately (that's what "Next event" above does). */}
          <div className="flex flex-col gap-2 border-t border-border pt-3">
            <span className="text-[11px] font-semibold text-muted-foreground uppercase">
              Arm event
            </span>
            <div className="flex items-end gap-2">
              <div className="flex flex-1 flex-col gap-1">
                <Label htmlFor="event-kind" className="text-xs text-muted-foreground">Event</Label>
                <select
                  id="event-kind"
                  value={eventKind}
                  onChange={(e) => setEventKind(e.target.value as "purge" | "weakestLink")}
                  className="h-9 rounded-md border border-input bg-transparent px-3 text-sm text-foreground"
                >
                  <option value="purge">The Purge</option>
                  <option value="weakestLink">The Weakest Link</option>
                </select>
              </div>
              <div className="flex w-24 flex-col gap-1">
                <Label htmlFor="event-sec" className="text-xs text-muted-foreground">Seconds</Label>
                <Input
                  id="event-sec"
                  type="number"
                  min={5}
                  max={600}
                  value={eventSec}
                  onChange={(e) => setEventSec(Math.max(5, Math.min(600, Number(e.target.value) || 5)))}
                />
              </div>
            </div>
            <Button
              variant="outline"
              className="border-border font-bold text-foreground"
              disabled={busy || !isAdmin || !running}
              onClick={() => run("armEvent", { eventKind, seconds: eventSec })}
            >
              Arm event
            </Button>
          </div>
        </CardContent>
      </Card>
    </main>
  );
}
