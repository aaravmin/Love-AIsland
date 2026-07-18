"use client";

import dynamic from "next/dynamic";

// The swarm / architecture view (task 8.3). React Flow measures the DOM and is
// client-only, so the diagram is loaded with ssr:false; the page shell renders
// immediately with the title bar while it hydrates.
const SwarmFlow = dynamic(() => import("./swarm-flow").then((m) => m.SwarmFlow), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
      Loading swarm view...
    </div>
  ),
});

export default function DemoPage() {
  return (
    <main className="relative flex min-h-0 flex-1 flex-col bg-[#0c0c12]">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div>
          <h1 className="font-heading text-lg font-extrabold text-foreground">
            Swarm architecture
          </h1>
          <p className="text-xs text-muted-foreground">
            Live LLM decision pipeline - Claude Haiku 4.5 under a $10 hard cap.
          </p>
        </div>
      </div>
      <div className="relative min-h-0 flex-1">
        <SwarmFlow />
      </div>
    </main>
  );
}
