import { describe, it, expect } from "vitest";
import { PARTS, PART_ORDER, autonomy3On, partOn, partSwitch, jobsADay, paceWindow, dueByNow, hasTurn, worstDayUsd, JOBS_A_DAY, JOB_TOKENS } from "@/lib/autonomy3Policy";
import { startJob, finishJob, startedInWindow, mayStart, recentJobs, tick, onTick, autonomy3State } from "@/lib/autonomy3";

const DAY = 86_400_000;
const midnight = Date.UTC(2026, 9, 14);
const ALL_ON = { AUTONOMY3: "on", ...Object.fromEntries(PART_ORDER.map((p) => [partSwitch(p), "on"])) };

describe("autonomy 3: switches", () => {
  it("ships switched off: nothing is on until it is turned on", () => {
    expect(autonomy3On({})).toBe(false);
    for (const part of PART_ORDER) expect(partOn(part, {})).toBe(false);
  });

  it("needs both the update's switch and the part's own", () => {
    expect(partOn("test", { AUTONOMY3: "on" })).toBe(false);
    expect(partOn("test", { AUTONOMY3_TEST: "on" })).toBe(false);
    expect(partOn("test", { AUTONOMY3: "on", AUTONOMY3_TEST: " ON " })).toBe(true);
    expect(partOn("attack", { AUTONOMY3: "on", AUTONOMY3_TEST: "on" })).toBe(false);
  });

  it("has eleven parts, each with a name and a switch of its own", () => {
    expect(PART_ORDER).toHaveLength(11);
    expect(new Set(PART_ORDER.map(partSwitch)).size).toBe(11);
    for (const part of PART_ORDER) expect(PARTS[part].name.length).toBeGreaterThan(3);
  });
});

describe("autonomy 3: the fixed number of jobs a day", () => {
  it("gives only the parts that make model calls a number", () => {
    for (const part of PART_ORDER) {
      expect(jobsADay(part, {}) !== null).toBe(PARTS[part].spends);
      expect(Boolean(JOB_TOKENS[part])).toBe(PARTS[part].spends);
    }
    expect(jobsADay("test", {})).toBe(45);
    expect(jobsADay("rescue", {})).toBeNull();
  });

  it("takes a new number from the environment, and never one that would stop the part", () => {
    expect(jobsADay("test", { AUTONOMY3_TEST_A_DAY: "90" })).toBe(90);
    for (const bad of ["0", "-5", "none", "", "NaN"]) expect(jobsADay("test", { AUTONOMY3_TEST_A_DAY: bad })).toBe(JOBS_A_DAY.test);
  });

  it("spreads the day's jobs over the day, the first one at its start", () => {
    expect(dueByNow(45, midnight)).toBe(1);
    expect(dueByNow(45, midnight + DAY / 2)).toBe(23);
    expect(dueByNow(45, midnight + DAY - 1)).toBe(45);
    let last = 0;
    for (let h = 0; h < 24; h++) { const due = dueByNow(45, midnight + h * 3_600_000); expect(due).toBeGreaterThanOrEqual(last); last = due; }
  });

  it("counts a part with less than one job a day over as many days as one job takes", () => {
    const w = paceWindow(0.5, midnight + 5);
    expect(w.to - w.from).toBe(2 * DAY);
    expect(w.jobs).toBe(1);
    expect(dueByNow(0.5, w.from)).toBe(1);
    expect(dueByNow(0.5, w.to - 1)).toBe(1);
  });

  it("lets a part work until its jobs so far are started, and again the next day whatever happened today", () => {
    const env = { AUTONOMY3: "on", AUTONOMY3_TEST: "on" };
    expect(hasTurn("test", 0, midnight, env)).toBe(true);
    expect(hasTurn("test", 1, midnight, env)).toBe(false);
    expect(hasTurn("test", 45, midnight + DAY - 1, env)).toBe(false);
    expect(hasTurn("test", 0, midnight + DAY, env)).toBe(true); // a new day: the count starts over, nothing carries
    expect(hasTurn("test", 0, midnight, {})).toBe(false);
  });

  it("never holds back a part that costs nothing", () => {
    const env = { AUTONOMY3: "on", AUTONOMY3_RESCUE: "on" };
    expect(hasTurn("rescue", 0, midnight, env)).toBe(true);
    expect(hasTurn("rescue", 10_000, midnight, env)).toBe(true);
  });

  it("keeps a whole day, every part on at its token limits, near two dollars", () => {
    expect(worstDayUsd({})).toBeGreaterThan(1);
    expect(worstDayUsd({})).toBeLessThanOrEqual(2.2);
  });
});

