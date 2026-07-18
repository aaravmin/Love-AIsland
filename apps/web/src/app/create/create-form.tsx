"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import {
  STAT_BUDGET,
  STAT_KEYS,
  STAT_MAX,
  STAT_MIN,
  validateStats,
  type Class,
  type ContestantCreatePayload,
  type Stats,
} from "@arena/shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Textarea } from "@/components/ui/textarea";
import { getClientId } from "@/lib/clientId";
import { useGameStore } from "@/lib/gameStore";
import { getOnboarding, getRoom } from "@/lib/onboarding";
import { createContestant, joinRoom, joinSpectator } from "@/lib/socket";
import { cn } from "@/lib/utils";

const NAME_MAX = 20;
const PERSONA_MAX = 140;

type ClassDef = {
  key: Class;
  label: string;
  tagline: string;
  glyph: string;
  card: string; // literal Tailwind classes so the JIT scanner can see them
  ring: string;
  swatch: string;
  text: string;
};

// Class is purely how an islander PLAYS -- it drives their behavior on the
// island, not their numbers. Stats (below) are a separate, independent budget
// that says how GOOD they are at things. Picking a class never touches the
// sliders. Colors are flat theme tokens, one per class, no gradients.
const CLASSES: ClassDef[] = [
  {
    key: "bold",
    label: "Bold",
    tagline: "the aggressor - seeks fights",
    glyph: "B",
    card: "border-destructive/40 bg-destructive/10",
    ring: "ring-destructive",
    swatch: "bg-destructive",
    text: "text-destructive",
  },
  {
    key: "timid",
    label: "Timid",
    tagline: "the survivor - stays under the radar",
    glyph: "T",
    card: "border-chart-5/40 bg-chart-5/10",
    ring: "ring-chart-5",
    swatch: "bg-chart-5",
    text: "text-chart-5",
  },
  {
    key: "schemer",
    label: "Schemer",
    tagline: "the manipulator - allies, then betrays",
    glyph: "S",
    card: "border-accent/40 bg-accent/10",
    ring: "ring-accent",
    swatch: "bg-accent",
    text: "text-accent",
  },
  {
    key: "charmer",
    label: "Charmer",
    tagline: "the socialite - builds big alliances",
    glyph: "C",
    card: "border-primary/40 bg-primary/10",
    ring: "ring-primary",
    swatch: "bg-primary",
    text: "text-primary",
  },
  {
    key: "wildcard",
    label: "Wildcard",
    tagline: "chaotic - nobody knows, including them",
    glyph: "W",
    card: "border-chart-4/40 bg-chart-4/10",
    ring: "ring-chart-4",
    swatch: "bg-chart-4",
    text: "text-chart-4",
  },
];

const STAT_META: Record<keyof Stats, { label: string; hint: string }> = {
  charisma: { label: "Charisma", hint: "How persuasive you are in alliances" },
  cunning: { label: "Cunning", hint: "Reads and outmaneuvers other players" },
  grit: { label: "Grit", hint: "HP pool - how much punishment you can take" },
  strength: { label: "Strength", hint: "Damage dealt in a fight" },
  charm: { label: "Charm", hint: "Wins people over, avoids being targeted" },
  instinct: { label: "Instinct", hint: "Avoids ambushes and reacts fast" },
  resolve: { label: "Resolve", hint: "Resists manipulation - hard to sway or betray" },
};

// A balanced 5/5/5/5/5/5/5 start (sums to STAT_BUDGET) -- independent of class.
const DEFAULT_STATS: Stats = {
  charisma: 5,
  cunning: 5,
  grit: 5,
  strength: 5,
  charm: 5,
  instinct: 5,
  resolve: 5,
};

function sumStats(stats: Stats): number {
  return STAT_KEYS.reduce((total, key) => total + stats[key], 0);
}

