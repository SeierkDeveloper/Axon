// Agents that build, phase 11 (what the real test found). Two things an agent must not lose a build to:
// a job with no room to build is told so before it writes a page, and is not given the tool; and a call that was
// streamed as it was written and turned out not to be JSON is asked for again, whole, instead of failing the job.
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

const sdk = vi.hoisted(() => ({ stream: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => {
  const Stub = class { messages = { create: vi.fn(), stream: sdk.stream }; beta = { files: {} }; };
  (Stub as unknown as { BadRequestError: unknown }).BadRequestError = class BadRequestError extends Error {};
  return { default: Stub, toFile: async () => ({}) };
});

import type { Agent } from "@/sdk/types";
import { getDb } from "@/lib/db";
import { brokenCall, getProvider } from "@/lib/providers";
import { createSite, noRoomForSite, siteLimits } from "@/lib/agentSites";
import { buildTool, noRoomNote, noRoomToBuild } from "@/lib/buildTool";
import { checkRateLimit, peekRateLimit } from "@/lib/rateLimit";

const ON = { AGENT_SITES: "on" };
const saved = { ...process.env };
beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = "test-key-mock";
  getDb().exec("DELETE FROM built_site_reports; DELETE FROM built_site_files; DELETE FROM built_site_versions; DELETE FROM built_sites; DELETE FROM rate_limit_windows;");
});
afterEach(() => {
  sdk.stream.mockReset();
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});

const page = [{ path: "index.html", content: `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>T</title></head><body><h1>Hello</h1></body></html>` }];

