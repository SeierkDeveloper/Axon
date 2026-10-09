// Mylo, phase 8: crews, autopilot, token launch and $AXON perks. The hire route and the retainer are stand-ins (no ETH
// moves); the agents, crews, tasks and Mylo's records are real rows.
import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { keepOutput, fileTokenFor } from "@/lib/agentFiles";
import { getDb } from "@/lib/db";
import { createAgent } from "@/lib/agents";
import { runTool, MYLO_TOOL_DEFS } from "@/lib/myloTools";
import { studio, confirmAction, refreshAction, advanceCrew, getAction, type CreateTask, type CrewDetail } from "@/lib/myloActions";
import { startConversation, crewsOf, historyOf } from "@/lib/myloStore";
import { TOOLS, toolGate, CREWS_BY_TIER, MESSAGES_PER_DAY } from "@/lib/myloPolicy";
import { RetainerError, type Retainer } from "@/lib/retainers";
import type { Agent } from "@/sdk/types";

let n = 0;
const wallet = () => `0x${(++n).toString(16).padStart(40, "5")}`;
const ctx = (w: string) => ({ wallet: w, owner: w, conversationId: startConversation(w, "t").id });
const TX = (i: number) => `0x${i.toString(16).padStart(64, "b")}`;
function agent(name: string, price?: string): Agent {
  n++;
  return createAgent({ agentId: `crew-${n}`, name, capabilities: ["x"], publicKey: `pk-crew-${n}`, provider: "anthropic", reputation: 0, price, createdAt: new Date().toISOString() } as Agent);
}
function finish(taskId: string, status: "completed" | "failed", output: string | null) {
  getDb().prepare("INSERT OR REPLACE INTO tasks (task_id, from_agent, to_agent, task, status, output, created_at, completed_at) VALUES (?,?,?,?,?,?,?,?)").run(taskId, "anonymous", "x", "t", status, output, new Date().toISOString(), new Date().toISOString());
}

describe("Mylo's phase 8 tools", () => {
  it("are in the policy: running a crew and starting autopilot wait for an OK, everything needs a wallet", () => {
    for (const d of MYLO_TOOL_DEFS) expect(TOOLS[d.name]).toBeTruthy();
    expect(toolGate("run_crew", true)).toEqual({ ok: true, confirm: true });
    expect(toolGate("schedule_job", true)).toEqual({ ok: true, confirm: true });
    expect(toolGate("save_crew", true)).toEqual({ ok: true, confirm: false });
    for (const t of ["save_crew", "my_crews", "run_crew", "schedule_job", "my_schedules", "manage_schedule", "launch_token", "my_tier"]) expect(toolGate(t, false).ok).toBe(false);
  });
});

