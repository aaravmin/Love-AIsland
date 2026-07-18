"use client";

import { useEffect, useRef } from "react";
import Phaser from "phaser";
import { IslandScene } from "./scenes/IslandScene";

// Actually mounts the Phaser game. This module statically imports "phaser",
// so it must only ever be loaded client-side (see GameCanvas.tsx, which
// dynamic-imports this with ssr: false) -- Phaser touches window/document at
// construction time and cannot run during Next's server render.
export default function PhaserGame() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const gameRef = useRef<Phaser.Game | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || gameRef.current) return;

    const game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: container,
      pixelArt: true,
      // Matches the packed water tile's flat color exactly (also set on the
      // camera in IslandScene) so there's no color seam during the brief
      // window before the scene's own camera background takes over.
      backgroundColor: "#32b8e8",
      scale: {
        mode: Phaser.Scale.RESIZE,
        width: container.clientWidth || window.innerWidth,
        height: container.clientHeight || window.innerHeight,
      },
      input: { activePointers: 3 },
      scene: [IslandScene],
    });
    gameRef.current = game;
    // QA/debug handle for phase-gate verification scripts.
    (window as unknown as Record<string, unknown>).__arenaGame = game;

    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) {
        game.scale.resize(width, height);
      }
    });
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      game.destroy(true);
      gameRef.current = null;
    };
  }, []);

  return <div ref={containerRef} className="absolute inset-0" />;
}
