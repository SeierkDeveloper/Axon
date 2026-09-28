// The worker starts tasks and moves on (src/workers/inflight.ts), and Turso syncs are coalesced
// (src/lib/db-turso.ts). Both exist so one slow thing never holds up everything behind it.

import { describe, it, expect, afterEach } from "vitest";
import { launch, drain, inFlightCount, isInFlight } from "../workers/inflight";
import { syncToTurso, __setTursoClientForTest } from "@/lib/db-turso";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

describe("in-flight tasks", () => {
  it("starts a task without waiting for it, and forgets it once it ends", async () => {
    const slow = deferred();
    let fastRan = false;
    expect(launch("slow", () => slow.promise)).toBe(true);
    expect(launch("fast", async () => { fastRan = true; })).toBe(true);
    await drain(50); // the fast one finishes while the slow one is still running
    expect(fastRan).toBe(true);
    expect(isInFlight("slow")).toBe(true);
    expect(isInFlight("fast")).toBe(false);
    slow.resolve();
    expect(await drain(1000)).toBe("done");
    expect(inFlightCount()).toBe(0);
  });

  it("never runs the same task twice at once", async () => {
    const d = deferred();
    let runs = 0;
    launch("once", async () => { runs++; await d.promise; });
    expect(launch("once", async () => { runs++; })).toBe(false);
    d.resolve();
    await drain(1000);
    expect(runs).toBe(1);
  });

  it("a task that throws is contained and removed", async () => {
    launch("boom", async () => { throw new Error("boom"); });
    expect(await drain(1000)).toBe("done");
    expect(isInFlight("boom")).toBe(false);
  });

  it("drain gives up after its timeout while a task is still running", async () => {
    const d = deferred();
    launch("stuck", () => d.promise);
    expect(await drain(20)).toBe("timeout");
    d.resolve();
    await drain(1000);
  });
});

describe("Turso sync coalescing", () => {
  afterEach(() => __setTursoClientForTest(null));

  it("folds calls made during a sync into one follow-up, and never runs two at once", async () => {
    let active = 0, maxActive = 0, calls = 0;
    const gates: (() => void)[] = [];
    __setTursoClientForTest({
      sync: async () => {
        calls++; active++; maxActive = Math.max(maxActive, active);
        await new Promise<void>((r) => gates.push(r));
        active--;
        return undefined as never;
      },
    });
    const first = syncToTurso();
    const rest = Array.from({ length: 10 }, () => syncToTurso());
    expect(calls).toBe(1);
    gates.shift()!();
    await first;
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toBe(2); // ten callers, one follow-up
    gates.shift()!();
    await Promise.all(rest);
    expect(maxActive).toBe(1);
  });

  it("does nothing without a client", async () => {
    await expect(syncToTurso()).resolves.toBeUndefined();
  });
});
