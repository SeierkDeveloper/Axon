// Watch it work: the lines an agent's steps become, who reads them, and that writing them can never break a job.
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/embeddings", async (orig) => ({ ...(await orig<typeof import("@/lib/embeddings")>()), generateEmbedding: async () => null, scheduleAgentEmbedding: () => {} }));
vi.mock("@/lib/agentDescription", async (orig) => ({ ...(await orig<typeof import("@/lib/agentDescription")>()), scheduleAgentDescription: () => {} }));

import { getDb } from "@/lib/db";
import { createAgent } from "@/lib/agents";
import type { Agent } from "@/sdk/types";
import { liveLogEnabled, liveLog, lineFor, noteLine, stepsOf, MAX_STEPS, MAX_STEP_CHARS } from "@/lib/liveLog";
import { POST as hire } from "@/app/api/tasks/route";
import { GET as taskGet } from "@/app/api/tasks/[taskId]/route";
import { handleMcpMessage, claimTokenFor } from "@/lib/mcpServer";

const saved = { ...process.env };
let n = 0;
const wallet = () => `0x${(++n + 7_700_000).toString(16).padStart(40, "0")}`;
const tool = (name: string, input: unknown, id = `t${++n}`) => ({ type: "tool" as const, id, tool: name, input });

async function runningJob(): Promise<{ taskId: string; claimToken: string }> {
  const r = await hire(new NextRequest("http://x/api/tasks", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "10.6.0.1" }, body: JSON.stringify({ from: "anonymous", to: "worker", task: "Do the sums" }) }));
  expect(r.status).toBe(201);
  const t = (await r.json()) as { taskId: string; claimToken: string };
  getDb().prepare("UPDATE tasks SET status = 'running', started_at = ? WHERE task_id = ?").run(new Date().toISOString(), t.taskId);
  return t;
}

beforeEach(() => {
  Object.assign(process.env, { AGENT_LIVE_LOG: "on", TRUST_PROXY_HEADERS: "true" });
  delete process.env.AGENT_FILES;
  getDb().exec("DELETE FROM task_progress; DELETE FROM rate_limit_windows; DELETE FROM tasks; DELETE FROM agent_capabilities; DELETE FROM agents; DELETE FROM api_keys;");
  const a: Agent = { agentId: "worker", name: "Worker", capabilities: ["analysis"], publicKey: "pk-worker", walletAddress: wallet(), provider: "anthropic", reputation: 0, createdAt: new Date().toISOString() };
  createAgent(a, { describe: false });
});
afterAll(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});

describe("the switch", () => {
  it("is on only when it says on", () => {
    expect(liveLogEnabled({})).toBe(false);
    expect(liveLogEnabled({ AGENT_LIVE_LOG: "off" })).toBe(false);
    expect(liveLogEnabled({ AGENT_LIVE_LOG: " ON " })).toBe(true);
  });
});

describe("a step as a line", () => {
  it("says what a search, a page, a run or a file edit is, in plain words", () => {
    expect(lineFor(tool("web_search", { query: "ETH price today" }))).toBe('Searching the web for "ETH price today"');
    expect(lineFor(tool("web_search", {}))).toBe("Searching the web");
    expect(lineFor(tool("web_fetch", { url: "https://www.example.com/a/b?c=1" }))).toBe("Opening example.com");
    expect(lineFor(tool("web_fetch", { url: "not a url" }))).toBe("Opening a page");
    expect(lineFor(tool("bash_code_execution", { command: "python3 /tmp/analyze.py --fast" }))).toBe("Running analyze.py");
    expect(lineFor(tool("bash_code_execution", { command: "cat > /tmp/chart.py << 'EOF'\nimport pandas\nEOF" }))).toBe("Writing chart.py");
    expect(lineFor(tool("bash_code_execution", { command: "# look first\nls -la /tmp" }))).toBe("Looking at the files");
    expect(lineFor(tool("bash_code_execution", { command: "head -5 /mnt/user/orders.csv" }))).toBe("Looking at orders.csv");
    expect(lineFor(tool("bash_code_execution", { command: "python3 -c \"print(1)\"" }))).toBe("Running Python");
    expect(lineFor(tool("bash_code_execution", { command: "pip install -q matplotlib" }))).toBe("Installing matplotlib");
    expect(lineFor(tool("bash_code_execution", { command: "sort -u names.txt | wc -l" }))).toBe("Running: sort -u names.txt | wc -l");
    expect(lineFor(tool("bash_code_execution", {}))).toBe("Running code");
    expect(lineFor(tool("text_editor_code_execution", { command: "create", path: "/tmp/report.md" }))).toBe("Writing report.md");
    expect(lineFor(tool("text_editor_code_execution", { command: "view", path: "/tmp/orders.csv" }))).toBe("Looking at orders.csv");
    expect(lineFor(tool("text_editor_code_execution", { command: "str_replace", path: "/tmp/chart.py" }))).toBe("Editing chart.py");
    expect(lineFor(tool("pricefeed/get_token_price", { symbol: "ETH" }))).toBe("Using get token price");
  });

  it("is short, however long the thing it describes", () => {
    const long = lineFor(tool("bash_code_execution", { command: `grep ${"x".repeat(500)} file` }))!;
    expect(long.length).toBeLessThanOrEqual(110);
    expect(long.endsWith("…")).toBe(true);
    expect(lineFor(tool("web_search", { query: "q".repeat(400) }))!.length).toBeLessThanOrEqual(MAX_STEP_CHARS);
  });

  it("takes the first sentence of what the agent said, without the markup", () => {
    expect(noteLine("I'll start by **looking** at the file structure. Then I will compute totals.")).toBe("I'll start by looking at the file structure.");
    expect(noteLine("## Plan\n\nLet me check the data first:\n```python\nprint(1)\n```")).toBe("Plan");
    expect(noteLine("Let me check the data first:")).toBe("Let me check the data first.");
    expect(noteLine("```python\nprint(1)\n```")).toBeNull();
    expect(noteLine("   ")).toBeNull();
    expect(lineFor({ type: "note", text: "Now I will draw the chart." })).toBe("Now I will draw the chart.");
  });
});

