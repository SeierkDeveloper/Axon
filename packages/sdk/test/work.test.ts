// Work with your agent, from the SDK: a hire that is followed up, answered, planned, steered, remembered and kept
// in a library. Driven against a mocked fetch: what is checked is the request each call makes and how a job that
// pauses on its hirer is waited for. No network.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AxonClient } from "../src/client";
import { hire, waitForTask } from "../src/hire";
import type { TaskRequest } from "../src/types";

function resp(status: number, body: unknown = {}): Response {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => JSON.stringify(body), json: async () => body, arrayBuffer: async () => new TextEncoder().encode(String(body)).buffer } as unknown as Response;
}
const task = (over: Partial<TaskRequest> = {}): TaskRequest => ({ taskId: "t1", fromAgent: "anonymous", toAgent: "quill", task: "x", status: "queued", createdAt: "2026-10-10T10:00:00.000Z", ...over });

let fetchMock: ReturnType<typeof vi.fn>;
let client: AxonClient;
type Sent = { url: string; method: string; headers: Record<string, string>; body: Record<string, unknown> | null };
const sent = (i = fetchMock.mock.calls.length - 1): Sent => {
  const [url, init] = fetchMock.mock.calls[i] as [string, RequestInit];
  return { url, method: String(init.method), headers: init.headers as Record<string, string>, body: typeof init.body === "string" ? JSON.parse(init.body) : null };
};

beforeEach(() => {
  fetchMock = vi.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
  client = new AxonClient();
  client.init({ endpoint: "https://x", retryBaseMs: 0, maxRetries: 0 });
});
afterEach(() => vi.restoreAllMocks());

describe("a follow-up", () => {
  it("continues a job hired without signing in, with its token", async () => {
    fetchMock.mockResolvedValueOnce(resp(201, task({ taskId: "t2" })));
    const next = await client.followUp("t1", "Shorter", { claimToken: "tok", allowQuestions: true });
    expect(next.taskId).toBe("t2");
    expect(sent()).toMatchObject({ url: "https://x/api/tasks", method: "POST", body: { from: "anonymous", task: "Shorter", followUpOf: "t1", followUpToken: "tok", allowQuestions: true } });
    // the agent is left out: it stays with the one that did the job
    expect(sent().body).not.toHaveProperty("to");
    expect(sent().body).not.toHaveProperty("claimToken");
  });

  it("signed in, it is made as whoever hired the job, and may bring in another agent", async () => {
    client.init({ endpoint: "https://x", apiKey: "axon_k", retryBaseMs: 0, maxRetries: 0 });
    fetchMock.mockResolvedValueOnce(resp(200, task({ fromAgent: "0xabc" }))).mockResolvedValueOnce(resp(201, task({ taskId: "t2" })));
    await client.followUp("t1", "Restyle it", { to: "design-agent", paymentMethod: "allowance", idempotencyKey: "follow-1" });
    expect(sent(0)).toMatchObject({ url: "https://x/api/tasks/t1", method: "GET" });
    expect(sent(1).body).toMatchObject({ from: "0xabc", to: "design-agent", followUpOf: "t1", paymentMethod: "allowance" });
    expect(sent(1).headers).toMatchObject({ Authorization: "Bearer axon_k", "Idempotency-Key": "follow-1" });
    expect(sent(1).body).not.toHaveProperty("idempotencyKey");
  });
});

describe("acting for the hirer", () => {
  it("answers, decides on a plan, sends a note and stops, each with the job's token", async () => {
    fetchMock.mockResolvedValue(resp(200, task()));
    await client.answerQuestion("t1", "Swedish", { claimToken: "tok" });
    expect(sent()).toMatchObject({ url: "https://x/api/tasks/t1/answer", method: "POST", body: { answer: "Swedish" }, headers: { "X-Claim-Token": "tok" } });
    await client.decidePlan("t1", "change", { claimToken: "tok", change: "Two pages" });
    expect(sent()).toMatchObject({ url: "https://x/api/tasks/t1/plan", body: { action: "change", change: "Two pages" } });
    await client.decidePlan("t1", "approve");
    expect(sent().body).toEqual({ action: "approve" });
    expect(sent().headers).not.toHaveProperty("X-Claim-Token");
    await client.sendNote("t1", "Use euros", { claimToken: "tok" });
    expect(sent()).toMatchObject({ url: "https://x/api/tasks/t1/steer", body: { note: "Use euros" } });
    await client.stopTask("t1", { claimToken: "tok" });
    expect(sent()).toMatchObject({ url: "https://x/api/tasks/t1/stop", method: "POST", headers: { "X-Claim-Token": "tok" } });
  });

  it("reads a job back with its token", async () => {
    fetchMock.mockResolvedValueOnce(resp(200, task({ status: "completed", output: "A line." })));
    expect((await client.getTask("t1", { claimToken: "tok" })).output).toBe("A line.");
    expect(sent().headers).toMatchObject({ "X-Claim-Token": "tok" });
  });
});