describe("crews", () => {
  it("saves two to four real agents in order, once each, within the tier's number of crews", async () => {
    const w = wallet(), c = ctx(w), a = agent("Researcher", "0.0002 ETH"), b = agent("Writer");
    expect((await runTool("save_crew", { name: "Solo", members: [{ agent_id: a.agentId }] }, c)).result).toMatchObject({ error: expect.stringMatching(/2 to 4/) });
    expect((await runTool("save_crew", { name: "Twice", members: [{ agent_id: a.agentId }, { agent_id: a.agentId }] }, c)).result).toMatchObject({ error: expect.stringMatching(/once/) });
    expect((await runTool("save_crew", { name: "Ghost", members: [{ agent_id: a.agentId }, { agent_id: "nope" }] }, c)).result).toMatchObject({ error: expect.stringMatching(/no agent called nope/) });
    const ok = await runTool("save_crew", { name: "Launch crew", members: [{ agent_id: a.agentId, role: "researcher" }, { agent_id: b.agentId, role: "writer" }] }, c);
    expect(ok.result).toMatchObject({ saved: { name: "Launch crew", cost_eth: 0.0002, steps: [{ role: "researcher" }, { role: "writer" }] } });
    for (let i = crewsOf(w).length; i < CREWS_BY_TIER.base; i++) await runTool("save_crew", { name: `crew ${i}`, members: [{ agent_id: a.agentId }, { agent_id: b.agentId }] }, c);
    expect((await runTool("save_crew", { name: "one too many", members: [{ agent_id: a.agentId }, { agent_id: b.agentId }] }, c)).result).toMatchObject({ error: expect.stringMatching(/can keep 3 crews/) });
    expect((await runTool("save_crew", { name: "launch crew", remove: true }, c)).result).toEqual({ removed: "launch crew" });
  });

  it("runs in order on your OK: every paid step paid first, each next step given the answer before it, the final result once", async () => {
    const w = wallet(), c = ctx(w), r = agent("Researcher", "0.0002 ETH"), wr = agent("Writer", "0.0003 ETH");
    await runTool("save_crew", { name: "Notes", members: [{ agent_id: r.agentId, role: "find what changed" }, { agent_id: wr.agentId, role: "write the notes" }] }, c);
    const p = await runTool("run_crew", { crew: "Notes", task: "Release notes for v3" }, c);
    expect(getAction(p.actionId!, w)).toMatchObject({ kind: "crew", status: "proposed", hires: [{ name: "Researcher" }, { name: "Writer" }] });
    const sent: Record<string, unknown>[] = [];
    const create: CreateTask = async (body) => { sent.push(body); return { status: 201, json: { taskId: randomUUID() }, replay: false }; };
    // paid one step only: nothing runs
    const p2 = await runTool("run_crew", { crew: "Notes", task: "Release notes for v4" }, c);
    expect(await confirmAction(p2.actionId!, c.owner, w, { method: "wallet", payments: { [r.agentId]: TX(1) }, clientIp: "x" }, create)).toMatchObject({ status: "failed", detail: { error: expect.stringMatching(/Not paid: Writer/) } });
    expect(sent).toEqual([]);
    // paid both: step one starts with its role and the task
    const started = await confirmAction(p.actionId!, c.owner, w, { method: "wallet", payments: { [r.agentId]: TX(2), [wr.agentId]: TX(3) }, clientIp: "x" }, create);
    expect(started).toMatchObject({ status: "running", detail: { current: 0 } });
    expect(sent[0]).toEqual({ to: r.agentId, task: "Your part in this crew: find what changed.\n\nRelease notes for v3", from: "anonymous", paymentSignature: TX(2), payerWallet: w });
    const a = getAction(p.actionId!, w)!;
    finish(a.hires[0].taskId!, "completed", "Faster exports; new billing page.");
    await advanceCrew(p.actionId!, c.owner, create);
    expect(sent[1]).toMatchObject({ to: wr.agentId, paymentSignature: TX(3), task: expect.stringMatching(/^Your part in this crew: write the notes\.\n\nThe task: Release notes for v3\n\nThe step before you \(Researcher, find what changed\) produced:\n\nFaster exports; new billing page\.$/) });
    await advanceCrew(p.actionId!, c.owner, create); // nothing new until step two finishes
    expect(sent).toHaveLength(2);
    expect((getAction(p.actionId!, w)!.detail as CrewDetail).current).toBe(1);
    finish(getAction(p.actionId!, w)!.hires[1].taskId!, "completed", "v3 is faster and adds billing.");
    const done = refreshAction(p.actionId!, c.owner) as { action: { status: string }; message: { content: string } };
    expect(done.action.status).toBe("done");
    expect(done.message.content).toMatch(/^The crew "Notes" finished\. Here is the final result, from Writer:\n\nv3 is faster and adds billing\./);
    expect(done.message.content).toMatch(/1\. \*\*Researcher\*\* \(find what changed\): \[receipt\]\(\/r\//);
    expect((refreshAction(p.actionId!, c.owner) as { message: unknown }).message).toBeNull();
  });

  it("hands what one step made to the next step, as files the hire takes, and nothing while files are off", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axon-crew-files-"));
    const before = { files: process.env.AGENT_FILES, dir: process.env.AXON_FILES_DIR };
    Object.assign(process.env, { AGENT_FILES: "on", AXON_FILES_DIR: dir });
    try {
      const w = wallet(), c = ctx(w), one = agent("Analyst"), two = agent("Writer");
      await runTool("save_crew", { name: "Charts", members: [{ agent_id: one.agentId }, { agent_id: two.agentId }] }, c);
      const p = await runTool("run_crew", { crew: "Charts", task: "Chart the quarter" }, c);
      const sent: Record<string, unknown>[] = [];
      const create: CreateTask = async (body) => { sent.push(body); return { status: 201, json: { taskId: randomUUID() }, replay: false }; };
      await confirmAction(p.actionId!, c.owner, w, { method: "wallet", payments: {}, clientIp: "x" }, create);
      expect(sent[0]).not.toHaveProperty("files");
      const first = getAction(p.actionId!, w)!.hires[0].taskId!;
      finish(first, "completed", "See the chart.");
      const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 7)]);
      const chart = keepOutput({ taskId: first, bytes: PNG, name: "quarter.png", wallet: null });
      expect(chart?.ok).toBe(true);
      await advanceCrew(p.actionId!, c.owner, create);
      const files = sent[1].files as { id: string; token: string }[];
      expect(files).toHaveLength(1);
      expect(files[0].token).toBe(fileTokenFor(files[0].id));
      // a copy waiting for the hire to take it: same bytes, no job yet, and it knows which job made it
      expect(getDb().prepare("SELECT name, direction, task_id, source_task_id FROM task_files WHERE id = ?").get(files[0].id)).toEqual({ name: "quarter.png", direction: "in", task_id: null, source_task_id: first });

      process.env.AGENT_FILES = "off";
      const p2 = await runTool("run_crew", { crew: "Charts", task: "Chart the year" }, c);
      await confirmAction(p2.actionId!, c.owner, w, { method: "wallet", payments: {}, clientIp: "x" }, create);
      const first2 = getAction(p2.actionId!, w)!.hires[0].taskId!;
      finish(first2, "completed", "Done.");
      await advanceCrew(p2.actionId!, c.owner, create);
      expect(sent.at(-1)).not.toHaveProperty("files");
    } finally {
      if (before.files === undefined) delete process.env.AGENT_FILES; else process.env.AGENT_FILES = before.files;
      if (before.dir === undefined) delete process.env.AXON_FILES_DIR; else process.env.AXON_FILES_DIR = before.dir;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stops at a step that fails and says so, and doesn't start the rest", async () => {
    const w = wallet(), c = ctx(w), x = agent("First"), y = agent("Second");
    await runTool("save_crew", { name: "Short", members: [{ agent_id: x.agentId }, { agent_id: y.agentId }] }, c);
    const p = await runTool("run_crew", { crew: "Short", task: "Do the thing" }, c);
    const sent: unknown[] = [];
    const create: CreateTask = async (body) => { sent.push(body); return { status: 201, json: { taskId: randomUUID() }, replay: false }; };
    await confirmAction(p.actionId!, c.owner, w, { method: "wallet", payments: {}, clientIp: "x" }, create);
    finish(getAction(p.actionId!, w)!.hires[0].taskId!, "failed", null);
    await advanceCrew(p.actionId!, c.owner, create);
    expect(sent).toHaveLength(1);
    const r = refreshAction(p.actionId!, c.owner) as { action: { status: string }; message: { content: string } };
    expect(r.action.status).toBe("failed");
    expect(r.message.content).toMatch(/stopped at step 1, First/);
    expect(historyOf(c.conversationId, 5).filter((m) => m.role === "assistant")).toHaveLength(1);
  });
});