describe("the log of one job", () => {
  it("writes each step once, in order, and whoever may read the job reads them", async () => {
    const job = await runningJob();
    const live = liveLog(job.taskId);
    live.say("Picked up by Worker");
    live.say("Reading orders.csv");
    live.onLive({ type: "note", text: "First I will look at the columns." });
    live.onLive(tool("bash_code_execution", { command: "head -3 orders.csv" }, "srv_1"));
    live.onLive(tool("bash_code_execution", { command: "head -3 orders.csv" }, "srv_1")); // the same call, reported again after a retry
    live.onLive({ type: "note", text: "First I will look at the columns." });
    live.say("Made chart.png");
    live.say("Made chart.png");
    expect(stepsOf(job.taskId).map((s) => [s.n, s.text])).toEqual([
      [1, "Picked up by Worker"], [2, "Reading orders.csv"], [3, "First I will look at the columns."], [4, "Looking at orders.csv"], [5, "Made chart.png"],
    ]);

    const read = async (token: string) => taskGet(new NextRequest(`http://x/api/tasks/${job.taskId}`, { headers: { "x-claim-token": token } }), { params: Promise.resolve({ taskId: job.taskId }) });
    const seen = (await (await read(job.claimToken)).json()) as { status: string; steps?: { n: number; text: string; at: string }[] };
    expect(seen.status).toBe("running");
    expect(seen.steps?.map((s) => s.text)).toEqual(["Picked up by Worker", "Reading orders.csv", "First I will look at the columns.", "Looking at orders.csv", "Made chart.png"]);
    expect((await read("wrong")).status).toBe(403);

    // the tool layer lists the same lines while the job runs
    const res = await handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_task_result", arguments: { taskId: job.taskId, claimToken: claimTokenFor(job.taskId) } } }, "10.6.0.2");
    const result = JSON.parse((res as { result: { content: { text: string }[] } }).result.content[0].text) as { steps?: string[]; output: unknown };
    expect(result.steps).toHaveLength(5);
    expect(result.output).toBeNull();

    process.env.AGENT_LIVE_LOG = "off";
    expect(await (await read(job.claimToken)).json()).not.toHaveProperty("steps");
  });

  it("stops listing after its limit, and says so once", async () => {
    const job = await runningJob();
    const live = liveLog(job.taskId);
    for (let i = 0; i < MAX_STEPS + 10; i++) live.say(`Step number ${i}`);
    const lines = stepsOf(job.taskId).map((s) => s.text);
    expect(lines).toHaveLength(MAX_STEPS + 1);
    expect(lines[MAX_STEPS - 1]).toBe(`Step number ${MAX_STEPS - 1}`);
    expect(lines[MAX_STEPS]).toBe("Still working. Later steps are not listed.");
  });

  it("writes nothing while it is off, and never throws: not for a job that is over, not for one that never was", async () => {
    const job = await runningJob();
    const off = liveLog(job.taskId, { enabled: false });
    off.say("Picked up by Worker");
    off.onLive(tool("web_search", { query: "x" }));
    expect(off.on).toBe(false);
    expect(stepsOf(job.taskId)).toEqual([]);

    getDb().prepare("UPDATE tasks SET status = 'completed' WHERE task_id = ?").run(job.taskId);
    const late = liveLog(job.taskId);
    expect(() => late.say("Too late")).not.toThrow();
    expect(stepsOf(job.taskId)).toEqual([]);
    const ghost = liveLog("no-such-task");
    expect(() => { ghost.say("x"); ghost.onLive(tool("web_search", { query: "x" })); ghost.onLive({ type: "note", text: "A note with enough words." }); }).not.toThrow();
  });

  it("keeps a secret out of a line", async () => {
    const job = await runningJob();
    liveLog(job.taskId).onLive(tool("bash_code_execution", { command: "curl -H 'Authorization: Bearer sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789' https://api.example.com" }));
    const line = stepsOf(job.taskId)[0].text;
    expect(line).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
  });
});
