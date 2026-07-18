import assert from "node:assert/strict";
import { test } from "node:test";
import { getOnboarding, getRoom, setOnboarding, setRoom } from "./onboarding";

function withWindow(value: unknown, run: () => void): void {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value });
  try {
    run();
  } finally {
    if (original) Object.defineProperty(globalThis, "window", original);
    else Reflect.deleteProperty(globalThis, "window");
  }
}

test("storage-denied browsers fall back without throwing", () => {
  const deniedStorage = {
    getItem: () => {
      throw new DOMException("blocked", "SecurityError");
    },
    setItem: () => {
      throw new DOMException("blocked", "SecurityError");
    },
  };

  withWindow({ localStorage: deniedStorage }, () => {
    assert.equal(getRoom(), "MAIN");
    assert.equal(getOnboarding(), null);
    assert.doesNotThrow(() => setRoom("ABCDE"));
    assert.doesNotThrow(() => setOnboarding({ name: "Alex", phone: "5551234567" }));
  });
});

test("room and onboarding values still round-trip through normal storage", () => {
  const values = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };

  withWindow({ localStorage }, () => {
    setRoom("ABCDE");
    setOnboarding({ name: "Alex", phone: "5551234567" });
    assert.equal(getRoom(), "ABCDE");
    assert.deepEqual(getOnboarding(), { name: "Alex", phone: "5551234567" });
  });
});
