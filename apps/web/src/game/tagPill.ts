import Phaser from "phaser";

export type Trend = "up" | "down";

// Structural: any {name, odds, trend} renders the same pill, so live
// contestants and any future preview share one code path.
export type TagPillData = { name: string; odds: number; trend: Trend };

// Flat dark pill: white name + green/red odds percent. Built from a
// Graphics rect + two Text objects so it stays crisp at any zoom (the scene
// counter-scales the whole container against camera zoom).
export function buildTagPill(scene: Phaser.Scene, contestant: TagPillData): Phaser.GameObjects.Container {
  const percentLabel = `${Math.round(contestant.odds * 100)}%`;
  const trendColor = contestant.trend === "up" ? "#4ecb71" : "#e0524f";

  const nameText = scene.add
    .text(0, 0, contestant.name.toUpperCase(), {
      fontFamily: "monospace",
      fontSize: "11px",
      color: "#f2f2ee",
      resolution: 2,
    })
    .setOrigin(0, 0.5);

  const pctText = scene.add
    .text(0, 0, percentLabel, {
      fontFamily: "monospace",
      fontSize: "11px",
      color: trendColor,
      resolution: 2,
    })
    .setOrigin(0, 0.5);

  const gap = 5;
  const padX = 5;
  const padY = 3;
  const totalW = nameText.width + gap + pctText.width;
  const totalH = Math.max(nameText.height, pctText.height);
  const startX = -totalW / 2;

  nameText.setPosition(startX, 0);
  pctText.setPosition(startX + nameText.width + gap, 0);

  const bg = scene.add.graphics();
  bg.fillStyle(0x141414, 0.82);
  bg.fillRect(startX - padX, -totalH / 2 - padY, totalW + padX * 2, totalH + padY * 2);

  const container = scene.add.container(0, 0, [bg, nameText, pctText]);
  container.setSize(totalW + padX * 2, totalH + padY * 2);
  return container;
}
