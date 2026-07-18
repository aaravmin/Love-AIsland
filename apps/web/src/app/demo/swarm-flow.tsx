"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Background,
  Controls,
  Position,
  ReactFlow,
  type Edge,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useGameStore } from "@/lib/gameStore";

// Phase 8.3 - the swarm architecture view. A live React Flow diagram of the
// decision pipeline: each living islander is an agent node feeding a concurrent
// scheduler, which calls the Claude Haiku model. Edges pulse when an agent
// thinks (green = real LLM decision, amber = rule-engine fallback), and a spend
// meter tracks the hard $10 cap. It's the "how the swarm works" screen for the
// demo display.

// An agent is "hot" for this long after its last decision (drives the pulse).
const HOT_MS = 1600;

const SCHEDULER_ID = "__scheduler";
const MODEL_ID = "__model";

export function SwarmFlow() {
  const contestants = useGameStore((s) => s.contestants);
  const swarmActivity = useGameStore((s) => s.swarmActivity);
  const spend = useGameStore((s) => s.spend);
  const stats = useGameStore((s) => s.swarmStats);
  const phase = useGameStore((s) => s.phase);

  // Local ticker so pulses expire smoothly even between telemetry events.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 400);
    return () => clearInterval(id);
  }, []);

  const agents = useMemo(
    () => Object.values(contestants).filter((c) => c.alive),
    [contestants],
  );

  const { nodes, edges } = useMemo(() => {
    const n: Node[] = [];
    const e: Edge[] = [];
    const spacing = 64;
    const colH = Math.max(agents.length - 1, 0) * spacing;
    const midY = colH / 2;

    let anyHot = false;
    agents.forEach((a, i) => {
      const act = swarmActivity[a.id];
      const hot = act ? now - act.at < HOT_MS : false;
      if (hot) anyHot = true;
      const color = !act ? "#3f3f46" : act.fallback ? "#f59e0b" : "#34d399";
      n.push({
        id: a.id,
        position: { x: 0, y: i * spacing },
        data: { label: a.name },
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
        style: {
          width: 150,
          fontSize: 12,
          fontWeight: 600,
          color: "#e4e4e7",
          background: "#18181b",
          border: `2px solid ${color}`,
          borderRadius: 10,
          boxShadow: hot ? `0 0 14px ${color}` : "none",
          transition: "box-shadow 200ms, border-color 200ms",
        },
      });
      e.push({
        id: `${a.id}->sched`,
        source: a.id,
        target: SCHEDULER_ID,
        animated: hot,
        style: { stroke: hot ? color : "#3f3f46", strokeWidth: hot ? 2 : 1 },
      });
    });

    n.push({
      id: SCHEDULER_ID,
      position: { x: 300, y: midY },
      data: { label: "Scheduler · semaphore 8" },
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      style: {
        width: 190,
        fontSize: 13,
        fontWeight: 700,
        color: "#fff",
        background: "#be185d",
        border: "2px solid #ec4899",
        borderRadius: 12,
      },
    });
    n.push({
      id: MODEL_ID,
      position: { x: 580, y: midY },
      data: { label: spend?.fallbackActive ? "Claude Haiku · CAPPED" : "Claude Haiku 4.5" },
      targetPosition: Position.Left,
      style: {
        width: 180,
        fontSize: 13,
        fontWeight: 700,
        color: "#fff",
        background: spend?.fallbackActive ? "#7f1d1d" : "#1d4ed8",
        border: `2px solid ${spend?.fallbackActive ? "#ef4444" : "#3b82f6"}`,
        borderRadius: 12,
      },
    });
    e.push({
      id: "sched->model",
      source: SCHEDULER_ID,
      target: MODEL_ID,
      animated: anyHot && !spend?.fallbackActive,
      style: {
        stroke: spend?.fallbackActive ? "#ef4444" : anyHot ? "#60a5fa" : "#3f3f46",
        strokeWidth: 2,
      },
    });

    return { nodes: n, edges: e };
  }, [agents, swarmActivity, now, spend]);

  const cap = spend?.capUsd ?? 10;
  const usd = spend?.estimatedUsd ?? 0;
  const pct = Math.min(100, (usd / cap) * 100);
  const cacheRate = stats.calls > 0 ? Math.round((stats.cached / stats.calls) * 100) : 0;

  return (
    <div className="absolute inset-0">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        proOptions={{ hideAttribution: true }}
        colorMode="dark"
      >
        <Background color="#27272a" gap={20} />
        <Controls showInteractive={false} />
      </ReactFlow>

      {/* Telemetry overlay */}
      <div className="pointer-events-none absolute top-4 right-4 w-64 rounded-xl border border-white/10 bg-[#12121a]/90 p-4 shadow-lg backdrop-blur">
        <p className="text-[11px] font-bold tracking-widest text-primary uppercase">LLM spend</p>
        <div className="mt-1 flex items-baseline justify-between">
          <span className="font-heading text-2xl font-extrabold text-white tabular-nums">
            ${usd.toFixed(2)}
          </span>
          <span className="text-xs text-zinc-400">/ ${cap.toFixed(0)} cap</span>
        </div>
        <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-zinc-800">
          <div
            className={pct > 80 ? "h-full bg-rose-500" : pct > 60 ? "h-full bg-amber-400" : "h-full bg-emerald-400"}
            style={{ width: `${pct}%`, transition: "width 300ms" }}
          />
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {spend?.fallbackActive ? (
            <span className="rounded-full bg-rose-600/30 px-2 py-0.5 text-[11px] font-bold text-rose-300">
              FALLBACK (cap hit)
            </span>
          ) : spend?.throttled ? (
            <span className="rounded-full bg-amber-500/25 px-2 py-0.5 text-[11px] font-bold text-amber-300">
              THROTTLED
            </span>
          ) : (
            <span className="rounded-full bg-emerald-500/20 px-2 py-0.5 text-[11px] font-bold text-emerald-300">
              LIVE
            </span>
          )}
        </div>

        <div className="mt-3 grid grid-cols-3 gap-2 border-t border-white/10 pt-3 text-center">
          <div>
            <p className="font-heading text-lg font-extrabold text-white tabular-nums">{stats.calls}</p>
            <p className="text-[10px] text-zinc-400 uppercase">Calls</p>
          </div>
          <div>
            <p className="font-heading text-lg font-extrabold text-white tabular-nums">{cacheRate}%</p>
            <p className="text-[10px] text-zinc-400 uppercase">Cached</p>
          </div>
          <div>
            <p className="font-heading text-lg font-extrabold text-white tabular-nums">{stats.fallback}</p>
            <p className="text-[10px] text-zinc-400 uppercase">Fallback</p>
          </div>
        </div>

        <div className="mt-3 flex items-center gap-3 border-t border-white/10 pt-2 text-[11px] text-zinc-400">
          <span className="flex items-center gap-1">
            <span className="size-2 rounded-full bg-emerald-400" /> LLM
          </span>
          <span className="flex items-center gap-1">
            <span className="size-2 rounded-full bg-amber-400" /> rule
          </span>
        </div>
      </div>

      {agents.length === 0 ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <p className="rounded-lg bg-[#12121a]/90 px-4 py-2 text-sm text-zinc-300">
            {phase === "lobby"
              ? "Waiting for the game to start - agents think once the island goes live."
              : "No living agents."}
          </p>
        </div>
      ) : null}
    </div>
  );
}
