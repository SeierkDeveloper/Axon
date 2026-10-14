import { describe, it, expect } from "vitest";
import { startJob, finishJob } from "@/lib/autonomy3";
import { autonomy3Public } from "@/lib/autonomy3Public";

const DAY = 86_400_000;
const t0 = Date.UTC(2026, 9, 20);
let n = 0;
const job = (part: Parameters<typeof startJob>[0], outcome: string, at: number) => { const id = startJob(part, `secret-agent-id-${n++}`, at)!; finishJob(id, { outcome, summary: "Secret Agent did a thing", costUsd: 0.5 }, at + 1000); };

describe("autonomy 3 on the public page", () => {
  it("counts each part's jobs in plain words, for the last day and since it started", () => {
    job("rescue", "moved", t0 - 2 * DAY);
    job("rescue", "moved", t0 - 1000);
    job("test", "passed", t0 - 5000);
    job("test", "failed", t0 - 4000);
    job("test", "weak", t0 - 3 * DAY);
    job("attack", "held", t0 - 2000);
    job("judge", "second-won", t0 - 3000);
    const s = autonomy3Public(t0, { AUTONOMY3: "on", AUTONOMY3_RESCUE: "on", AUTONOMY3_TEST: "on" });
    const part = (p: string) => s.parts.find((x) => x.part === p)!;
    expect(s.parts).toHaveLength(11);
    expect(part("rescue")).toMatchObject({ on: true, main: { day: 1, all: 2 } });
    expect(part("test").main).toMatchObject({ day: 2, all: 3 });
    expect(part("test").more).toEqual([{ label: "passed", day: 1, all: 1 }, { label: "taken out of routing", day: 1, all: 1 }]);
    expect(part("attack")).toMatchObject({ on: false, main: { day: 1, all: 1 } });
    expect(part("judge").more[0]).toMatchObject({ all: 1 });
    expect(s.jobsAll).toBe(7);
    expect(s.jobsDay).toBe(5);
  });

  it("says nothing about which agent, what was said or what it cost", () => {
    const text = JSON.stringify(autonomy3Public(t0, {}));
    expect(text).not.toContain("secret-agent-id");
    expect(text).not.toContain("Secret Agent");
    expect(text).not.toMatch(/cost|usd|\$/i);
  });
});
