import Phaser from "phaser";
import { islandFlags } from "@/lib/islandFlags";

export type CameraControllerOptions = {
  worldWidth: number;
  worldHeight: number;
  // Multiplier applied to the raw contain-fit. Values above 1 let maps with
  // generous water padding fill more of the viewport while keeping the
  // playable island visible.
  fitScale?: number;
  // Screen-space pixels along the right edge covered by opaque chrome (the
  // desktop markets panel). Re-read on every fit/center so a viewport that
  // crosses the mobile<->desktop breakpoint updates live. The fit view then
  // sizes and centers the island within the *visible* play area
  // (viewport minus this inset) instead of sliding it under the panel.
  getRightInset?: () => number;
  // Screen-space pixels along the left edge covered by opaque chrome. Unlike
  // the right inset this is not modeled at the fit rung -- it only matters
  // while following (GUARD 2b), because the Follow control lives in the
  // ContestantPanel, so that panel is open for the entire time a follow is
  // active. Callers that never follow, or that have no left chrome, can omit
  // this and get today's un-inset behavior.
  getLeftInset?: () => number;
  // Screen-space pixels along the bottom edge covered by opaque chrome (the
  // ConversationPanel, bottom-left). Same GUARD 2b reasoning as the left
  // inset: only consulted while following.
  getBottomInset?: () => number;
};

// A follow target reports its own world position every frame, plus an
// optional pad -- the half-extent, in world units, of whatever must stay in
// frame around it (for a two-person interaction, that's the pair's spread
// plus their speech bubbles). pad drives the pad-aware framing rung picker;
// omitting it just follows at the requested (or default) rung.
export type CameraFollowTarget = { x: number; y: number; pad?: number };

export type CameraControllerHandle = {
  // Start (or retarget) following. getTarget is polled once per update() so
  // the caller can hand over a live accessor (e.g. "wherever contestant X is
  // right now") rather than a snapshot. Returning null from it ends the
  // follow, same as calling stop(). opts.zoomRung is a zoom multiplier (e.g.
  // 2 for the 2x rung), not a ladder index -- it's snapped to the nearest
  // real rung. Ignored (a no-op) when islandFlags.followCamera is off.
  follow: (
    getTarget: () => CameraFollowTarget | null,
    opts?: { zoomRung?: number },
  ) => void;
  // Release follow without changing the current view. Also happens
  // automatically on any user pan/zoom gesture (GUARD 3) and when getTarget
  // returns null (e.g. the followed islander died and was removed).
  stop: () => void;
  isFollowing: () => boolean;
  // Advance the follow lerp by one frame. A no-op when not following, so it
  // is always safe to call from the scene's own update() loop.
  update: () => void;
};

// The camera's minimum zoom is always "fit the whole island" -- computed
// fresh from the current viewport size, not a fixed constant -- so it works
// down to a 390px phone as well as a wide desktop window. Above that, zoom
// steps through fixed 1x/2x/3x/4x rungs (crisp pixel-art multiples). If the
// fit level is already >= 1x (a huge viewport, tiny world) there's nothing
// smaller to offer, so the ladder collapses to just the fixed rungs.
function computeFitZoom(
  viewportW: number,
  viewportH: number,
  worldW: number,
  worldH: number,
  fitScale: number,
): number {
  if (viewportW <= 0 || viewportH <= 0 || worldW <= 0 || worldH <= 0) return 1;
  return Math.min(1, Math.min(viewportW / worldW, viewportH / worldH) * fitScale);
}

function buildLadder(fitZoom: number): number[] {
  return fitZoom < 0.999 ? [fitZoom, 1, 2, 3, 4] : [1, 2, 3, 4];
}

function nearestRung(ladder: number[], zoom: number): number {
  let best = 0;
  let bestDist = Infinity;
  ladder.forEach((z, i) => {
    const d = Math.abs(z - zoom);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  });
  return best;
}

