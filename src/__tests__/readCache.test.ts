import { describe, it, expect, beforeEach } from "vitest";
import { cachedRead, clearReadCache } from "@/lib/readCache";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => clearReadCache());

describe("cachedRead", () => {
  it("serves everyone in the window from one read", async () => {
    let reads = 0;
    const load = async () => { reads++; await tick(20); return reads; };
    const answers = await Promise.all([1, 2, 3, 4, 5].map(() => cachedRead("k", 1_000, load)));
    expect(answers).toEqual([1, 1, 1, 1, 1]);
    expect(await cachedRead("k", 1_000, load)).toBe(1);
    expect(reads).toBe(1);
  });

  it("answers a stale value at once and refreshes behind it", async () => {
    let n = 0;
    const load = async () => ++n;
    expect(await cachedRead("s", 10, load)).toBe(1);
    await tick(20);
    expect(await cachedRead("s", 10, load)).toBe(1); // stale, answered at once
    await tick(5);
    expect(await cachedRead("s", 10, load)).toBe(2); // the refresh landed
  });

  it("never stores a failure: the last good value stays", async () => {
    let fail = false;
    const load = async () => { if (fail) throw new Error("node down"); return "good"; };
    expect(await cachedRead("f", 10, load)).toBe("good");
    fail = true;
    await tick(20);
    expect(await cachedRead("f", 10, load)).toBe("good"); // stale but true
    await tick(5);
    expect(await cachedRead("f", 10, load)).toBe("good");
  });

  it("with nothing good to show, a caller waits for a fresh read, and a failure reaches it", async () => {
    await expect(cachedRead("e", 10, async () => { throw new Error("down"); })).rejects.toThrow("down");
    expect(await cachedRead("e", 10, async () => "up")).toBe("up");
  });
});