describe("autopilot", () => {
  beforeEach(() => { studio.createRetainer = async () => { throw new Error("not expected"); }; });

  it("proposes a paid agent on a schedule, and starts it as a retainer on your OK", async () => {
    const w = wallet(), c = ctx(w), a = agent("Weekly Brief", "0.0004 ETH");
    expect((await runTool("schedule_job", { agent_id: agent("Free One").agentId, task: "x", schedule: { kind: "daily", time: "09:00" } }, c)).result).toMatchObject({ error: expect.stringMatching(/paid agents/) });
    expect((await runTool("schedule_job", { agent_id: a.agentId, task: "x", schedule: { kind: "monthly" } }, c)).result).toMatchObject({ error: expect.stringMatching(/interval, daily or weekly/) });
    const p = await runTool("schedule_job", { agent_id: a.agentId, task: "A market brief", schedule: { kind: "weekly", day: 1, time: "09:00", time_zone: "Europe/Stockholm" } }, c);
    expect(getAction(p.actionId!, w)).toMatchObject({ kind: "schedule", status: "proposed", detail: { name: "Weekly Brief", scheduleText: expect.stringMatching(/Monday.*09:00.*Stockholm/) } });
    studio.createRetainer = async (who, input) => { expect(who).toBe(w); expect(input).toMatchObject({ agentId: a.agentId, instructions: "A market brief", schedule: { kind: "weekly", day: 1, time: "09:00", timeZone: "Europe/Stockholm" } }); return { retainerId: "ret-1", nextRunAt: "2026-10-05T07:00:00.000Z" } as Retainer; };
    expect(await confirmAction(p.actionId!, c.owner, w, { method: "wallet", payments: {}, clientIp: "x" }, async () => { throw new Error("no hire"); })).toMatchObject({ status: "running", detail: { retainerId: "ret-1" } });
    const done = refreshAction(p.actionId!, c.owner) as { message: { content: string } };
    expect(done.message.content).toMatch(/\*\*Weekly Brief\*\* is on autopilot: every Monday.*first run Mon, 05 Oct 2026 07:00 UTC\. Each run pays at most/i);
  });

  it("says plainly when the schedule can't start", async () => {
    const w = wallet(), c = ctx(w), a = agent("Daily", "0.0004 ETH");
    const p = await runTool("schedule_job", { agent_id: a.agentId, task: "x y", schedule: { kind: "interval", every_hours: 6 } }, c);
    studio.createRetainer = async () => { throw new RetainerError("This wallet already has 3 jobs on a schedule"); };
    expect(await confirmAction(p.actionId!, c.owner, w, { method: "wallet", payments: {}, clientIp: "x" }, async () => { throw new Error("no hire"); })).toMatchObject({ status: "failed", detail: { error: "This wallet already has 3 jobs on a schedule" } });
  });
});

describe("launching and perks", () => {
  it("won't prepare a launch for someone else's agent", async () => {
    const out = await runTool("launch_token", { agent_id: agent("Theirs").agentId, name: "Theirs", ticker: "thr" }, ctx(wallet()));
    expect(out.result).toMatchObject({ can_launch: false, why_not: expect.any(String) });
  });

  it("tells a wallet what its tier gives and what the next adds, from the rules Axon enforces", async () => {
    const out = await runTool("my_tier", {}, ctx(wallet()));
    expect(out.result).toMatchObject({ tier: "base", perks: { mylo_messages_a_day: MESSAGES_PER_DAY.base, saved_crews: CREWS_BY_TIER.base, mylo_model: expect.stringMatching(/haiku/) }, next: { tier: "holder", hold_at_least: 250_000, perks: { mylo_messages_a_day: MESSAGES_PER_DAY.holder, mylo_model: expect.stringMatching(/smarter/) } } });
  });
});