// Desktop: mouse drag to pan, wheel to zoom. Touch: one-finger drag to pan,
// two-finger pinch to zoom. Zoom steps through a discrete ladder whose floor
// is "fit the whole island"; at that floor the view stays centered on the
// island and ignores pan. Zoom always homes in on the pointer / pinch
// midpoint. On viewport resize: re-fit (and re-center) if the camera was at
// the fit rung, otherwise keep the same world point under the screen center.
//
// Also owns an optional follow mode (islandFlags.followCamera): the returned
// handle lets a caller lock the camera onto a moving world point, framed
// inside whatever chrome insets it's given, until a user gesture or the
// caller releases it. See the follow()/stop()/update() docs above.
export function createCameraController(
  scene: Phaser.Scene,
  camera: Phaser.Cameras.Scene2D.Camera,
  opts: CameraControllerOptions,
): CameraControllerHandle {
  const { worldWidth, worldHeight } = opts;
  const fitScale = Math.max(1, opts.fitScale ?? 1);
  const rightInset = () => Math.max(0, opts.getRightInset?.() ?? 0);
  const leftInset = () => Math.max(0, opts.getLeftInset?.() ?? 0);
  const bottomInset = () => Math.max(0, opts.getBottomInset?.() ?? 0);
  // Width of the visible play area (viewport minus the right-edge chrome).
  const visibleWidth = () => Math.max(1, camera.width - rightInset());

  let ladder = buildLadder(
    computeFitZoom(visibleWidth(), camera.height, worldWidth, worldHeight, fitScale),
  );
  let rung = 0;
  let isAtFit = true;

  function centerOnIsland(): void {
    // Phaser's scroll clamp mixes world and viewport units when the world is
    // smaller than the view (fit zoom < 1), which pins the island off-center.
    // Pan is ignored at the fit rung anyway, so drop the bounds there and
    // restore them for the zoomed-in rungs (setRung does that).
    camera.useBounds = false;
    // Shift the world point that lands at screen-center right by half the
    // inset (in world units), so the island's own center ends up centered in
    // the visible area to the left of the panel rather than under it.
    camera.centerOn(worldWidth / 2 + rightInset() / (2 * camera.zoom), worldHeight / 2);
  }

  function applyFit(): void {
    ladder = buildLadder(
      computeFitZoom(visibleWidth(), camera.height, worldWidth, worldHeight, fitScale),
    );
    rung = 0;
    isAtFit = true;
    camera.setZoom(ladder[0]);
    centerOnIsland();
  }

  // Zoom must be set before centering: the scroll clamp is zoom-aware
  // (displayWidth = width / zoom), so centering at the wrong zoom can clamp
  // the scroll and leave the view off-center once zoom changes.
  applyFit();

  let isDragging = false;
  let dragPointerId = -1;
  let lastX = 0;
  let lastY = 0;

  let pinchActive = false;
  let pinchStartDist = 0;
  let pinchStartZoom = camera.zoom;

  let lastWheelAt = 0;

  // --- Follow state (GUARDs 1-4 and the pad-aware framing mode) ---------
  let following = false;
  let followGetTarget: (() => CameraFollowTarget | null) | null = null;
  let followRungIndex = 0;
  // The world point the camera is currently lerping toward the live target
  // -- separate from the target itself so motion is smoothed rather than
  // snapping to a new sample every frame.
  let followLerpX = 0;
  let followLerpY = 0;
  const FOLLOW_LERP = 0.18;

  function stopFollow(): void {
    following = false;
    followGetTarget = null;
  }

  // Same inset trick as centerOnIsland (see cameraController.ts comment
  // above it), generalized to all four edges: shifts the world point that
  // lands at screen-center so `tx, ty` ends up centered in the box left of
  // the right inset, right of the left inset, and above the bottom inset
  // (GUARD 2 and GUARD 2b). Top chrome isn't modeled -- nothing sits there
  // today -- so there's no corresponding upward shift.
  function centerOnFollowTarget(tx: number, ty: number): void {
    camera.centerOn(
      tx + (rightInset() - leftInset()) / (2 * camera.zoom),
      ty + bottomInset() / (2 * camera.zoom),
    );
  }

  // Highest ladder rung whose visible play area (viewport minus all three
  // modeled insets) still contains a box of half-extent `pad` around the
  // target, so a two-person interaction and their speech bubbles are never
  // clipped. Falls back to the fit rung (index 0) if even the widest view
  // can't fit the box -- better to show the whole island than to guess.
  function pickFramedRung(pad: number): number {
    const availW = Math.max(1, camera.width - rightInset() - leftInset());
    const availH = Math.max(1, camera.height - bottomInset());
    const maxZoom = Math.min(availW, availH) / (2 * Math.max(1, pad));
    let best = 0;
    for (let i = 0; i < ladder.length; i++) {
      if (ladder[i] <= maxZoom) best = i;
    }
    return best;
  }

  function zoomAt(newZoom: number, screenX: number, screenY: number): void {
    const clamped = Phaser.Math.Clamp(newZoom, ladder[0], ladder[ladder.length - 1]);
    if (clamped === camera.zoom) return;
    const before = camera.getWorldPoint(screenX, screenY);
    camera.setZoom(clamped);
    const after = camera.getWorldPoint(screenX, screenY);
    camera.scrollX += before.x - after.x;
    camera.scrollY += before.y - after.y;
  }

  function setRung(newRung: number, screenX: number, screenY: number): void {
    const clamped = Phaser.Math.Clamp(newRung, 0, ladder.length - 1);
    if (clamped === rung) return;
    rung = clamped;
    isAtFit = rung === 0;
    // GUARD 1: the fit rung hard-recenters on the island and ignores pan
    // (see centerOnIsland / the pointermove drag guard below), so following
    // would be impossible by construction while isAtFit stays true. Once
    // this rung is non-fit, useBounds flips on and pan/follow both work.
    if (!isAtFit) camera.useBounds = true;
    zoomAt(ladder[rung], screenX, screenY);
    if (isAtFit) centerOnIsland();
  }

  function activePointers(): Phaser.Input.Pointer[] {
    return input.manager.pointers.filter((p) => p.active && p.isDown);
  }

  const input = scene.input;
  input.addPointer(2); // pointer1 (mouse/touch) + 2 more for pinch gestures

  input.on(
    "wheel",
    (pointer: Phaser.Input.Pointer, _objects: unknown, _dx: number, dy: number) => {
      if (pinchActive) return;
      const now = scene.time.now;
      if (now - lastWheelAt < 90) return;
      lastWheelAt = now;
      // GUARD 3: a wheel zoom is a user gesture and wins over follow.
      stopFollow();
      const dir = dy > 0 ? -1 : 1;
      setRung(rung + dir, pointer.x, pointer.y);
    },
  );

  input.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
    const active = activePointers();
    if (active.length >= 2) {
      // GUARD 3: a pinch start is a user gesture and wins over follow.
      stopFollow();
      const [p1, p2] = active;
      pinchActive = true;
      isDragging = false;
      pinchStartDist = Math.max(1, Phaser.Math.Distance.Between(p1.x, p1.y, p2.x, p2.y));
      pinchStartZoom = camera.zoom;
    } else if (!pinchActive) {
      // GUARD 3: a drag start is a user gesture and wins over follow.
      stopFollow();
      isDragging = true;
      dragPointerId = pointer.id;
      lastX = pointer.x;
      lastY = pointer.y;
    }
  });

  input.on("pointermove", (pointer: Phaser.Input.Pointer) => {
    const active = activePointers();

    if (active.length >= 2) {
      // GUARD 3: covers the case where the second finger lands inside a
      // move event rather than its own pointerdown. Idempotent once
      // following is already false.
      stopFollow();
      const [p1, p2] = active;
      pinchActive = true;
      isDragging = false;
      const dist = Math.max(1, Phaser.Math.Distance.Between(p1.x, p1.y, p2.x, p2.y));
      const midX = (p1.x + p2.x) / 2;
      const midY = (p1.y + p2.y) / 2;
      const ratio = dist / pinchStartDist;
      const target = Phaser.Math.Clamp(pinchStartZoom * ratio, ladder[0], ladder[ladder.length - 1]);
      rung = nearestRung(ladder, target);
      isAtFit = rung === 0;
      zoomAt(target, midX, midY);
      if (isAtFit) centerOnIsland();
      return;
    }

    if (isDragging && pointer.id === dragPointerId && pointer.isDown) {
      if (isAtFit) return; // fit level ignores pan and stays centered on the island
      const dx = (pointer.x - lastX) / camera.zoom;
      const dy = (pointer.y - lastY) / camera.zoom;
      camera.scrollX -= dx;
      camera.scrollY -= dy;
      lastX = pointer.x;
      lastY = pointer.y;
    }
  });

  function endGesture(): void {
    isDragging = false;
    dragPointerId = -1;
    if (activePointers().length < 2) {
      if (pinchActive) {
        // A freeform pinch can leave the zoom off-ladder; snap to the
        // nearest rung so wheel/pinch stay in lockstep afterward.
        rung = nearestRung(ladder, camera.zoom);
        isAtFit = rung === 0;
        zoomAt(ladder[rung], scene.scale.width / 2, scene.scale.height / 2);
        if (isAtFit) centerOnIsland();
      }
      pinchActive = false;
    }
  }

  input.on("pointerup", endGesture);
  input.on("pointerupoutside", endGesture);
  input.on("pointercancel", endGesture);

  // A container resize keeps scrollX/scrollY (the top-left corner), which
  // shifts what the viewer sees toward the map's northwest. At the fit rung,
  // just re-fit to the new viewport and re-center on the island. Zoomed in,
  // re-center on the world point that was mid-screen before the resize --
  // the view center is scroll + viewport/2 regardless of zoom (Phaser's
  // midPoint math), and the camera itself has already been resized when
  // this handler runs, so the pre-resize viewport size is tracked here.
  let prevW = scene.scale.width;
  let prevH = scene.scale.height;
  const onResize = () => {
    // GUARD 4: while following, update() re-centers on the followed target
    // every frame anyway, so either branch below would just fight it for
    // one frame. Still rebuild the ladder (insets can change across the
    // mobile<->desktop breakpoint) so the next follow-driven setRung call
    // sees the right rung set, but don't touch rung or scroll here.
    if (following) {
      ladder = buildLadder(
        computeFitZoom(visibleWidth(), camera.height, worldWidth, worldHeight, fitScale),
      );
      prevW = scene.scale.width;
      prevH = scene.scale.height;
      return;
    }
    if (isAtFit) {
      applyFit();
    } else {
      const centerX = camera.scrollX + prevW / 2;
      const centerY = camera.scrollY + prevH / 2;
      ladder = buildLadder(
        computeFitZoom(visibleWidth(), camera.height, worldWidth, worldHeight, fitScale),
      );
      rung = nearestRung(ladder, camera.zoom);
      camera.centerOn(centerX, centerY);
    }
    prevW = scene.scale.width;
    prevH = scene.scale.height;
  };
  scene.scale.on(Phaser.Scale.Events.RESIZE, onResize);
  const releaseResizeListener = () => scene.scale?.off(Phaser.Scale.Events.RESIZE, onResize);
  // Whole-game teardown (React Strict Mode and HMR) emits DESTROY directly;
  // scene.stop/restart emits SHUTDOWN. Cover both lifecycle paths so an old
  // controller cannot retain a Phaser scale manager after its scene is gone.
  scene.events.once(Phaser.Scenes.Events.SHUTDOWN, releaseResizeListener);
  scene.events.once(Phaser.Scenes.Events.DESTROY, releaseResizeListener);

  function follow(
    getTarget: () => CameraFollowTarget | null,
    followOpts?: { zoomRung?: number },
  ): void {
    // Gated behind the master switch: with the flag off this whole handle
    // behaves exactly as it does today, which for follow() means "does
    // nothing at all".
    if (!islandFlags.followCamera) return;
    const t = getTarget();
    if (!t) return;
    followGetTarget = getTarget;
    following = true;
    const requestedZoom = followOpts?.zoomRung ?? 2; // default: the 2x rung
    followRungIndex = t.pad != null ? pickFramedRung(t.pad) : nearestRung(ladder, requestedZoom);
    // GUARD 1: land on a non-fit rung before the first center so pan/bounds
    // are already live (setRung flips useBounds on for rung > 0) and the
    // fit rung's hard-recenter-on-island never fires while following.
    setRung(followRungIndex, camera.width / 2, camera.height / 2);
    followLerpX = t.x;
    followLerpY = t.y;
    centerOnFollowTarget(followLerpX, followLerpY);
  }

  function stop(): void {
    stopFollow();
  }

  function isFollowing(): boolean {
    return following;
  }

  function update(): void {
    if (!following || !followGetTarget) return;
    const t = followGetTarget();
    if (!t) {
      // The target vanished (e.g. the followed islander died and was
      // removed) -- release follow rather than lerping toward stale data.
      stopFollow();
      return;
    }
    // Re-pick the framed rung every frame so a pair drifting apart (or
    // together) keeps their padded box in view; a fixed requested rung
    // never changes here, so this is a no-op cost-wise when pad is absent.
    if (t.pad != null) {
      const idx = pickFramedRung(t.pad);
      if (idx !== rung) setRung(idx, camera.width / 2, camera.height / 2);
    }
    followLerpX += (t.x - followLerpX) * FOLLOW_LERP;
    followLerpY += (t.y - followLerpY) * FOLLOW_LERP;
    // Clamp to world bounds so following near the map edge never shows void
    // past it -- half the visible world extent at the current zoom, same
    // math the scroll clamp itself would apply.
    const halfVisW = visibleWidth() / (2 * camera.zoom);
    const halfVisH = camera.height / (2 * camera.zoom);
    const cx =
      halfVisW * 2 >= worldWidth
        ? worldWidth / 2
        : Phaser.Math.Clamp(followLerpX, halfVisW, worldWidth - halfVisW);
    const cy =
      halfVisH * 2 >= worldHeight
        ? worldHeight / 2
        : Phaser.Math.Clamp(followLerpY, halfVisH, worldHeight - halfVisH);
    centerOnFollowTarget(cx, cy);
  }

  return { follow, stop, isFollowing, update };
}
