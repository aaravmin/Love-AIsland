"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Bell, BellOff } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getClientId } from "@/lib/clientId";
import { useGameStore } from "@/lib/gameStore";
import { getRoom, setOnboarding, setRoom } from "@/lib/onboarding";
import { joinRoom, joinSpectator } from "@/lib/socket";
import { cn } from "@/lib/utils";

const NAME_MAX = 20;

// Lenient international phone check (mirrors the server): 7-15 digits.
function validPhone(raw: string): boolean {
  const digits = raw.replace(/\D/g, "");
  return digits.length >= 7 && digits.length <= 15;
}

export function JoinForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // A QR/room link carries ?room=; otherwise fall back to the island this
  // person already joined (persisted by the choice/QR step), not a hardcoded
  // MAIN -- so signing in stays pointed at their actual game.
  const room = (searchParams.get("room")?.trim() || getRoom()).toUpperCase();
  // Once the game is running/settled you can bet but not create an islander.
  const gameStarted = useGameStore((s) => s.phase !== "lobby");

  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notify, setNotify] = useState(false);

  useEffect(() => {
    getClientId();
    setRoom(room);
  }, [room]);

  function validate(): boolean {
    let ok = true;
    const trimmedName = name.trim();
    if (!trimmedName) {
      setNameError("You need a name.");
      ok = false;
    } else if (trimmedName.length > NAME_MAX) {
      setNameError(`Keep it under ${NAME_MAX} characters.`);
      ok = false;
    } else {
      setNameError(null);
    }
    if (!validPhone(phone)) {
      setPhoneError("Enter a real phone number - it's how we reach you if you win.");
      ok = false;
    } else {
      setPhoneError(null);
    }
    return ok;
  }

  // Both actions save the name+phone and register the person as a spectator (so
  // they can bet immediately); "create" then continues to the builder.
  async function proceed(mode: "bet" | "create") {
    if (busy) return;
    if (!validate()) return;
    setBusy(true);
    try {
      setOnboarding({ name: name.trim(), phone: phone.trim() });
      // A direct /join?room= link may not have entered its room yet. Resolve
      // that before registering so the spectator cannot land in MAIN by race.
      if (useGameStore.getState().room?.code !== room) {
        const roomAck = await joinRoom(room);
        if (!roomAck.ok) {
          toast.error(roomAck.error ?? "That game is no longer available.");
          return;
        }
      }
      // Notification preference travels with sign-in, removing a second
      // serialized acknowledgement from the common join path.
      const joinAck = await joinSpectator(name.trim(), phone.trim(), notify);
      if (!joinAck.ok) {
        toast.error("That game is full or your sign-in details were rejected.");
        return;
      }
      if (mode === "create") {
        if (gameStarted) {
          toast.error("The game already started - you can still bet.");
          router.push("/");
          return;
        }
        router.push("/create");
      } else {
        router.push("/");
      }
    } catch {
      toast.error("Couldn't reach the island. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex flex-1 items-center justify-center p-4">
      <Card className="w-full max-w-sm border border-border bg-card">
        <CardHeader className="gap-2">
          <CardTitle className="font-heading text-3xl leading-tight font-semibold text-foreground">
            Welcome to Love <span className="text-chart-4">AI</span>sland
          </CardTitle>
          <CardDescription className="text-sm">
            {gameStarted ? (
              <>
                Room <span className="font-mono font-semibold text-foreground">{room}</span>{" "}
                is already live. Sign in to watch and bet.
              </>
            ) : (
              <>
                Room <span className="font-mono font-semibold text-foreground">{room}</span>{" "}
                is waiting. Sign in, then bet or build an islander.
              </>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              void proceed(gameStarted ? "bet" : "create");
            }}
            noValidate
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="join-name" className="text-muted-foreground">
                Name
              </Label>
              <Input
                id="join-name"
                placeholder="Your name"
                value={name}
                maxLength={40}
                onChange={(e) => setName(e.target.value)}
                aria-invalid={nameError ? true : undefined}
              />
              {nameError ? (
                <p className="text-xs font-medium text-destructive">{nameError}</p>
              ) : null}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="join-phone" className="text-muted-foreground">
                Phone number
              </Label>
              <Input
                id="join-phone"
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                placeholder="+1 555 123 4567"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                aria-invalid={phoneError ? true : undefined}
              />
              {phoneError ? (
                <p className="text-xs font-medium text-destructive">{phoneError}</p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Only used to reach you if you win. Never shown publicly.
                </p>
              )}
            </div>

            <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/50 px-3 py-2.5">
              <div className="flex flex-col gap-0.5">
                <span className="text-sm font-medium text-foreground">
                  Text me portfolio updates
                </span>
                <span className="text-xs text-muted-foreground">
                  Occasional SMS about how your bets are doing.
                </span>
              </div>
              <button
                type="button"
                onClick={() => setNotify((v) => !v)}
                aria-pressed={notify}
                title="Text me portfolio updates"
                className={cn(
                  "flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold transition-colors",
                  notify
                    ? "border-primary/40 bg-primary/15 text-primary"
                    : "border-border bg-muted text-muted-foreground",
                )}
              >
                {notify ? <Bell className="size-3.5" /> : <BellOff className="size-3.5" />}
                {notify ? "On" : "Off"}
              </button>
            </div>

            <div className="mt-2 flex flex-col gap-2">
              {gameStarted ? (
                <Button
                  type="button"
                  size="lg"
                  disabled={busy}
                  onClick={() => void proceed("bet")}
                  className="w-full font-heading text-base font-semibold"
                >
                  Continue to the island
                </Button>
              ) : (
                <>
                  <Button
                    type="submit"
                    size="lg"
                    disabled={busy}
                    className="w-full font-heading text-base font-semibold"
                  >
                    Create your islander
                  </Button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void proceed("bet")}
                    className="text-center text-xs font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:opacity-50"
                  >
                    or just watch and bet
                  </button>
                </>
              )}
            </div>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