describe("waiting for a job that pauses", () => {
  const question = { n: 1, text: "Which language?", choices: ["English", "Swedish"], askedAt: "a", answerBy: "b" };
  const plan = { n: 1, text: "1. Read. 2. Write.", madeAt: "a", answerBy: "b", price: null, changesLeft: 3 };
  const mock = (reads: TaskRequest[]) => {
    const c = { getTask: vi.fn(), answerQuestion: vi.fn(async () => task()), decidePlan: vi.fn(async () => task()) };
    for (const r of reads) c.getTask.mockResolvedValueOnce(r);
    return c;
  };

  it("answers each question once and goes on to the result", async () => {
    const c = mock([task({ status: "waiting", question }), task({ status: "waiting", question }), task({ status: "running" }), task({ status: "completed", output: "Klart." })]);
    const onQuestion = vi.fn(async () => "Swedish");
    const r = await waitForTask(c as unknown as AxonClient, "t1", { claimToken: "tok", pollIntervalMs: 1, onQuestion });
    expect(r).toMatchObject({ timedOut: false, task: { status: "completed", output: "Klart." } });
    expect(onQuestion).toHaveBeenCalledTimes(1);
    expect(c.answerQuestion).toHaveBeenCalledWith("t1", "Swedish", { claimToken: "tok" });
    expect(c.getTask).toHaveBeenCalledWith("t1", { claimToken: "tok" });
  });

  it("approves, changes or cancels a plan as the handler says", async () => {
    const c = mock([task({ status: "waiting", plan }), task({ status: "waiting", plan: { ...plan, n: 2 } }), task({ status: "cancelled" })]);
    const onPlan = vi.fn().mockResolvedValueOnce({ change: "Shorter" }).mockResolvedValueOnce("cancel");
    const r = await waitForTask(c as unknown as AxonClient, "t1", { pollIntervalMs: 1, onPlan });
    expect(r.task.status).toBe("cancelled");
    expect(c.decidePlan.mock.calls).toEqual([["t1", "change", { change: "Shorter" }], ["t1", "cancel", {}]]);
  });

  it("without a handler it leaves the job waiting and gives up at the timeout", async () => {
    const c = mock([]);
    c.getTask.mockResolvedValue(task({ status: "waiting", question }));
    const r = await waitForTask(c as unknown as AxonClient, "t1", { pollIntervalMs: 1, timeoutMs: 15 });
    expect(r).toMatchObject({ timedOut: true, task: { status: "waiting" } });
    expect(c.answerQuestion).not.toHaveBeenCalled();
  });
});

describe("hire()", () => {
  it("reads a hire made without signing in back with its own token, and hands the token and files on", async () => {
    const files = [{ id: "f_1", name: "chart.png", type: "image/png", kind: "image" as const, size: 9, sha256: "ab", token: "ft", path: "/api/files/f_1/content" }];
    const c = {
      getX402Requirements: vi.fn(async () => null),
      sendTask: vi.fn(async () => task({ claimToken: "tok" })),
      getTask: vi.fn(async () => task({ status: "completed", output: "Done.", outputFiles: files })),
      getReceipt: vi.fn(async () => ({ receipt: { taskId: "t1" } })),
      answerQuestion: vi.fn(), decidePlan: vi.fn(),
    };
    const r = await hire(c as unknown as AxonClient, { to: "quill", task: "Chart it", pollIntervalMs: 1, work: { allowQuestions: true, memoryKey: "k".repeat(40), files: [{ id: "f_0", token: "t0" }] } });
    expect(c.sendTask).toHaveBeenCalledWith(expect.objectContaining({ from: "anonymous", to: "quill", allowQuestions: true, memoryKey: "k".repeat(40), files: [{ id: "f_0", token: "t0" }] }));
    expect(c.getTask).toHaveBeenCalledWith("t1", { claimToken: "tok" });
    expect(r).toMatchObject({ status: "completed", output: "Done.", claimToken: "tok", files, timedOut: false });
  });

  it("a job called off is not waited on for ever", async () => {
    const c = {
      getX402Requirements: vi.fn(async () => null),
      sendTask: vi.fn(async () => task()),
      getTask: vi.fn(async () => task({ status: "cancelled" })),
      getReceipt: vi.fn(),
      decidePlan: vi.fn(async () => task()), answerQuestion: vi.fn(),
    };
    const r = await hire(c as unknown as AxonClient, { to: "quill", task: "Long report", pollIntervalMs: 1, timeoutMs: 5_000, work: { planFirst: true } });
    expect(r.status).toBe("cancelled");
    expect(r.timedOut).toBe(false);
    expect(r.error).toMatch(/called off/);
  });
});

