"use client";

import { useState, type FormEvent } from "react";
import { ChevronLeft, ChevronRight, Copy, Plus, Ticket, type LucideIcon } from "lucide-react";
import { toast } from "sonner";
import type { RoomConfig } from "@arena/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { setRoom } from "@/lib/onboarding";
import { createRoom, joinRoom } from "@/lib/socket";

// The Join/Create-island landing shown before the intro screen (intro-gate.tsx
// step 1). Styled to match intro-screen.tsx's pixelated Love Island look --
// same #170f22 / #ff2d78 / #ffd84d palette, blocky pixel frames, chunky
// headings -- so the two steps read as one continuous show opener. Reports
// completion via onChosen once the visitor has joined or created an island,
// so the gate can advance to the "enter the island" step.

type Step = "choose" | "join" | "create" | "created";

const DEFAULT_CONFIG: RoomConfig = { agentsPerPerson: 2, lengthMinutes: 15, eventCount: 2 };

function slug(n: number, one: string, many = one + "s") {
  return `${n} ${n === 1 ? one : many}`;
}

export function IslandChoice({ onChosen }: { onChosen: () => void }) {
  const [step, setStep] = useState<Step>("choose");
  const [busy, setBusy] = useState(false);

  const [joinCode, setJoinCode] = useState("");

  const [name, setName] = useState("");
  const [cfg, setCfg] = useState<RoomConfig>(DEFAULT_CONFIG);
  const [createdCode, setCreatedCode] = useState<string | null>(null);

  async function doJoin(e?: FormEvent) {
    e?.preventDefault();
    if (busy || joinCode.trim().length !== 5) return;
    setBusy(true);
    try {
      const code = joinCode.trim().toUpperCase();
      const res = await joinRoom(code);
      if (!res.ok) {
        toast.error(res.error ?? "Couldn't find that island.");
        return;
      }
      // Persist so the sign-in + create steps that follow stay pointed at this
      // island (they resolve the room via onboarding, not the URL).
      setRoom(code);
      onChosen();
    } finally {
      setBusy(false);
    }
  }

  async function doCreate(e?: FormEvent) {
    e?.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      const res = await createRoom(name, cfg);
      if (!res.ok || !res.code) {
        toast.error(res.error ?? "Couldn't create your island.");
        return;
      }
      // Persist so the sign-in + create steps that follow target this new
      // island rather than falling back to MAIN.
      setRoom(res.code);
      setCreatedCode(res.code);
      setStep("created");
    } finally {
      setBusy(false);
    }
  }

  function copyCode() {
    if (!createdCode) return;
    void navigator.clipboard?.writeText(createdCode);
    toast.success("Code copied");
  }

  return (
    <section
      className="fixed inset-0 z-[100] overflow-x-hidden overflow-y-auto bg-[#170f22] text-white"
      role="dialog"
      aria-modal="true"
      aria-labelledby="island-choice-title"
    >
      <div className="intro-pink-plane absolute inset-x-0 top-0 h-[46%] bg-[#ff2d78]" />
      <div className="intro-pixel-corner absolute top-0 right-0 size-40 bg-[#ffd84d] sm:size-56" />
      <div className="intro-pixel-sun absolute -right-8 top-8 size-24 bg-[#ff2d78] sm:size-32" />
      <div className="intro-coral-block absolute -bottom-20 -left-16 h-64 w-72 bg-[#ff6b35] sm:h-80 sm:w-96" />
      <div aria-hidden="true" className="intro-pixel-heart absolute top-[12%] left-[6%]" />
      <div aria-hidden="true" className="intro-pixel-spark absolute right-[8%] bottom-[14%]" />

      <div className="relative z-10 flex min-h-full items-center justify-center p-4 sm:p-8">
        <div className="intro-pixel-frame w-full max-w-xl overflow-hidden border-4 border-[#0e0916] bg-[#21152f]">
          <div className="border-b-4 border-[#0e0916] bg-[#21152f] px-6 py-10 text-center sm:px-10 sm:py-12">
            <h1 className="intro-pixel-title font-heading text-5xl leading-[0.85] font-extrabold tracking-[-0.055em] sm:text-7xl">
              Love
              <span className="block text-[#ffd84d]">AI<span className="text-white">sland</span></span>
            </h1>
          </div>

          <div className="border-b-4 border-[#0e0916] bg-[#ff2d78] px-6 py-6 sm:px-10 sm:py-8">
            <div className="mb-4 flex w-fit items-center gap-2 border-2 border-[#21152f] bg-[#ffd84d] px-3 py-1.5 font-mono text-[10px] font-black tracking-[0.2em] text-[#21152f] uppercase">
              <span className="size-2 bg-[#21152f]" />
              villa.exe
            </div>
            <h2
              id="island-choice-title"
              className="intro-pixel-title font-heading text-4xl leading-[0.9] font-extrabold tracking-[-0.045em] sm:text-5xl"
            >
              Find your island
            </h2>
            <p className="mt-3 max-w-md text-sm font-semibold text-white/90 sm:text-base">
              Join a friend&rsquo;s game with their code, or start your own from scratch.
            </p>
          </div>

          <div className="px-6 py-7 sm:px-10 sm:py-9">
            {step === "choose" ? (
              <div className="flex flex-col gap-3">
                <ChoiceButton
                  icon={Ticket}
                  title="Join an island"
                  copy="Got a 5-letter code from a friend? Drop in."
                  onClick={() => setStep("join")}
                />
                <ChoiceButton
                  icon={Plus}
                  title="Create an island"
                  copy="Set the rules and get a code to share."
                  onClick={() => {
                    setName("");
                    setCfg(DEFAULT_CONFIG);
                    setStep("create");
                  }}
                />
              </div>
            ) : null}

            {step === "join" ? (
              <form className="flex flex-col gap-4" onSubmit={doJoin} noValidate>
                <BackButton onClick={() => setStep("choose")} />
                <div className="flex flex-col gap-1.5">
                  <Label
                    htmlFor="island-code"
                    className="font-mono text-[11px] font-bold tracking-[0.15em] text-[#b7a9cc] uppercase"
                  >
                    Island code
                  </Label>
                  <Input
                    id="island-code"
                    autoFocus
                    placeholder="AB12C"
                    value={joinCode}
                    maxLength={5}
                    onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                    className="h-14 rounded-none border-2 border-[#49385e] bg-[#170f22] text-center font-heading text-2xl font-extrabold tracking-[0.3em] text-white uppercase placeholder:text-[#49385e] focus-visible:border-[#ff2d78] focus-visible:ring-0"
                  />
                </div>
                <Button
                  type="submit"
                  size="lg"
                  disabled={busy || joinCode.trim().length !== 5}
                  className="intro-pixel-button h-12 w-full rounded-none border-2 border-[#fff3a6] bg-[#ffd84d] font-mono text-sm font-black tracking-wide text-[#21152f] uppercase hover:bg-[#ffe477]"
                >
                  {busy ? "Joining..." : "Join island"} <ChevronRight className="size-5 stroke-[3]" />
                </Button>
              </form>
            ) : null}

            {step === "create" ? (
              <form className="flex flex-col gap-4" onSubmit={doCreate} noValidate>
                <BackButton onClick={() => setStep("choose")} />
                <div className="flex flex-col gap-1.5">
                  <Label
                    htmlFor="island-name"
                    className="font-mono text-[11px] font-bold tracking-[0.15em] text-[#b7a9cc] uppercase"
                  >
                    Island name
                  </Label>
                  <Input
                    id="island-name"
                    placeholder="Friday night island"
                    value={name}
                    maxLength={30}
                    onChange={(e) => setName(e.target.value)}
                    className="rounded-none border-2 border-[#49385e] bg-[#170f22] text-white placeholder:text-[#7f7194] focus-visible:border-[#ff2d78] focus-visible:ring-0"
                  />
                </div>
                <PixelSetting
                  label="Islanders per person"
                  value={cfg.agentsPerPerson}
                  min={1}
                  max={5}
                  onChange={(v) => setCfg((c) => ({ ...c, agentsPerPerson: v }))}
                  render={(v) => slug(v, "islander")}
                />
                <PixelSetting
                  label="Island length"
                  value={cfg.lengthMinutes}
                  min={5}
                  max={30}
                  step={5}
                  onChange={(v) => setCfg((c) => ({ ...c, lengthMinutes: v }))}
                  render={(v) => `${v} min`}
                />
                <PixelSetting
                  label="Random events"
                  value={cfg.eventCount}
                  min={0}
                  max={4}
                  onChange={(v) => setCfg((c) => ({ ...c, eventCount: v }))}
                  render={(v) => (v === 0 ? "none" : slug(v, "event"))}
                />
                <Button
                  type="submit"
                  size="lg"
                  disabled={busy}
                  className="intro-pixel-button h-12 w-full rounded-none border-2 border-[#fff3a6] bg-[#ffd84d] font-mono text-sm font-black tracking-wide text-[#21152f] uppercase hover:bg-[#ffe477]"
                >
                  {busy ? "Creating..." : "Create island"} <ChevronRight className="size-5 stroke-[3]" />
                </Button>
              </form>
            ) : null}

            {step === "created" && createdCode ? (
              <div className="flex flex-col items-center gap-4 py-2 text-center">
                <p className="text-sm font-semibold text-[#b7a9cc]">Your island is live. Share this code:</p>
                <button
                  type="button"
                  onClick={copyCode}
                  className="group flex items-center gap-3 border-2 border-[#ffd84d] bg-[#2a2038] px-6 py-3"
                >
                  <span className="font-heading text-4xl font-extrabold tracking-[0.2em] text-[#ffd84d]">
                    {createdCode}
                  </span>
                  <Copy className="size-5 text-[#ffd84d] opacity-70 group-hover:opacity-100" />
                </button>
                <div className="flex flex-wrap justify-center gap-2 text-xs text-[#b7a9cc]">
                  <span className="border-2 border-[#49385e] bg-[#2a2038] px-2 py-1">
                    {slug(cfg.agentsPerPerson, "islander")} each
                  </span>
                  <span className="border-2 border-[#49385e] bg-[#2a2038] px-2 py-1">{cfg.lengthMinutes} min</span>
                  <span className="border-2 border-[#49385e] bg-[#2a2038] px-2 py-1">
                    {cfg.eventCount === 0 ? "no events" : slug(cfg.eventCount, "event")}
                  </span>
                </div>
                <Button
                  type="button"
                  size="lg"
                  onClick={onChosen}
                  className="intro-pixel-button h-12 w-full rounded-none border-2 border-[#fff3a6] bg-[#ffd84d] font-mono text-sm font-black tracking-wide text-[#21152f] uppercase hover:bg-[#ffe477]"
                >
                  Continue <ChevronRight className="size-5 stroke-[3]" />
                </Button>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}

function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-fit items-center gap-1 font-mono text-[11px] font-bold tracking-wide text-[#b7a9cc] uppercase hover:text-white"
    >
      <ChevronLeft className="size-3.5" /> Back
    </button>
  );
}

function ChoiceButton({
  icon: Icon,
  title,
  copy,
  onClick,
}: {
  icon: LucideIcon;
  title: string;
  copy: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="intro-pixel-step flex items-center justify-between gap-3 border-2 border-[#49385e] bg-[#2a2038] p-4 text-left transition-colors hover:border-[#ff2d78]"
    >
      <span className="flex items-center gap-3">
        <span className="flex size-11 shrink-0 items-center justify-center border-2 border-[#ff77a8] bg-[#ff2d78] text-white">
          <Icon className="size-5" />
        </span>
        <span>
          <span className="block font-heading text-lg font-bold">{title}</span>
          <span className="block text-xs text-[#b7a9cc]">{copy}</span>
        </span>
      </span>
      <ChevronRight className="size-5 shrink-0 stroke-[3] text-[#ff77a8]" />
    </button>
  );
}

function PixelSetting({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
  render,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  render: (v: number) => string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between">
        <Label className="font-mono text-[11px] font-bold tracking-[0.15em] text-[#b7a9cc] uppercase">
          {label}
        </Label>
        <span className="font-mono text-sm font-black text-[#ffd84d]">{render(value)}</span>
      </div>
      <Slider
        value={[value]}
        min={min}
        max={max}
        step={step}
        onValueChange={(v) => onChange(Array.isArray(v) ? v[0]! : (v as number))}
        className="[&_[data-slot=slider-range]]:bg-[#ff2d78] [&_[data-slot=slider-thumb]]:border-[#ffd84d] [&_[data-slot=slider-track]]:bg-[#49385e]"
      />
    </div>
  );
}