describe("room to build, asked before the agent starts", () => {
  it("there is room for a first page, and asking counts nothing", () => {
    expect(noRoomToBuild({ taskId: "t1", ownerMark: "0xabc", env: ON })).toBeNull();
    expect(noRoomToBuild({ taskId: "t1", ownerMark: "0xabc", env: ON })).toBeNull();
    expect(peekRateLimit("sites:day")).toBe(0);
  });

  it("none once the person has had their day's pages, and the store says the same thing when asked to make one", () => {
    const limits = siteLimits({ ...ON, AXON_SITE_PER_DAY: "2" });
    for (const taskId of ["a", "b"]) expect(createSite({ taskId, agentId: "agent-1", ownerMark: "0xabc", title: "A page" }, limits).ok).toBe(true);
    const why = noRoomToBuild({ taskId: "c", ownerMark: "0xabc", env: { ...ON, AXON_SITE_PER_DAY: "2" } });
    expect(why).toMatch(/2 sites built in the last day/);
    expect(noRoomForSite({ taskId: "c", ownerMark: "0xabc" }, limits)).toBe(why);
    const refused = createSite({ taskId: "c", agentId: "agent-1", ownerMark: "0xabc", title: "A third" }, limits);
    expect(refused).toEqual({ ok: false, why });
    // somebody else still has room
    expect(noRoomToBuild({ taskId: "c", ownerMark: "0xdef", env: { ...ON, AXON_SITE_PER_DAY: "2" } })).toBeNull();
  });

  it("a job that changes a page it already has needs no room for a new one", () => {
    const limits = siteLimits({ ...ON, AXON_SITE_PER_DAY: "1" });
    const made = createSite({ taskId: "a", agentId: "agent-1", ownerMark: "0xabc", title: "A page" }, limits);
    expect(made.ok).toBe(true);
    const env = { ...ON, AXON_SITE_PER_DAY: "1" };
    expect(noRoomToBuild({ taskId: "b", ownerMark: "0xabc", env })).toMatch(/most a day allows/);
    expect(noRoomToBuild({ taskId: "b", ownerMark: "0xabc", continueSite: made.ok ? made.site.siteId : "", env })).toBeNull();
  });

  it("none once the network has had its builds for the day, whoever asks and whatever page it is", async () => {
    const env = { ...ON, AGENT_SITES_DAILY_MAX: "2" };
    const tool = buildTool({ taskId: "t1", agentId: "agent-1", ownerMark: "0xabc", paid: true, env });
    await tool.run({ title: "One", files: page });
    expect(noRoomToBuild({ taskId: "t2", ownerMark: "0xdef", env })).toBeNull();
    await tool.run({ title: "One", files: page });
    expect(peekRateLimit("sites:day")).toBe(2);
    expect(noRoomToBuild({ taskId: "t2", ownerMark: "0xdef", env })).toMatch(/nothing more can be built today/);
    expect(noRoomToBuild({ taskId: "t2", ownerMark: "0xdef", continueSite: "anything", env })).toMatch(/nothing more can be built today/);
    // asking did not use a build up
    expect(peekRateLimit("sites:day")).toBe(2);
    // and a cap of nought means none at all
    expect(noRoomToBuild({ taskId: "t3", ownerMark: "0xdef", env: { ...ON, AGENT_SITES_DAILY_MAX: "0" } })).toMatch(/nothing more can be built today/);
  });

  it("a window that has run out counts as empty", () => {
    getDb().prepare("INSERT INTO rate_limit_windows (key, count, reset_at) VALUES ('sites:day', 99, ?)").run(Date.now() - 1000);
    expect(peekRateLimit("sites:day")).toBe(0);
    expect(checkRateLimit("sites:day", 5, 86_400_000).allowed).toBe(true);
  });

  it("the agent is told plainly, and told not to write the page out instead", () => {
    const note = noRoomNote("this person has had 10 sites built in the last day, which is the most a day allows. An existing one can still be changed.");
    expect(note).toMatch(/NOTHING CAN BE BUILT IN THIS JOB/);
    expect(note).toMatch(/10 sites built in the last day/);
    expect(note).toMatch(/You do not have the build tool/);
    expect(note).toMatch(/Do not write out the page's code/);
    expect(note).not.toMatch(/—/);
  });
});

describe("a call that was streamed and is not JSON", () => {
  const agent: Agent = { agentId: "legal-agent", name: "Legal Agent", capabilities: ["contract review"], publicKey: "pk", provider: "anthropic", reputation: 0, createdAt: new Date().toISOString() };
  const reply = (content: unknown[]) => ({ on() { return this; }, finalMessage: async () => ({ content, stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } }) });
  const broken = (err: unknown) => ({ on() { return this; }, finalMessage: async () => { throw err; } });
  const local = (name: string, eager?: boolean) => ({ name, label: name, description: "d", inputSchema: { type: "object", properties: {} }, ...(eager ? { eager } : {}), run: async () => "ok" });
  const tools = { serverTools: [], localTools: [local("build_page", true), local("remember")], grants: [] };
  const eagerOf = (call: number) => (sdk.stream.mock.calls[call][0] as { tools: { name: string; eager_input_streaming?: boolean }[] }).tools.find((t) => t.name === "build_page")!.eager_input_streaming;

  it("knows the parser's errors from any other", () => {
    expect(brokenCall(new SyntaxError("Expected ',' or '}' after property value in JSON at position 118"))).toBe(true);
    // the library hands it on as an error of its own, with the same words
    expect(brokenCall(new Error("Expected ',' or '}' after property value in JSON at position 118"))).toBe(true);
    expect(brokenCall(new Error("Unexpected end of JSON input"))).toBe(true);
    expect(brokenCall(Object.assign(new Error("stream failed"), { cause: new SyntaxError("Unterminated string in JSON at position 9") }))).toBe(true);
    expect(brokenCall(new Error("529 overloaded"))).toBe(false);
    expect(brokenCall(new Error("Request timed out"))).toBe(false);
    expect(brokenCall(null)).toBe(false);
  });

  it("is asked for again, whole, and the job goes on to its answer", async () => {
    sdk.stream
      .mockReturnValueOnce(broken(new Error("Expected ',' or '}' after property value in JSON at position 118")))
      .mockReturnValueOnce(reply([{ type: "text", text: "Built your form." }]));
    await expect(getProvider(agent).completeWithTools!("s", "Make an RSVP form", 1000, tools, {})).resolves.toBe("Built your form.");
    expect(sdk.stream).toHaveBeenCalledTimes(2);
    expect(eagerOf(0)).toBe(true);
    expect(eagerOf(1)).toBeUndefined();
  });

  it("only once: a second such failure is the job's failure, as is any other error", async () => {
    const bad = new Error("Unexpected end of JSON input");
    sdk.stream.mockReturnValueOnce(broken(bad)).mockReturnValueOnce(broken(bad));
    await expect(getProvider(agent).completeWithTools!("s", "Make an RSVP form", 1000, tools, {})).rejects.toThrow(/Unexpected end of JSON input/);
    expect(sdk.stream).toHaveBeenCalledTimes(2);
    sdk.stream.mockReset();
    sdk.stream.mockReturnValueOnce(broken(new Error("400 invalid request")));
    await expect(getProvider(agent).completeWithTools!("s", "Make an RSVP form", 1000, tools, {})).rejects.toThrow(/400 invalid request/);
    expect(sdk.stream).toHaveBeenCalledTimes(1);
  });

  it("a job with no tool that streams its calls is left as it was", async () => {
    sdk.stream.mockReturnValueOnce(broken(new Error("Unexpected end of JSON input")));
    await expect(getProvider(agent).completeWithTools!("s", "Remember this", 1000, { serverTools: [], localTools: [local("remember")], grants: [] }, {})).rejects.toThrow(/Unexpected end of JSON input/);
    expect(sdk.stream).toHaveBeenCalledTimes(1);
  });
});