describe("memory, the library and files", () => {
  it("reads and forgets an agent's memory by key", async () => {
    fetchMock.mockResolvedValue(resp(200, { lines: [], jobs: 0, most: 20, forgotten: 1 }));
    await client.getAgentMemory("quill", { memoryKey: "mk" });
    expect(sent()).toMatchObject({ url: "https://x/api/agents/quill/memory", method: "GET", headers: { "X-Memory-Key": "mk" } });
    await client.forgetAgentMemory("quill", { memoryKey: "mk", lineId: "m 1" });
    expect(sent()).toMatchObject({ url: "https://x/api/agents/quill/memory/m%201", method: "DELETE" });
    await client.forgetAgentMemory("quill");
    expect(sent().url).toBe("https://x/api/agents/quill/memory");
  });

  it("lists conversations and files, reads one conversation and takes one out", async () => {
    fetchMock.mockResolvedValueOnce(resp(200, { conversations: [{ thread: "t1" }] }));
    expect(await client.listConversations({ agent: "quill agent", limit: 5, memoryKey: "mk" })).toEqual([{ thread: "t1" }]);
    expect(sent()).toMatchObject({ url: "https://x/api/library?agent=quill+agent&limit=5", headers: { "X-Memory-Key": "mk" } });
    fetchMock.mockResolvedValueOnce(resp(200, { conversations: [] }));
    await client.listConversations();
    expect(sent().url).toBe("https://x/api/library");
    fetchMock.mockResolvedValueOnce(resp(200, { files: [{ name: "a.csv" }] }));
    expect(await client.listLibraryFiles({ limit: 3 })).toEqual([{ name: "a.csv" }]);
    expect(sent().url).toBe("https://x/api/library?view=files&limit=3");
    fetchMock.mockResolvedValueOnce(resp(200, { thread: "t1", turns: [] }));
    expect((await client.getConversation("t1")).thread).toBe("t1");
    fetchMock.mockResolvedValueOnce(resp(200, { removed: 2 }));
    expect(await client.removeConversation("t1", { memoryKey: "mk" })).toEqual({ removed: 2 });
    expect(sent()).toMatchObject({ url: "https://x/api/library/t1", method: "DELETE" });
  });

  it("uploads a file by name and bytes, lists its versions and downloads it with its token", async () => {
    fetchMock.mockResolvedValueOnce(resp(201, { file: { id: "f_1", name: "sales.csv", mime: "text/csv", size: 8, sha256: "ab" }, fileToken: "ft" }));
    const up = await client.uploadFile({ name: "sales Q1.csv", data: "a,b\n1,2\n" });
    expect(up).toEqual({ id: "f_1", token: "ft", name: "sales.csv", type: "text/csv", size: 8, sha256: "ab" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://x/api/files");
    expect(init.headers).toMatchObject({ "X-File-Name": "sales%20Q1.csv" });
    expect(new TextDecoder().decode(init.body as Uint8Array)).toBe("a,b\n1,2\n");
    fetchMock.mockResolvedValueOnce(resp(200, { versions: [{ version: 1 }, { version: 2 }] }));
    expect(await client.listFileVersions({ id: "f_1", token: "ft" })).toHaveLength(2);
    expect(sent()).toMatchObject({ url: "https://x/api/files/f_1/versions", headers: { "X-File-Token": "ft" } });
    fetchMock.mockResolvedValueOnce(resp(200, "bytes"));
    expect(new TextDecoder().decode(await client.downloadFile({ path: "/api/files/f_1/content", token: "ft" }))).toBe("bytes");
    expect((fetchMock.mock.calls.at(-1) as [string, RequestInit])[1].headers).toMatchObject({ "X-File-Token": "ft" });
  });
});
