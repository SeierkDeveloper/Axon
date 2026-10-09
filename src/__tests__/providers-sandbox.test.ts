// Files for agents, phase 4: an agent that runs code. The model SDK is replaced with a stub, so what is checked is our
// side of it: the hire's files go into the sandbox, every run is recorded, what it wrote is fetched and handed over,
// and nothing is left behind with the provider.
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

const sdk = vi.hoisted(() => ({
  stream: vi.fn(),
  upload: vi.fn(),
  meta: vi.fn(),
  download: vi.fn(),
  del: vi.fn(),
  BadRequestError: class BadRequestError extends Error {},
}));
vi.mock("@anthropic-ai/sdk", () => {
  const Stub = class {
    messages = { create: vi.fn(), stream: sdk.stream };
    beta = { files: { upload: sdk.upload, retrieveMetadata: sdk.meta, download: sdk.download, delete: sdk.del } };
  };
  (Stub as unknown as { BadRequestError: unknown }).BadRequestError = sdk.BadRequestError;
  return { default: Stub, toFile: async (bytes: Buffer, name: string, o: { type: string }) => ({ bytes, name, type: o.type }) };
});

import type { Agent } from "@/sdk/types";
import { getProvider, CODE_NOTE, type ToolCallEvent, type SandboxFile } from "@/lib/providers";
import { CODE_TOOL, hasCode, withCode, resolveAgentTools, type ResolvedTools } from "@/lib/agentTools";
import { codeEnabled } from "@/lib/agentFiles";

const saved = { ...process.env };
beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = "test-key-mock";
  sdk.upload.mockImplementation(async ({ file }: { file: { name: string } }) => ({ id: `file_in_${file.name}` }));
  sdk.del.mockResolvedValue({});
});
afterEach(() => {
  for (const f of Object.values(sdk)) if (typeof (f as { mockReset?: () => void }).mockReset === "function") (f as { mockReset: () => void }).mockReset();
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});

const agent: Agent = { agentId: "data-agent", name: "Data Agent", capabilities: ["analysis"], publicKey: "pk", provider: "anthropic", reputation: 0, createdAt: new Date().toISOString() };
const reply = (content: unknown[], over: Record<string, unknown> = {}) => ({ finalMessage: async () => ({ content, stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 }, container: { id: "cntr_1" }, ...over }) });
const CSV: SandboxFile = { name: "sales.csv", mime: "text/csv", bytes: Buffer.from("Quarter,Revenue\nQ1,120\n") };
const ran = (id: string, command: string, stdout: string, files: string[] = [], over: Record<string, unknown> = {}) => [
  { type: "server_tool_use", id, name: "bash_code_execution", input: { command } },
  { type: "bash_code_execution_tool_result", tool_use_id: id, content: { type: "bash_code_execution_result", stdout, stderr: "", return_code: 0, content: files.map((file_id) => ({ type: "bash_code_execution_output", file_id })), ...over } },
];

describe("the switch and the grant", () => {
  it("running code is on only when both switches are", () => {
    expect(codeEnabled({})).toBe(false);
    expect(codeEnabled({ AGENT_CODE: "on" })).toBe(false);
    expect(codeEnabled({ AGENT_FILES: "on" })).toBe(false);
    expect(codeEnabled({ AGENT_FILES: "on", AGENT_CODE: "on" })).toBe(true);
  });

  it("the grant resolves to the sandbox only while code is switched on", () => {
    process.env.AGENT_FILES = "on";
    process.env.AGENT_CODE = "off";
    expect(resolveAgentTools(["code_execution"])).toEqual({ serverTools: [], localTools: [], grants: [] });
    process.env.AGENT_CODE = "on";
    const t = resolveAgentTools(["web_search", "code_execution"]);
    expect(t.grants).toEqual(["web_search", "code_execution"]);
    expect(hasCode(t)).toBe(true);
    expect(t.serverTools).toContainEqual(CODE_TOOL);
  });

  it("the sandbox is added once and nothing else is disturbed", () => {
    expect(hasCode(null)).toBe(false);
    const fresh = withCode(null);
    expect(fresh).toEqual({ serverTools: [CODE_TOOL], localTools: [], grants: ["code_execution"] });
    expect(withCode(fresh)).toBe(fresh);
    const web: ResolvedTools = { serverTools: [{ type: "web_search_20260209", name: "web_search" }], localTools: [], grants: ["web_search"] };
    expect(withCode(web).serverTools).toHaveLength(2);
    expect(web.serverTools).toHaveLength(1);
  });
});

