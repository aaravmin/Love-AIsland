import { ActivityFeed } from "@/components/activity-feed";
import { ContestantPanel } from "@/components/contestant-panel";
import { ConversationPanel } from "@/components/conversation-panel";
import { EventBanner } from "@/components/event-banner";
import { JoinIslanderButton } from "@/components/join-islander-button";
import { IntroGate } from "@/components/intro-gate";
import { MarketsSheet } from "@/components/markets-sheet";
import { MilestoneOverlay } from "@/components/milestone-overlay";
import { ResultsScreen } from "@/components/results-screen";
import { GameCanvas } from "@/game/GameCanvas";

// The spectate view: a full-viewport slot for the Phaser island canvas with
// chrome overlaid on top. The right rail is the live activity feed (chat over
// the map); markets live in the bottom sheet; the Phase 7 event/hostile banner
// sits top-center. Purely responsive via Tailwind breakpoints, no
// device-detection JS.
export default function SpectatePage() {
  return (
    <main className="relative min-h-0 flex-1 overflow-hidden">
      <IntroGate />

      <div
        id="game-root"
        className="absolute inset-0 flex items-center justify-center bg-[#32b8e8]"
      >
        <span className="text-sm font-medium tracking-wide text-[#123245]">
          island loading...
        </span>
        <GameCanvas />
      </div>

      <JoinIslanderButton />

      <EventBanner />
      <ConversationPanel />
      <ContestantPanel />
      <MarketsSheet />

      {/* Live activity feed, overlaid on the right of the island (md+). */}
      <aside className="absolute inset-y-4 right-4 z-20 hidden w-80 md:block">
        <ActivityFeed />
      </aside>

      <ResultsScreen />
      <MilestoneOverlay />
    </main>
  );
}
