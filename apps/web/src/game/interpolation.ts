import { TICK_MS } from "@arena/shared";

// Position interpolation buffer (task 3.4): the socket layer pushes every
// contestant's tick-diff position stamped with the client receive time; the
// Phaser scene renders one tick in the past and lerps between the samples
// that bracket that moment. Client receive time (not the diff's server t)
// keys the buffer so clock skew between machines is irrelevant.
//
// Plain module singleton, not React state: samples arrive at ~6.7 Hz per
// contestant and are read every animation frame -- neither belongs in a
// React render cycle.

// One tick is enough to bracket ordinary network jitter without making live
// conversation/fight events appear detached from sprites by a full 300 ms.
export const RENDER_DELAY_MS = TICK_MS;

// A sprite is "moving" when its bracketing samples are meaningfully apart;
// beyond this idle window with no fresh sample it is standing still.
const IDLE_AFTER_MS = 2.5 * TICK_MS;
const MOVE_EPSILON_PX = 0.5;
const MAX_SAMPLES = 24;

type Sample = { t: number; x: number; y: number };

const buffers = new Map<string, Sample[]>();

export function pushSample(id: string, x: number, y: number): void {
  let buf = buffers.get(id);
  if (!buf) {
    buf = [];
    buffers.set(id, buf);
  }
  buf.push({ t: Date.now(), x, y });
  if (buf.length > MAX_SAMPLES) buf.splice(0, buf.length - MAX_SAMPLES);
}

// Snapshot/join positions enter as ordinary samples so a sprite has
// somewhere to stand before its first tick diff.
export function seedPosition(id: string, x: number, y: number): void {
  buffers.set(id, [{ t: Date.now(), x, y }]);
}

export function forget(id: string): void {
  buffers.delete(id);
}

export function clearAll(): void {
  buffers.clear();
}

export type InterpolatedPosition = { x: number; y: number; moving: boolean };

export function samplePosition(id: string, renderTime: number): InterpolatedPosition | null {
  const buf = buffers.get(id);
  if (!buf || buf.length === 0) return null;

  const last = buf[buf.length - 1];
  if (renderTime >= last.t) {
    // Past the newest sample: hold position; still "moving" only if that
    // sample is fresh enough that the next one is presumably in flight.
    return { x: last.x, y: last.y, moving: Date.now() - last.t < IDLE_AFTER_MS };
  }
  if (renderTime <= buf[0].t) {
    return { x: buf[0].x, y: buf[0].y, moving: false };
  }

  for (let i = buf.length - 2; i >= 0; i--) {
    const a = buf[i];
    if (a.t > renderTime) continue;
    const b = buf[i + 1];
    const span = b.t - a.t;
    const f = span > 0 ? (renderTime - a.t) / span : 1;
    const moving = Math.hypot(b.x - a.x, b.y - a.y) > MOVE_EPSILON_PX;
    return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, moving };
  }
  return { x: last.x, y: last.y, moving: false };
}