describe("autonomy 3: the record of jobs", () => {
  it("opens a job, closes it, and counts it in the day", () => {
    const env = { AUTONOMY3: "on", AUTONOMY3_TEST: "on" };
    expect(startedInWindow("test", midnight + 1000, env)).toBe(0);
    expect(mayStart("test", midnight + 1000, env)).toBe(true);
    const id = startJob("test", "agent-a", midnight + 1000)!;
    expect(id).toBeTruthy();
    expect(startedInWindow("test", midnight + 2000, env)).toBe(1);
    expect(mayStart("test", midnight + 2000, env)).toBe(false); // the second job of 45 is due about half an hour in
    expect(mayStart("test", midnight + 3_600_000, env)).toBe(true);
    finishJob(id, { outcome: "passed", summary: "answered a small job correctly", detail: { score: 9 }, costUsd: 0.012 }, midnight + 5000);
    const [job] = recentJobs(5, "test");
    expect(job).toMatchObject({ id, part: "test", subject: "agent-a", outcome: "passed", detail: { score: 9 }, costUsd: 0.012 });
    expect(job.finishedAt).toBe(new Date(midnight + 5000).toISOString());
    expect(startedInWindow("test", midnight + DAY + 1, env)).toBe(0); // yesterday's jobs do not count today
  });

  it("shows every part, what is on, and what today cost", () => {
    const day = midnight + 10 * DAY; // a day of its own: the record is shared by the tests in this file
    const id = startJob("attack", "agent-b", day + 1000)!;
    finishJob(id, { outcome: "held", costUsd: 0.02 }, day + 2000);
    const s = autonomy3State(day + 3000, { AUTONOMY3: "on", AUTONOMY3_ATTACK: "on" });
    expect(s.on).toBe(true);
    expect(s.parts).toHaveLength(11);
    expect(s.parts.find((p) => p.part === "attack")).toMatchObject({ on: true, aDay: 20, started: 1, dueByNow: 1 });
    expect(s.parts.find((p) => p.part === "test")).toMatchObject({ on: false, started: 0 });
    expect(s.parts.find((p) => p.part === "rescue")).toMatchObject({ aDay: null, dueByNow: null });
    expect(s.spentTodayUsd).toBeCloseTo(0.02, 5);
    expect(s.jobs[0]).toMatchObject({ id, outcome: "held" });
  });
});

describe("autonomy 3: the tick", () => {
  it("does nothing while the update is off", async () => {
    let ran = 0;
    onTick("watch", async () => { ran++; });
    expect(await tick(midnight, {})).toEqual({ on: false, ran: [], failed: [] });
    expect(ran).toBe(0);
  });

  it("runs the parts that are switched on, and one that fails does not stop the others", async () => {
    const seen: string[] = [];
    onTick("rescue", async () => { throw new Error("no database"); });
    onTick("watch", async () => { seen.push("watch"); });
    onTick("react", async () => { seen.push("react"); });
    const r = await tick(midnight, { AUTONOMY3: "on", AUTONOMY3_RESCUE: "on", AUTONOMY3_WATCH: "on" });
    expect(seen).toEqual(["watch"]);
    expect(r.ran).toEqual(["watch"]);
    expect(r.failed).toEqual([{ part: "rescue", reason: "no database" }]);
    expect((await tick(midnight, ALL_ON)).ran).toEqual(["watch", "react"]);
  });
});
