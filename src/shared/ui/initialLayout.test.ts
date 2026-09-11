import { expect, it, vi } from "vitest";
import { afterInitialLayout, currentLayoutRead, trackInitialRead } from "./initialLayout";

function scheduler() {
  let id = 0;
  const frames = new Map<number, FrameRequestCallback>();
  return {
    frame: (callback: FrameRequestCallback) => { frames.set(++id, callback); return id; },
    cancel: (key: number) => { frames.delete(key); },
    paint: () => { const queued = [...frames.values()]; frames.clear(); queued.forEach(callback => callback(0)); },
  };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}

it("allows a new page to open while an older page still has a pending read", async () => {
  const clock = scheduler();
  const ready = vi.fn();
  const old = deferred(), own = deferred();
  const olderRead = trackInitialRead(() => old.promise);
  const afterRead = currentLayoutRead();
  const ownRead = trackInitialRead(() => own.promise);
  afterInitialLayout(ready, clock.frame, clock.cancel, afterRead);
  clock.paint(); clock.paint(); expect(ready).not.toHaveBeenCalled();
  own.resolve(); await ownRead; clock.paint(); clock.paint();
  expect(ready).toHaveBeenCalledOnce();
  old.resolve(); await olderRead;
});

it("waits for reordered and dependent reads before revealing the initial surface", async () => {
  const clock = scheduler();
  const ready = vi.fn();
  const first = deferred(), second = deferred(), dependent = deferred();
  const a = trackInitialRead(() => first.promise);
  const b = trackInitialRead(() => second.promise);
  afterInitialLayout(ready, clock.frame, clock.cancel);
  second.resolve(); await b; clock.paint(); clock.paint();
  expect(ready).not.toHaveBeenCalled();
  first.resolve(); await a; clock.paint();
  const c = trackInitialRead(() => dependent.promise);
  clock.paint(); expect(ready).not.toHaveBeenCalled();
  dependent.resolve(); await c; clock.paint(); clock.paint();
  expect(ready).toHaveBeenCalledOnce();
  await trackInitialRead(() => Promise.resolve()); clock.paint(); clock.paint();
  expect(ready).toHaveBeenCalledOnce();
});

it("allows an error surface to appear and disposes unmounted observers", async () => {
  const clock = scheduler();
  const ready = vi.fn(), unmounted = vi.fn();
  const read = trackInitialRead(() => Promise.reject(new Error("read failed")));
  afterInitialLayout(ready, clock.frame, clock.cancel);
  const dispose = afterInitialLayout(unmounted, clock.frame, clock.cancel);
  dispose();
  await expect(read).rejects.toThrow("read failed"); clock.paint(); clock.paint();
  expect(ready).toHaveBeenCalledOnce();
  expect(unmounted).not.toHaveBeenCalled();
});
