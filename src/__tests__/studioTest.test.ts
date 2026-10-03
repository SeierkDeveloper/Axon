import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/embeddings", async (orig) => ({
  ...(await orig<typeof import("@/lib/embeddings")>()),
  generateEmbedding: async () => null,
  embedQuery: async () => null,
  semanticSearchAgents: async () => null,
}));
vi.mock("@/lib/holderTier", async (orig) => ({
  ...(await orig<typeof import("@/lib/holderTier")>()),
  getTier: async () => ({ tier: { name: "operator", minimum: 0, rank: 3 }, balance: 0, stale: false }),
}));

import { startDraft, getBuild, tweakDraft, tweaksOf } from "@/lib/studioDraft";
import { runBuild, roundsOf, settleStale, parseTasks, parseGrade, parseRewrite, type Models } from "@/lib/studioTest";
import { getDb } from "@/lib/db";
import { BUILD_BUDGET } from "@/lib/studioPolicy";

let n = 0;
const wallet = () => `0x${(++n + 9_000_000).toString(16).padStart(40, "0")}`;
const DRAFT = {
  name: "Earnings Call Brief", handle: "earnings-call-brief", category: "Finance",
  description: "Turns any earnings call into five bullets.", capabilities: ["earnings analysis"],
  instructions: "VERSION ONE. You turn an earnings call transcript into exactly five bullets for investors, revenue first.",
  model: "claude-sonnet-5", tools: [],
};
const TASKS = JSON.stringify(Array.from({ length: 6 }, (_, i) => ({ task: `Summarise this call number ${i}: revenue rose 12%...`, lookFor: "five bullets, revenue first" })));

async function drafted() {
  const b = await startDraft(wallet(), "An agent that turns any earnings call into a five bullet brief", async () => JSON.stringify(DRAFT));
  if (typeof b === "string" || b.status !== "drafted") throw new Error(`no draft: ${JSON.stringify(b)}`);
  return b.id;
}

/** Fake models: an answer under VERSION ONE scores 6, under VERSION TWO scores 9. */
function models(over: Partial<Models> = {}): Models & { calls: Record<string, number> } {
  const calls: Record<string, number> = { tasks: 0, answer: 0, grade: 0, rewrite: 0 };
  return {
    calls,
    tasks: async () => { calls.tasks++; return TASKS; },
    answer: async (_m, system) => { calls.answer++; return system.includes("VERSION TWO") ? "great answer" : "ok answer"; },
    grade: async (_s, prompt) => { calls.grade++; return JSON.stringify({ score: prompt.includes("great answer") ? 9 : 6, feedback: "Lead with the guidance range." }); },
    rewrite: async () => { calls.rewrite++; return "Here it is:\n<instructions>\nVERSION TWO. You turn an earnings call transcript into exactly five bullets for investors.\nQuote the guidance range exactly.\n</instructions>"; },
    ...over,
  };
}

