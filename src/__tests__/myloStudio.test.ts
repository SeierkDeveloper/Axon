// Mylo, phase 3: building agents in Studio from the conversation. Studio's writer and tester are stand-ins here (no
// model is called); the builds, rounds and Mylo's records are real rows.
import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "crypto";
import { getDb } from "@/lib/db";
import { createAgent } from "@/lib/agents";
import { runTool, MYLO_TOOL_DEFS } from "@/lib/myloTools";
import { studio, confirmAction, refreshAction, getAction, buildResult, type BuildDetail, type PublishDetail, type CreateTask } from "@/lib/myloActions";
import { startConversation, historyOf } from "@/lib/myloStore";
import { getBuild, type Build, type BuildStatus, type Draft } from "@/lib/studioDraft";
import { TOOLS, toolGate } from "@/lib/myloPolicy";
import type { Agent } from "@/sdk/types";

let n = 0;
const wallet = () => `0x${(++n).toString(16).padStart(40, "e")}`;
const ctx = (w: string | null) => { const owner = w ?? "guest:x"; return { wallet: w, owner, conversationId: startConversation(owner, "t").id }; };
const noTask: CreateTask = async () => { throw new Error("no hire here"); };
const draft = (name: string): Draft => ({ name, handle: name.toLowerCase().replace(/\W+/g, "-"), description: "Turns a changelog into release notes", capabilities: ["release notes"], category: "Content", instructions: "Write clear release notes.", model: "claude-haiku-4-5", tools: [], priceEth: 0.0005 });

