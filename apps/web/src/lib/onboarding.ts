// Onboarding persistence for the /join -> /create flow. Two separate keys,
// matching how the data arrives: the room code is known as soon as the QR
// link resolves, the {name, email} pair only exists once the join form is
// submitted.
const ROOM_KEY = "arena.room";
const ONBOARDING_KEY = "arena.onboarding";

export type Onboarding = { name: string; phone: string };

export function getRoom(): string {
  if (typeof window === "undefined") return "MAIN";
  return window.localStorage.getItem(ROOM_KEY) || "MAIN";
}

export function setRoom(room: string): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(ROOM_KEY, room);
}

export function getOnboarding(): Onboarding | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(ONBOARDING_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<Onboarding>;
    if (typeof parsed.name !== "string" || typeof parsed.phone !== "string") return null;
    return { name: parsed.name, phone: parsed.phone };
  } catch {
    return null;
  }
}

export function setOnboarding(data: Onboarding): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(ONBOARDING_KEY, JSON.stringify(data));
}
