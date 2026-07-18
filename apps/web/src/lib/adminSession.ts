"use client";

import { useSyncExternalStore } from "react";

const KEY_STORAGE = "arena.operatorKey";
const listeners = new Set<() => void>();

function readAdminKey(): string {
  // Only a key that /admin has validated and explicitly persisted counts.
  // Supplying the development default here made every localhost viewer send a
  // valid operator key from the public Games menu, which exposed every room.
  return window.localStorage.getItem(KEY_STORAGE) ?? "";
}

function readHasAdminSession(): boolean {
  return Boolean(window.localStorage.getItem(KEY_STORAGE)?.trim());
}

export function setAdminKey(value: string): void {
  if (window.localStorage.getItem(KEY_STORAGE) === value) return;
  window.localStorage.setItem(KEY_STORAGE, value);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// A validated key is persisted by /admin and then reused by the Games menu.
// The server still re-validates it for every room-list and admin command.
export function useAdminKey(): string {
  return useSyncExternalStore(subscribe, readAdminKey, () => "");
}

// Unlike useAdminKey's localhost convenience default, this becomes true only
// after /admin has validated and persisted a key. It is safe for presentation
// decisions such as skipping first-visit onboarding; every privileged request
// remains independently authorized by the server.
export function useHasAdminSession(): boolean {
  return useSyncExternalStore(subscribe, readHasAdminSession, () => false);
}
