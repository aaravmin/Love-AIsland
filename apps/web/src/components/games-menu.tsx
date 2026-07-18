"use client";

import { useEffect, useState } from "react";
import { Check, ChevronDown, Copy, Plus, QrCode, Ticket } from "lucide-react";
import QRCode from "qrcode";
import { toast } from "sonner";
import type { RoomConfig, RoomInfo } from "@arena/shared";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { useGameStore } from "@/lib/gameStore";
import { createRoom, joinRoom, listRooms, startRoom } from "@/lib/socket";
import { cn } from "@/lib/utils";

// Top-right "Games" control (Kahoot-style): shows the room you're in and lets
// you create a game (settings + join code + host lobby) or join a friend's game
// by code. Backed by the real multi-room server (Phase 9).

function slug(n: number, one: string, many = one + "s") {
  return `${n} ${n === 1 ? one : many}`;
}

export function GamesMenu() {
  const room = useGameStore((s) => s.room);

  const [menuOpen, setMenuOpen] = useState(false);
  const [rooms, setRooms] = useState<RoomInfo[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [joinOpen, setJoinOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const [name, setName] = useState("");
  const [cfg, setCfg] = useState<RoomConfig>({ agentsPerPerson: 2, lengthMinutes: 15, eventCount: 2 });
  const [createdCode, setCreatedCode] = useState<string | null>(null);
  const [hostCode, setHostCode] = useState<string | null>(null);
  const [joinCode, setJoinCode] = useState("");

  const isMain = room?.isMain ?? true;

  async function openMenu() {
    setMenuOpen((o) => !o);
    if (!menuOpen) setRooms(await listRooms());
  }

  function openCreate() {
    setMenuOpen(false);
    setName("");
    setCfg({ agentsPerPerson: 2, lengthMinutes: 15, eventCount: 2 });
    setCreatedCode(null);
    setCreateOpen(true);
  }

  async function doCreate() {
    setBusy(true);
    try {
      const res = await createRoom(name, cfg);
      if (!res.ok || !res.code) {
        toast.error(res.error ?? "Couldn't create the game.");
        return;
      }
      setCreatedCode(res.code);
      setHostCode(res.code);
    } finally {
      setBusy(false);
    }
  }

  function copyCode() {
    if (!createdCode) return;
    void navigator.clipboard?.writeText(createdCode);
    toast.success("Code copied");
  }

  async function doStart() {
    setBusy(true);
    try {
      const ok = await startRoom();
      if (ok) {
        setCreateOpen(false);
        toast.success("Game started!");
      } else {
        toast.error("Only the host can start, once islanders have joined.");
      }
    } finally {
      setBusy(false);
    }
  }

  async function doJoin(code: string) {
    setBusy(true);
    try {
      const res = await joinRoom(code);
      if (!res.ok) {
        toast.error(res.error ?? "Couldn't join that game.");
        return;
      }
      setJoinOpen(false);
      setMenuOpen(false);
      setJoinCode("");
      toast.success(`Joined ${code.toUpperCase()}`);
    } finally {
      setBusy(false);
    }
  }

  const created = createdCode ? rooms.find((r) => r.code === createdCode) ?? { code: createdCode, config: cfg } : null;

  return (
    <>
      <div className="relative">
        <button
          onClick={openMenu}
          className="flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-xs font-bold text-foreground transition-colors hover:border-primary"
        >
          <Ticket className="size-3.5 text-primary" />
          <span className="max-w-28 truncate">{isMain ? "Main Island" : room?.name ?? "Game"}</span>
          {!isMain && room ? (
            <span className="rounded bg-primary/15 px-1 font-mono text-primary">{room.code}</span>
          ) : null}
          <ChevronDown className="size-3.5 text-muted-foreground" />
        </button>

        {menuOpen ? (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
            <div className="absolute right-0 z-50 mt-2 max-h-[70vh] w-64 overflow-y-auto rounded-xl border border-border bg-card p-1.5 shadow-xl">
              <p className="px-2 py-1 text-[11px] font-semibold text-muted-foreground uppercase">Games</p>
              {rooms.map((r) => (
                <button
                  key={r.code}
                  disabled={busy}
                  onClick={() => doJoin(r.code)}
                  className={cn(
                    "flex w-full items-center justify-between gap-2 rounded-lg px-2 py-2 text-left text-sm transition-colors hover:bg-muted",
                    r.code === room?.code ? "bg-muted" : "",
                  )}
                >
                  <span className="min-w-0">
                    <span className="block truncate font-semibold text-foreground">
                      {r.isMain ? "Main Island" : r.name}
                    </span>
                    <span className="text-[11px] text-muted-foreground">
                      {r.isMain ? "1 islander each · 20 min" : r.code} · {r.islanders} in · {r.phase}
                    </span>
                  </span>
                  {r.code === room?.code ? <Check className="size-4 shrink-0 text-primary" /> : null}
                </button>
              ))}
              <div className="my-1 h-px bg-border" />
              <button
                onClick={openCreate}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm font-semibold text-foreground transition-colors hover:bg-muted"
              >
                <Plus className="size-4 text-primary" /> Create a game
              </button>
              <button
                onClick={() => {
                  setMenuOpen(false);
                  setJoinCode("");
                  setJoinOpen(true);
                }}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm font-semibold text-foreground transition-colors hover:bg-muted"
              >
                <Ticket className="size-4 text-primary" /> Join with a code
              </button>
              {!isMain && room ? (
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    setShareOpen(true);
                  }}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm font-semibold text-foreground transition-colors hover:bg-muted"
                >
                  <QrCode className="size-4 text-primary" /> Show join QR
                </button>
              ) : null}
            </div>
          </>
        ) : null}
      </div>

      {/* Create game dialog: settings, then the host lobby with the code. */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="border-border bg-card sm:max-w-md">
          {!created ? (
            <>
              <DialogHeader>
                <DialogTitle className="text-foreground">Create a game</DialogTitle>
              </DialogHeader>
              <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="room-name" className="text-muted-foreground">Game name</Label>
                  <Input
                    id="room-name"
                    placeholder="Friday night island"
                    value={name}
                    maxLength={30}
                    onChange={(e) => setName(e.target.value)}
                  />
                </div>
                <Setting label="Islanders per person" value={cfg.agentsPerPerson} min={1} max={5}
                  onChange={(v) => setCfg((c) => ({ ...c, agentsPerPerson: v }))} render={(v) => slug(v, "islander")} />
                <Setting label="Game length" value={cfg.lengthMinutes} min={5} max={30} step={5}
                  onChange={(v) => setCfg((c) => ({ ...c, lengthMinutes: v }))} render={(v) => `${v} min`} />
                <Setting label="Random events" value={cfg.eventCount} min={0} max={4}
                  onChange={(v) => setCfg((c) => ({ ...c, eventCount: v }))} render={(v) => (v === 0 ? "none" : slug(v, "event"))} />
                <Button onClick={doCreate} disabled={busy} size="lg" className="font-heading font-semibold">
                  {busy ? "Creating..." : "Create game"}
                </Button>
              </div>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle className="text-foreground">Your game is ready</DialogTitle>
              </DialogHeader>
              <div className="flex flex-col items-center gap-4 py-2">
                <p className="text-sm text-muted-foreground">Friends join at this code:</p>
                <button onClick={copyCode} className="group flex items-center gap-3 rounded-xl border-2 border-primary bg-primary/10 px-6 py-3">
                  <span className="font-heading text-4xl font-extrabold tracking-[0.2em] text-foreground">{created.code}</span>
                  <Copy className="size-5 text-primary opacity-70 group-hover:opacity-100" />
                </button>
                <RoomJoinQr key={created.code} code={created.code} />
                <div className="flex flex-wrap justify-center gap-2 text-xs text-muted-foreground">
                  <span className="rounded-full bg-muted px-2 py-1">{slug(created.config.agentsPerPerson, "islander")} each</span>
                  <span className="rounded-full bg-muted px-2 py-1">{created.config.lengthMinutes} min</span>
                  <span className="rounded-full bg-muted px-2 py-1">
                    {created.config.eventCount === 0 ? "no events" : slug(created.config.eventCount, "event")}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  Share the code, drop your islanders, then start when everyone&rsquo;s in.
                </p>
                <Button onClick={doStart} disabled={busy} size="lg" className="w-full font-heading font-semibold">
                  {busy ? "Starting..." : "Start game"}
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Re-openable room QR for hosts or guests who want to invite others. */}
      <Dialog open={shareOpen} onOpenChange={setShareOpen}>
        <DialogContent className="border-border bg-card sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-foreground">Invite friends to {room?.name ?? "this game"}</DialogTitle>
          </DialogHeader>
          {room && !room.isMain ? <RoomJoinQr key={room.code} code={room.code} /> : null}
        </DialogContent>
      </Dialog>

      {/* Join by code dialog. */}
      <Dialog open={joinOpen} onOpenChange={setJoinOpen}>
        <DialogContent className="border-border bg-card sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-foreground">Join a game</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <Input
              autoFocus
              placeholder="GAME CODE"
              value={joinCode}
              maxLength={5}
              onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
              onKeyDown={(e) => {
                if (e.key === "Enter" && joinCode.trim().length === 5) doJoin(joinCode);
              }}
              className="text-center font-heading text-2xl font-extrabold tracking-[0.3em] uppercase"
            />
            <Button onClick={() => doJoin(joinCode)} size="lg" disabled={busy || joinCode.trim().length !== 5} className="font-semibold">
              Join
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* hostCode is tracked to know when to show the host's Start button. */}
      <span hidden>{hostCode}</span>
    </>
  );
}

function RoomJoinQr({ code }: { code: string }) {
  const [qr, setQr] = useState<string | null>(null);
  const [joinUrl, setJoinUrl] = useState("");

  useEffect(() => {
    // Land on "/" (not "/join"): intro-gate.tsx reads ?room= and joins
    // straight into that island's "enter the island" screen, skipping the
    // Join/Create landing entirely.
    const configuredOrigin = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "");
    const url = new URL("/", configuredOrigin || window.location.origin);
    url.searchParams.set("room", code.toUpperCase());
    const href = url.toString();
    let active = true;

    QRCode.toDataURL(href, {
      width: 360,
      margin: 1,
      errorCorrectionLevel: "M",
      color: { dark: "#12121a", light: "#ffffff" },
    })
      .then((dataUrl) => {
        if (active) {
          setJoinUrl(href);
          setQr(dataUrl);
        }
      })
      .catch(() => {
        if (active) setQr(null);
      });

    return () => {
      active = false;
    };
  }, [code]);

  function copyLink() {
    if (!joinUrl) return;
    void navigator.clipboard?.writeText(joinUrl);
    toast.success("Join link copied");
  }

  const isLocalhost = joinUrl ? ["localhost", "127.0.0.1"].includes(new URL(joinUrl).hostname) : false;

  return (
    <div className="flex w-full flex-col items-center gap-2">
      <div className="rounded-xl bg-white p-2">
        {qr ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={qr} alt={`Scan to join room ${code}`} width={184} height={184} />
        ) : (
          <div className="flex size-[184px] items-center justify-center text-xs text-zinc-500">
            generating QR...
          </div>
        )}
      </div>
      <p className="text-center text-xs text-muted-foreground">
        Scan to join room <span className="font-mono font-semibold text-foreground">{code}</span>
      </p>
      {isLocalhost ? (
        <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-center text-xs text-amber-300">
          Phones cannot open localhost. Open this app from its LAN address or set NEXT_PUBLIC_APP_URL first.
        </p>
      ) : null}
      <Button type="button" variant="outline" size="sm" onClick={copyLink} disabled={!joinUrl}>
        <Copy className="size-3.5" /> Copy join link
      </Button>
    </div>
  );
}

function Setting({
  label, value, min, max, step = 1, onChange, render,
}: {
  label: string; value: number; min: number; max: number; step?: number;
  onChange: (v: number) => void; render: (v: number) => string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between">
        <Label className="text-foreground">{label}</Label>
        <span className="font-mono text-sm font-semibold text-primary">{render(value)}</span>
      </div>
      <Slider value={[value]} min={min} max={max} step={step}
        onValueChange={(v) => onChange(Array.isArray(v) ? v[0]! : (v as number))} />
    </div>
  );
}
