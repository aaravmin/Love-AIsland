"use client";

import dynamic from "next/dynamic";

// This screen's very first render decision (redirect to /join, or show the
// form) depends on localStorage onboarding data that doesn't exist during
// SSR. Rendering it only ever client-side (mirroring src/game/GameCanvas.tsx's
// ssr:false pattern for Phaser) sidesteps the hydration-mismatch/resync race
// entirely instead of fighting it with useSyncExternalStore: on a hard
// navigation straight to /create, an effect-driven redirect based on a
// server-null snapshot can fire before React resyncs to the real client
// value, sending a fully-onboarded visitor back to /join.
const CreateForm = dynamic(() => import("./create-form"), { ssr: false });

export function CreateCanvas() {
  return <CreateForm />;
}