function makeBuild(w: string, status: BuildStatus, score: number | null, name = `Notes Writer ${++n}`): Build {
  const id = randomUUID(), at = new Date().toISOString();
  getDb().prepare("INSERT INTO studio_builds (id, wallet, sentence, status, draft, score, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(id, w.toLowerCase(), "An agent that turns a changelog into short release notes", status, JSON.stringify(draft(name)), score, at, at);
  return getBuild(id)!;
}
function addRound(buildId: string, round: number, score: number, results: { task: string; score: number; feedback: string }[]) {
  getDb().prepare("INSERT INTO studio_rounds (build_id, round, instructions, results, score, created_at) VALUES (?,?,?,?,?,?)")
    .run(buildId, round, "x", JSON.stringify(results.map((r) => ({ ...r, lookFor: "clarity", answer: "a" }))), score, new Date().toISOString());
}

const calls: string[] = [];
beforeEach(() => {
  calls.length = 0;
  studio.mayStart = async () => ({ ok: true });
  studio.mayRun = () => ({ ok: true });
  studio.runBuild = async (id) => { calls.push(`run:${id}`); return "ready"; };
  studio.startDraft = async () => { throw new Error("not expected"); };
  studio.tweakDraft = async () => { throw new Error("not expected"); };
  studio.publishBuild = () => { throw new Error("not expected"); };
});

describe("Mylo's Studio tools", () => {
  it("are in the policy: a new build and publishing wait for an OK, a change to your own draft doesn't, all need a wallet", () => {
    for (const d of MYLO_TOOL_DEFS) expect(TOOLS[d.name]).toBeTruthy();
    expect(toolGate("build_agent", true)).toEqual({ ok: true, confirm: true });
    expect(toolGate("publish_build", true)).toEqual({ ok: true, confirm: true });
    expect(toolGate("change_build", true)).toEqual({ ok: true, confirm: false });
    for (const t of ["build_agent", "change_build", "build_report", "publish_build"]) expect(toolGate(t, false).ok).toBe(false);
    expect(toolGate("pricing_advice", false).ok).toBe(true);
  });

  it("proposes a build without starting one, and refuses a vague sentence or a wallet out of builds for today", async () => {
    const w = wallet();
    const out = await runTool("build_agent", { sentence: "An agent that turns a changelog into short release notes for customers" }, ctx(w));
    const a = getAction(out.actionId!, w)!;
    expect(a).toMatchObject({ kind: "build", status: "proposed" });
    expect((a.detail as BuildDetail).buildId).toBeNull();
    expect(calls).toEqual([]);
    expect((await runTool("build_agent", { sentence: "notes" }, ctx(w))).result).toMatchObject({ error: expect.stringMatching(/sentence/) });
    studio.mayStart = async () => ({ ok: false, reason: "This wallet has started its 5 builds for today." });
    expect((await runTool("build_agent", { sentence: "An agent that writes release notes from changelogs" }, ctx(w))).result).toMatchObject({ error: expect.stringMatching(/5 builds/) });
  });

  it("starts the build when confirmed, follows it, and says its score and weakest test once, when it finishes", async () => {
    const w = wallet(), c = ctx(w);
    const p = await runTool("build_agent", { sentence: "An agent that turns a changelog into short release notes" }, c);
    const b = makeBuild(w, "drafted", null, "Changelog Notes");
    studio.startDraft = async (who, s) => { expect(who).toBe(w); expect(s).toMatch(/changelog/); return b; };
    const started = await confirmAction(p.actionId!, c.owner, w, { method: "wallet", clientIp: "x" }, noTask);
    expect(started).toMatchObject({ status: "running", detail: { buildId: b.id, name: "Changelog Notes", stage: "testing" } });
    expect(calls).toEqual([`run:${b.id}`]);
    // while Studio tests it, the card follows its stage and round
    getDb().prepare("UPDATE studio_builds SET status = 'improving', score = 7.1, updated_at = ? WHERE id = ?").run(new Date().toISOString(), b.id);
    addRound(b.id, 1, 7.1, [{ task: "Summarise a long changelog", score: 9, feedback: "Clear." }, { task: "Release notes for a security fix", score: 4, feedback: "Missed the upgrade steps." }]);
    const mid = refreshAction(p.actionId!, c.owner) as { action: { detail: BuildDetail }; message: null };
    expect(mid.message).toBeNull();
    expect(mid.action.detail).toMatchObject({ stage: "improving", round: 1, score: 7.1 });
    // finished: the result is written into the conversation, once
    getDb().prepare("UPDATE studio_builds SET status = 'ready', score = 8.2 WHERE id = ?").run(b.id);
    addRound(b.id, 2, 8.2, [{ task: "Summarise a long changelog", score: 9, feedback: "Clear." }, { task: "Release notes for a security fix", score: 7, feedback: "Upgrade steps are there but buried at the end." }]);
    const done = refreshAction(p.actionId!, c.owner) as { action: { status: string }; message: { content: string } };
    expect(done.action.status).toBe("done");
    expect(done.message.content).toMatch(/\*\*Changelog Notes\*\* is built and tested: it scored \*\*8\.2\/10\*\* on 2 test tasks/);
    expect(done.message.content).toMatch(/weakest test: "Release notes for a security fix" scored 7\. The grader said: Upgrade steps are there but buried/);
    expect(done.message.content).toMatch(/Ask me to publish it/);
    expect(done.message.content).toContain(`/studio?build=${b.id}`);
    expect((refreshAction(p.actionId!, c.owner) as { message: unknown }).message).toBeNull();
    expect(historyOf(c.conversationId, 5).filter((m) => m.role === "assistant")).toHaveLength(1);
  });

  it("says plainly when Studio won't start the build, or the build fails", async () => {
    const w = wallet(), c = ctx(w);
    const p = await runTool("build_agent", { sentence: "An agent that turns a changelog into short release notes" }, c);
    studio.startDraft = async () => "Studio is busy building other agents. Try again in a minute.";
    expect(await confirmAction(p.actionId!, c.owner, w, { method: "wallet", clientIp: "x" }, noTask)).toMatchObject({ status: "failed", detail: { error: expect.stringMatching(/busy/) } });
    const failed = makeBuild(w, "failed", null);
    getDb().prepare("UPDATE studio_builds SET error = 'Studio could not write test tasks for this agent.' WHERE id = ?").run(failed.id);
    expect(buildResult(getBuild(failed.id)!)).toMatch(/didn't finish: Studio could not write test tasks/);
    const weak = makeBuild(w, "ready", 5.2);
    expect(buildResult(weak)).toMatch(/needs 6 to be listed/);
  });

  it("changes your own build and retests it, and won't touch anyone else's", async () => {
    const w = wallet(), c = ctx(w), b = makeBuild(w, "ready", 7);
    studio.tweakDraft = async (id, who, change) => { expect(change).toBe("Put upgrade steps first"); getDb().prepare("UPDATE studio_builds SET status = 'drafted', score = NULL WHERE id = ?").run(id); return getBuild(id)!; };
    const out = await runTool("change_build", { build_id: b.id, change: "Put upgrade steps first" }, c);
    // the writer runs in the background: the reply doesn't wait for it, and the card follows it
    expect(getAction(out.actionId!, w)).toMatchObject({ kind: "build", status: "running", detail: { buildId: b.id, change: "Put upgrade steps first" } });
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toEqual([`run:${b.id}`]);
    expect(getAction(out.actionId!, w)!.detail).toMatchObject({ changing: false, stage: "testing" });
    // a change the writer can't make is said plainly in the conversation, and nothing is retested
    const other = makeBuild(w, "ready", 7);
    studio.tweakDraft = async () => "That change could not be made: try saying it another way.";
    const bad = await runTool("change_build", { build_id: other.id, change: "Make it purple" }, c);
    await new Promise((r) => setTimeout(r, 10));
    expect(getAction(bad.actionId!, w)).toMatchObject({ status: "failed" });
    expect(historyOf(c.conversationId, 10).at(-1)!.content).toBe("That change could not be made: try saying it another way.");
    expect(calls).toEqual([`run:${b.id}`]);
    expect((await runTool("change_build", { build_id: makeBuild(w, "testing", null).id, change: "shorter" }, c)).result).toMatchObject({ error: expect.stringMatching(/Wait for it to finish/) });
    const theirs = makeBuild(wallet(), "ready", 7);
    expect((await runTool("change_build", { build_id: theirs.id, change: "x y z" }, c)).result).toMatchObject({ error: "That isn't one of your builds." });
  });

  it("publishes only a tested build of yours that scored 6 or more, at the price shown, once confirmed", async () => {
    const w = wallet(), c = ctx(w);
    expect((await runTool("publish_build", { build_id: makeBuild(w, "ready", 5.5).id }, c)).result).toMatchObject({ error: expect.stringMatching(/needs 6/) });
    expect((await runTool("publish_build", { build_id: makeBuild(w, "testing", null).id }, c)).result).toMatchObject({ error: expect.stringMatching(/finish testing/) });
    expect((await runTool("publish_build", { build_id: makeBuild(w, "ready", 8, "Someone's").id }, ctx(wallet()))).result).toMatchObject({ error: "That isn't one of your builds." });
    const b = makeBuild(w, "ready", 8.4, "Notes Pro");
    const out = await runTool("publish_build", { build_id: b.id, price_eth: 0.0008 }, c);
    expect(getAction(out.actionId!, w)).toMatchObject({ kind: "publish", status: "proposed", detail: { buildId: b.id, priceEth: 0.0008, name: "Notes Pro" } });
    studio.publishBuild = (id, who, price) => { expect([id, who, price]).toEqual([b.id, w, 0.0008]); return { agentId: "notes-pro" }; };
    expect(await confirmAction(out.actionId!, c.owner, w, { method: "wallet", clientIp: "x" }, noTask)).toMatchObject({ status: "running", detail: { agentId: "notes-pro" } });
    const live = refreshAction(out.actionId!, c.owner) as { action: { status: string }; message: { content: string } };
    expect(live.action.status).toBe("done");
    expect(live.message.content).toMatch(/\*\*Notes Pro\*\* is live on Axon at 0\.0008 ETH a task: \[\/agents\/notes-pro\]/);
    expect((getAction(out.actionId!, w)!.detail as PublishDetail).agentId).toBe("notes-pro");
  });

  it("reports your builds and, for one, its weakest tests to coach from; never anyone else's", async () => {
    const w = wallet(), c = ctx(w), b = makeBuild(w, "ready", 7.4, "Coach Me");
    addRound(b.id, 1, 7.4, [{ task: "A", score: 9, feedback: "fine" }, { task: "B", score: 5, feedback: "too long" }, { task: "C", score: 6, feedback: "vague" }, { task: "D", score: 8, feedback: "ok" }]);
    const list = (await runTool("build_report", {}, c)).result as { builds: { build_id: string; name: string }[] };
    expect(list.builds.map((x) => x.name)).toContain("Coach Me");
    const one = (await runTool("build_report", { build_id: b.id }, c)).result as { weakest_tests: { task: string }[]; can_publish: boolean; changes_left: number };
    expect(one.weakest_tests.map((t) => t.task)).toEqual(["B", "C", "D"]);
    expect(one).toMatchObject({ can_publish: true, changes_left: 10 });
    expect((await runTool("build_report", { build_id: b.id }, ctx(wallet()))).result).toMatchObject({ error: "That isn't one of your builds." });
  });

  it("gives pricing from what similar agents really charge", async () => {
    const mk = (i: number, price?: string) => createAgent({ agentId: `zz-tax-${n}-${i}`, name: `Zanzibar Tax Helper ${i}`, capabilities: ["zanzibar tax"], publicKey: `pk-z-${n}-${i}`, provider: "anthropic", reputation: 0, category: "Finance", price, description: "Zanzibar tax returns", createdAt: new Date().toISOString() } as Agent);
    n++;
    mk(1, "0.001 ETH"); mk(2, "0.002 ETH"); mk(3, "0.004 ETH"); mk(4);
    const out = await runTool("pricing_advice", { description: "zanzibar tax returns" }, ctx(null));
    const r = out.result as { priced_count: number; free_count: number; price_eth: { lowest: number; middle: number; highest: number } };
    expect(r).toMatchObject({ priced_count: 3, free_count: 1, price_eth: { lowest: 0.001, middle: 0.002, highest: 0.004 } });
    expect(out.card).toMatchObject({ kind: "agents", title: "What similar agents charge" });
  });
});
