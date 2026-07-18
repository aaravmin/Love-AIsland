"use client";

import dynamic from "next/dynamic";

// Phaser must never be evaluated during SSR (it touches window/document at
// construction time), so PhaserGame is loaded with ssr: false from inside
// this client component. Renders nothing until the game boots, so the ocean
// placeholder behind #game-root stays visible as the loading state.
const PhaserGame = dynamic(() => import("./PhaserGame"), { ssr: false });

export function GameCanvas() {
  return <PhaserGame />;
}