describe("an agent that runs code", () => {
  it("has the hire's files put in its sandbox, is told it can run code, and its runs are recorded", async () => {
    sdk.stream.mockReturnValueOnce(reply([...ran("srv_1", "python3 -c 'print(120)'", "120\n"), { type: "text", text: "Q1 revenue was 120." }]));
    const events: ToolCallEvent[] = [];
    const out = await getProvider(agent).completeWithTools!("You analyse data.", "What was Q1 revenue?", 1000, withCode(null), { onToolCall: (e) => events.push(e), sandbox: { files: [CSV] } });
    expect(out).toBe("Q1 revenue was 120.");
    expect(sdk.upload).toHaveBeenCalledTimes(1);
    const [params, options] = sdk.stream.mock.calls[0] as [{ system: string; messages: { content: unknown }[]; tools: unknown[] }, { headers?: Record<string, string> }];
    expect(params.system).toBe(`You analyse data.${CODE_NOTE}`);
    expect(params.tools).toContainEqual(CODE_TOOL);
    expect(params.messages[0].content).toEqual([{ type: "text", text: "What was Q1 revenue?" }, { type: "container_upload", file_id: "file_in_sales.csv" }]);
    expect(options.headers).toEqual({ "anthropic-beta": "files-api-2025-04-14" });
    expect(events).toEqual([{ tool: "bash_code_execution", kind: "code", ok: true, latencyMs: null, input: JSON.stringify({ command: "python3 -c 'print(120)'" }), output: "120\n" }]);
    // nothing of the job is left with the provider
    expect(sdk.del).toHaveBeenCalledWith("file_in_sales.csv");
  });

  it("is handed back what the code wrote, and those files are removed from the provider too", async () => {
    sdk.stream.mockReturnValueOnce(reply([...ran("srv_1", "python3 chart.py", "saved\n", ["file_out_1", "file_out_2"]), { type: "text", text: "Chart attached." }]));
    sdk.meta.mockImplementation(async (id: string) => ({ filename: id === "file_out_1" ? "revenue.png" : "summary.csv", mime_type: id === "file_out_1" ? "image/png" : "text/csv", size_bytes: 12 }));
    sdk.download.mockImplementation(async (id: string) => new Response(Buffer.from(`bytes of ${id}`)));
    const got: SandboxFile[] = [];
    await getProvider(agent).completeWithTools!("s", "Draw it", 1000, withCode(null), { sandbox: { files: [CSV], onFile: (f) => { got.push(f); } } });
    expect(got.map((f) => [f.name, f.mime, f.bytes.toString()])).toEqual([["revenue.png", "image/png", "bytes of file_out_1"], ["summary.csv", "text/csv", "bytes of file_out_2"]]);
    expect(sdk.del.mock.calls.map((c) => c[0]).sort()).toEqual(["file_in_sales.csv", "file_out_1", "file_out_2"]);
  });

  it("hands a file back once, as it stood last, when the code wrote it more than once", async () => {
    sdk.stream.mockReturnValueOnce(reply([...ran("srv_1", "python3 chart.py", "saved\n", ["draft_chart", "notes"]), ...ran("srv_2", "python3 chart.py", "saved\n", ["final_chart"]), { type: "text", text: "Chart attached." }]));
    sdk.meta.mockImplementation(async (id: string) => (id === "notes" ? { filename: "notes.csv", mime_type: "text/csv", size_bytes: 9 } : { filename: "revenue.png", mime_type: "image/png", size_bytes: 12 }));
    sdk.download.mockImplementation(async (id: string) => new Response(Buffer.from(`bytes of ${id}`)));
    const got: SandboxFile[] = [];
    await getProvider(agent).completeWithTools!("s", "Draw it", 1000, withCode(null), { sandbox: { files: [], onFile: (f) => { got.push(f); } } });
    expect(got.map((f) => [f.name, f.bytes.toString()])).toEqual([["notes.csv", "bytes of notes"], ["revenue.png", "bytes of final_chart"]]);
    // the draft is still removed from the provider
    expect(sdk.del.mock.calls.map((c) => c[0]).sort()).toEqual(["draft_chart", "final_chart", "notes"]);
  });

  it("keeps the same sandbox across the calls of one job", async () => {
    sdk.stream
      .mockReturnValueOnce(reply(ran("srv_1", "ls", "sales.csv\n"), { stop_reason: "pause_turn" }))
      .mockReturnValueOnce(reply([{ type: "text", text: "Done." }]));
    await getProvider(agent).completeWithTools!("s", "Look", 1000, withCode(null), { sandbox: { files: [] } });
    expect((sdk.stream.mock.calls[0][0] as { container?: string }).container).toBeUndefined();
    expect((sdk.stream.mock.calls[1][0] as { container?: string }).container).toBe("cntr_1");
    // with no files to put in, the request carries no upload and no extra header
    expect((sdk.stream.mock.calls[0][0] as { messages: { content: unknown }[] }).messages[0].content).toBe("Look");
    expect((sdk.stream.mock.calls[0][1] as { headers?: unknown }).headers).toBeUndefined();
  });

  it("records a run that failed as failed, skips an oversized file, and still answers when an upload fails", async () => {
    sdk.upload.mockRejectedValueOnce(new Error("upload refused"));
    sdk.stream.mockReturnValueOnce(reply([
      ...ran("srv_1", "python3 broken.py", "", [], { return_code: 1, stderr: "Traceback: boom" }),
      { type: "server_tool_use", id: "srv_2", name: "bash_code_execution", input: { command: "sleep 999" } },
      { type: "bash_code_execution_tool_result", tool_use_id: "srv_2", content: { type: "bash_code_execution_tool_result_error", error_code: "execution_time_exceeded" } },
      ...ran("srv_3", "python3 big.py", "ok\n", ["file_big"]),
      { type: "text", text: "Partly done." },
    ]));
    sdk.meta.mockResolvedValue({ filename: "huge.bin", mime_type: "application/octet-stream", size_bytes: 50 * 1024 * 1024 });
    const events: ToolCallEvent[] = [], got: SandboxFile[] = [];
    const out = await getProvider(agent).completeWithTools!("s", "Try", 1000, withCode(null), { onToolCall: (e) => events.push(e), sandbox: { files: [CSV], onFile: (f) => { got.push(f); } } });
    expect(out).toBe("Partly done.");
    expect(events.map((e) => [e.ok, e.error ?? null])).toEqual([[false, null], [false, "execution_time_exceeded"], [true, null]]);
    expect(events[0].output).toContain("[stderr]\nTraceback: boom");
    expect(got).toEqual([]);
    expect(sdk.download).not.toHaveBeenCalled();
    // the first turn has no upload block, since the upload failed
    expect((sdk.stream.mock.calls[0][0] as { messages: { content: unknown }[] }).messages[0].content).toBe("Try");
  });

  it("an agent without the sandbox is run exactly as before", async () => {
    sdk.stream.mockReturnValueOnce(reply([{ type: "text", text: "Plain." }]));
    const web: ResolvedTools = { serverTools: [{ type: "web_search_20260209", name: "web_search" }], localTools: [], grants: ["web_search"] };
    await getProvider(agent).completeWithTools!("System.", "Hello", 1000, web, { sandbox: { files: [CSV] } });
    expect(sdk.upload).not.toHaveBeenCalled();
    expect((sdk.stream.mock.calls[0][0] as { system: string }).system).toBe("System.");
  });
});