export default function CreateForm() {
  const router = useRouter();
  const aliveCount = useGameStore(
    (s) => Object.values(s.contestants).filter((c) => c.alive).length
  );
  // Islanders can only be built before the game starts; if it's already running
  // (e.g. a direct link, or it started while this page was open), bounce to the
  // spectate view where they can still bet.
  const gameStarted = useGameStore((s) => s.phase !== "lobby");

  // This component is only ever mounted client-side (see create-canvas.tsx's
  // ssr:false dynamic import), so there's no SSR/hydration pass to keep in
  // sync -- reading localStorage once via a lazy initializer is safe and
  // never flashes a false "no onboarding" redirect the way an effect-driven
  // read would on a hard navigation.
  const [onboarding] = useState(() => getOnboarding());

  const [islanderName, setIslanderName] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [selectedClass, setSelectedClass] = useState<Class | null>(null);
  const [stats, setStats] = useState<Stats>(DEFAULT_STATS);
  const [persona, setPersona] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    if (onboarding === null) router.replace("/join");
    else if (gameStarted) router.replace("/");
  }, [onboarding, gameStarted, router]);

  const pointsSpent = useMemo(() => sumStats(stats), [stats]);
  const pointsLeft = STAT_BUDGET - pointsSpent;
  const statsCheck = useMemo(() => validateStats(stats), [stats]);

  const trimmedName = islanderName.trim();
  const canSubmit =
    trimmedName.length > 0 &&
    trimmedName.length <= NAME_MAX &&
    selectedClass !== null &&
    statsCheck.ok &&
    !submitting;

  // Mirror of the server's 1/N market seeding (ARCHITECTURE.md 6.4) counting
  // this contestant among the living; the authoritative seed arrives with
  // the create ack's `contestant:joined` broadcast.
  const previewOdds = useMemo(
    () => Math.min(0.98, Math.max(0.02, 1 / (aliveCount + 1))),
    [aliveCount]
  );

  function pickClass(def: ClassDef) {
    // Class is behavior only -- deliberately does NOT touch the stat sliders.
    setSelectedClass(def.key);
  }

  function updateStat(key: keyof Stats, value: number | readonly number[]) {
    // The shared Slider wrapper types value/onValueChange as
    // `number | readonly number[]` (it also supports range sliders); every
    // stat slider here is single-thumb, so it's always the number branch.
    const next = Array.isArray(value) ? value[0] : (value as number);
    setStats((prev) => ({ ...prev, [key]: next }));
  }

  function validateName(): boolean {
    if (!trimmedName) {
      setNameError("Your islander needs a name.");
      return false;
    }
    if (trimmedName.length > NAME_MAX) {
      setNameError(`Keep it under ${NAME_MAX} characters.`);
      return false;
    }
    setNameError(null);
    return true;
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!validateName() || !selectedClass || !statsCheck.ok || !onboarding || submitting) return;

    const payload: ContestantCreatePayload = {
      clientId: getClientId(),
      name: trimmedName,
      klass: selectedClass,
      stats,
      persona: persona.trim(),
    };

    setSubmitting(true);
    setSubmitError(null);
    try {
      // QR onboarding stores the target room before this screen. Explicitly
      // enter it here so a hard refresh on /create cannot silently drop the
      // contestant into MAIN when the socket reconnects.
      const roomCode = getRoom().trim().toUpperCase();
      if (roomCode !== "MAIN") {
        const roomAck = await joinRoom(roomCode);
        if (!roomAck.ok) {
          setSubmitError(roomAck.error ?? "That room is no longer available.");
          return;
        }
      }
      // spectator:join is idempotent by clientId, so re-registering here
      // covers a server restart (or a /create deep link) where localStorage
      // still has onboarding but the server has never seen this client.
      await joinSpectator(onboarding.name, onboarding.phone);
      const ack = await createContestant(payload);
      if (!ack.ok) {
        setSubmitError(ack.error);
        return;
      }
      router.push("/");
    } catch {
      setSubmitError("Can't reach the island right now. Try again in a moment.");
    } finally {
      setSubmitting(false);
    }
  }

  if (!onboarding) return null; // redirecting to /join

  return (
    <main className="flex flex-1 justify-center overflow-y-auto p-4">
      <form
        className="flex w-full max-w-3xl flex-col gap-4 md:grid md:grid-cols-[1fr_260px] md:items-start md:gap-6"
        onSubmit={handleSubmit}
        noValidate
      >
        <div className="flex flex-col gap-4 md:col-start-1">
          <div>
            <h1 className="font-heading text-3xl leading-tight font-semibold text-foreground">
              Build your islander
            </h1>
            <p className="text-sm text-muted-foreground">
              Playing as <span className="font-semibold text-foreground">{onboarding.name}</span>.
              Pick a class, spend your stat budget, then send them in.
            </p>
          </div>

          <Card className="border border-border bg-card">
            <CardContent className="flex flex-col gap-1.5">
              <Label htmlFor="islander-name" className="text-muted-foreground">
                Islander name
              </Label>
              <Input
                id="islander-name"
                placeholder="e.g. Foxy J"
                value={islanderName}
                maxLength={40}
                onChange={(e) => setIslanderName(e.target.value)}
                aria-invalid={nameError ? true : undefined}
              />
              {nameError ? (
                <p className="text-xs font-medium text-destructive">{nameError}</p>
              ) : null}
            </CardContent>
          </Card>

          <Card className="border border-border bg-card">
            <CardHeader>
              <CardTitle className="text-foreground">Pick a class</CardTitle>
              <p className="text-xs text-muted-foreground">
                How they play the game. Separate from stats - it won&rsquo;t change your numbers.
              </p>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                {CLASSES.map((def) => {
                  const selected = selectedClass === def.key;
                  return (
                    <button
                      key={def.key}
                      type="button"
                      onClick={() => pickClass(def)}
                      className={cn(
                        "flex flex-col items-start gap-1.5 rounded-lg border px-2.5 py-2.5 text-left transition-colors",
                        def.card,
                        selected ? cn("ring-2", def.ring) : "ring-0"
                      )}
                    >
                      <span
                        className={cn(
                          "flex size-7 items-center justify-center rounded-md text-sm font-bold text-white",
                          def.swatch
                        )}
                      >
                        {def.glyph}
                      </span>
                      <span className={cn("font-heading text-sm font-semibold", def.text)}>
                        {def.label}
                      </span>
                      <span className="text-[11px] leading-tight text-muted-foreground">
                        {def.tagline}
                      </span>
                    </button>
                  );
                })}
              </div>
            </CardContent>
          </Card>

          <Card className="border border-border bg-card">
            <CardHeader className="flex items-center justify-between gap-2">
              <CardTitle className="text-foreground">Stats</CardTitle>
              <span
                className={cn(
                  "font-heading text-sm font-bold",
                  pointsLeft === 0
                    ? "text-chart-4"
                    : pointsLeft < 0
                      ? "text-destructive"
                      : "text-foreground"
                )}
              >
                {pointsLeft} left
              </span>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <p className="-mt-1 text-xs text-muted-foreground">
                How good they are at things. Spend all {STAT_BUDGET} points however you like.
              </p>
              {STAT_KEYS.map((key) => (
                <div key={key} className="flex flex-col gap-1">
                  <div className="flex items-baseline justify-between">
                    <Label htmlFor={`stat-${key}`} className="text-foreground">
                      {STAT_META[key].label}
                    </Label>
                    <span className="font-mono text-sm font-semibold text-foreground">
                      {stats[key]}
                    </span>
                  </div>
                  <Slider
                    id={`stat-${key}`}
                    // The shared Slider wrapper's thumb count comes from
                    // `Array.isArray(value) ? value : ... : [min, max]` --
                    // a plain number value falls through to the 2-thumb
                    // range fallback. Wrapping in a 1-tuple keeps this a
                    // true single-thumb slider.
                    value={[stats[key]]}
                    min={STAT_MIN}
                    max={STAT_MAX}
                    step={1}
                    onValueChange={(value) => updateStat(key, value)}
                  />
                  <p className="text-xs text-muted-foreground">{STAT_META[key].hint}</p>
                </div>
              ))}
              {!statsCheck.ok && pointsLeft !== 0 ? (
                <p className="text-xs font-medium text-destructive">
                  {pointsLeft > 0
                    ? `Spend ${pointsLeft} more point${pointsLeft === 1 ? "" : "s"} before you can enter the island.`
                    : `Over budget by ${-pointsLeft} point${-pointsLeft === 1 ? "" : "s"} -- pull a slider back.`}
                </p>
              ) : null}
            </CardContent>
          </Card>

          <Card className="border border-border bg-card">
            <CardHeader>
              <CardTitle className="text-foreground">Persona</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-1.5">
              <Textarea
                placeholder="Villain era. Trusts no one, flirts with everyone."
                value={persona}
                maxLength={PERSONA_MAX}
                rows={2}
                onChange={(e) => setPersona(e.target.value)}
              />
              <p className="self-end text-xs text-muted-foreground">
                {persona.length}/{PERSONA_MAX}
              </p>
            </CardContent>
          </Card>

          {submitError ? (
            <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive">
              {submitError}
            </p>
          ) : null}
          <Button
            type="submit"
            size="lg"
            disabled={!canSubmit}
            className="font-heading text-base font-semibold"
          >
            {submitting ? "Entering the island..." : "Enter the island"}
          </Button>
        </div>

        <div className="md:sticky md:top-4 md:col-start-2">
          <Card className="border border-border bg-card">
            <CardHeader>
              <CardTitle className="text-foreground">Preview</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col items-center gap-3 py-2">
              <div className="flex items-center gap-1.5 rounded-full bg-[#141414] px-3 py-1.5">
                <span className="font-mono text-xs font-semibold tracking-wide text-white uppercase">
                  {trimmedName || "Your islander"}
                </span>
                <span className="font-mono text-xs font-semibold text-chart-5">
                  {Math.round(previewOdds * 100)}%
                </span>
              </div>
              <div className="islander-idle-sprite" aria-hidden />
              {selectedClass ? (
                <span
                  className={cn(
                    "font-heading text-sm font-semibold",
                    CLASSES.find((c) => c.key === selectedClass)?.text
                  )}
                >
                  {CLASSES.find((c) => c.key === selectedClass)?.label}
                </span>
              ) : (
                <span className="text-sm text-muted-foreground">No class picked yet</span>
              )}
              {persona.trim() ? (
                <p className="text-center text-xs text-muted-foreground italic">
                  &ldquo;{persona.trim()}&rdquo;
                </p>
              ) : null}
            </CardContent>
          </Card>
        </div>
      </form>
    </main>
  );
}