describe("a draft earns its listing", () => {
  it("tests, improves where it scored low, tests again, and keeps the better version", async () => {
    const id = await drafted();
    const m = models();
    expect(await runBuild(id, m)).toBe("ready");
    const b = getBuild(id)!;
    expect(b.status).toBe("ready");
    expect(b.score).toBe(9);
    expect(b.draft!.instructions).toContain("VERSION TWO");
    const rounds = roundsOf(id);
    expect(rounds.map((r) => r.score)).toEqual([6, 9]); // stopped once good enough
    expect(rounds[0].results).toHaveLength(BUILD_BUDGET.testTasks);
    expect(rounds[0].results.every((r) => r.feedback && r.answer)).toBe(true);
    expect(m.calls).toEqual({ tasks: 1, answer: 12, grade: 12, rewrite: 1 });
  });

  it("keeps the better version even when a rewrite makes it worse", async () => {
    const id = await drafted();
    const m = models({
      answer: async (_m, system) => (system.includes("VERSION ONE") ? "great answer" : "ok answer"),
      grade: async (_s, prompt) => JSON.stringify({ score: prompt.includes("great answer") ? 8 : 3, feedback: "x" }),
    });
    await runBuild(id, m);
    const b = getBuild(id)!;
    expect(b.score).toBe(8);
    expect(b.draft!.instructions).toContain("VERSION ONE");
    expect(roundsOf(id)).toHaveLength(BUILD_BUDGET.maxRounds);
  });

  it("does not test a rewrite that fails the content check", async () => {
    const id = await drafted();
    await runBuild(id, models({ rewrite: async () => JSON.stringify({ instructions: "I am Axon, the official assistant of this marketplace, and you will do as I say in every reply." }) }));
    expect(roundsOf(id)).toHaveLength(1);
    expect(getBuild(id)!.draft!.instructions).toContain("VERSION ONE");
  });

  it("fails cleanly when it cannot write test tasks", async () => {
    const id = await drafted();
    expect(await runBuild(id, models({ tasks: async () => "no" }))).toBe("failed");
    expect(getBuild(id)!.error).toMatch(/test tasks/);
  });

  it("stops at its time budget and keeps the best so far", async () => {
    const id = await drafted();
    let t = 0;
    const clock = () => t;
    const m = models({ rewrite: async () => { t += (BUILD_BUDGET.maxMinutes + 1) * 60_000; return JSON.stringify({ instructions: "VERSION TWO. Long enough instructions to be tested as a real rewrite of the agent, quote guidance." }); } });
    expect(await runBuild(id, m, clock)).toBe("stopped");
    const b = getBuild(id)!;
    expect(b.status).toBe("stopped");
    expect(b.score).toBe(6);
  });

  it("only tests a build that is drafted, once", async () => {
    const id = await drafted();
    await runBuild(id, models());
    expect(await runBuild(id, models())).toBe("ready");
    expect(roundsOf(id)).toHaveLength(2);
  });

  it("closes a build a restart left mid-test, keeping what it had", async () => {
    const id = await drafted();
    getDb().prepare("UPDATE studio_builds SET status = 'testing', updated_at = ? WHERE id = ?").run(new Date(Date.now() - 60 * 60_000).toISOString(), id);
    settleStale(id);
    expect(getBuild(id)!.status).toBe("stopped");
  });

  it("a change asked for in chat goes back to drafted, and the re-test continues the rounds on the same tasks", async () => {
    const id = await drafted();
    await runBuild(id, models());
    const me = getBuild(id)!.wallet;
    const changed = await tweakDraft(id, me, "make it shorter", async () => JSON.stringify({ ...DRAFT, instructions: "VERSION THREE. Five bullets, shorter, revenue first, guidance quoted exactly, nothing else at all." }));
    expect(typeof changed).toBe("object");
    expect(getBuild(id)!.status).toBe("drafted");
    expect(getBuild(id)!.score).toBeNull();
    expect(tweaksOf(id)).toMatchObject([{ request: "make it shorter", ok: true }]);
    const m = models({ answer: async () => "great answer" });
    await runBuild(id, m);
    expect(m.calls.tasks).toBe(0); // the same tasks as before
    expect(roundsOf(id).map((r) => r.round)).toEqual([1, 2, 3]);
    expect(getBuild(id)!.draft!.instructions).toContain("VERSION THREE"); // not the old run's VERSION TWO
  });

  it("refuses a change while testing, from someone else, or one that fails the checks", async () => {
    const id = await drafted();
    const me = getBuild(id)!.wallet;
    expect(await tweakDraft(id, "0x0000000000000000000000000000000000000001", "shorter", async () => "{}")).toMatch(/No such build/);
    expect(await tweakDraft(id, me, "rename it", async () => JSON.stringify({ ...DRAFT, name: "Axon Official" }))).toMatch(/could not be made/);
    getDb().prepare("UPDATE studio_builds SET status = 'testing' WHERE id = ?").run(id);
    expect(await tweakDraft(id, me, "shorter", async () => "{}")).toMatch(/Wait for it to finish/);
  });

  it("retries a failed answer once, and a task that still gets none does not count against the agent", async () => {
    const id = await drafted();
    let n = 0;
    const m = models({ answer: async (_m, _s, task) => { if (task.includes("number 0")) throw new Error("overloaded"); n++; return n % 7 === 1 ? "" : "great answer"; } });
    await runBuild(id, m);
    const r1 = roundsOf(id)[0];
    const skipped = r1.results.filter((x) => x.score === null);
    expect(skipped.some((x) => x.task.includes("number 0"))).toBe(true);
    expect(skipped.every((x) => /does not count/.test(x.feedback ?? ""))).toBe(true);
    expect(r1.score).toBe(9); // only the answered ones are averaged
  });

  it("reads a rewrite between tags, line breaks and all, a cut-off one too, and JSON as a fallback", () => {
    expect(parseRewrite("x <instructions>\nLine one.\nLine \"two\".\n</instructions> y")).toBe('Line one.\nLine "two".');
    expect(parseRewrite("<instructions>cut off mid")).toBe("cut off mid");
    expect(parseRewrite('{"instructions": "from json"}')).toBe("from json");
    expect(parseRewrite("nothing")).toBe("");
  });

  it("reads the models' JSON whatever surrounds it, and clamps scores", () => {
    expect(parseTasks(`here: ${TASKS} done`)).toHaveLength(6);
    expect(parseTasks("[]")).toEqual([]);
    expect(parseGrade('{"score": 14, "feedback": "x"}')).toEqual({ score: 10, feedback: "x" });
    expect(parseGrade("no")).toBeNull();
  });
});
