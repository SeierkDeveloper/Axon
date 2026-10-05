// Agent Minds, phase 3: what the launch screen signs, the picture it uploads, and Mylo getting a launch ready.
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("@/lib/embeddings", async (orig) => ({
  ...(await orig<typeof import("@/lib/embeddings")>()),
  generateEmbedding: async () => null,
  scheduleAgentEmbedding: () => {},
}));
vi.mock("@/lib/agentDescription", async (orig) => ({
  ...(await orig<typeof import("@/lib/agentDescription")>()),
  scheduleAgentDescription: () => {},
}));

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "crypto";
import { decodeFunctionData, encodeFunctionData, parseEther } from "viem";
import { getDb } from "@/lib/db";
import { createAgent } from "@/lib/agents";
import { CAN, CEILINGS, DEFAULT_SETTINGS, MIND_LAUNCH_ABI, checkSettings, creatorBps, launchInput, launchValue, lockedSummary, type LaunchSettings } from "@/lib/mindsLaunch";
import { imageKind, saveLogo, getLogo, LOGO_LIMITS } from "@/lib/mindsLogo";
import { prepare, launchableAgents } from "@/lib/mindsAgent";
import { upsertToken } from "@/lib/mindsStore";
import { runTool, myloToolDefs, MYLO_TOOL_DEFS } from "@/lib/myloTools";
import { startConversation } from "@/lib/myloStore";
import type { Agent } from "@/sdk/types";

let n = 0;
const wallet = () => `0x${(++n + 9_300_000).toString(16).padStart(40, "0")}`;
const REF = `0x${"ab".repeat(32)}` as const;
const settings = (over: Partial<LaunchSettings> = {}): LaunchSettings => ({ ...DEFAULT_SETTINGS, payout: wallet(), ...over });
const ownAgent = (w: string, name: string): Agent =>
  createAgent({ agentId: `mine-${randomUUID().slice(0, 8)}`, name, capabilities: ["x"], publicKey: "k", provider: "anthropic", walletAddress: w, createdAt: new Date().toISOString() } as Agent);

afterEach(() => { vi.unstubAllEnvs(); });

// ── The struct the screen signs, against the contract's own source ────────────

const SOL = (p: string) => readFileSync(join(process.cwd(), "contracts", p), "utf8");

/** Fields of a Solidity struct, in declaration order, as [type, name] pairs. */
function structFields(source: string, name: string): [string, string][] {
  const body = new RegExp(`struct\\s+${name}\\s*\\{([^}]*)\\}`).exec(source)?.[1];
  if (!body) throw new Error(`struct ${name} not found`);
  return body.split(";").map((l) => l.replace(/\/\/[^\n]*/g, "").trim()).filter(Boolean).map((l) => {
    const parts = l.split(/\s+/);
    return [parts.slice(0, -1).join(" ").replace(" payable", ""), parts[parts.length - 1]] as [string, string];
  });
}

describe("the launch call", () => {
  const launch = MIND_LAUNCH_ABI.find((x) => x.type === "function" && x.name === "launch")!;
  const input = (launch as { inputs: readonly { components: readonly { name: string; type: string; components?: readonly { name: string; type: string }[] }[] }[] }).inputs[0].components;

  it("is the launcher's own struct, field for field and in order", () => {
    const sol = structFields(SOL("src/MindLauncher.sol"), "LaunchInput");
    expect(input.map((c) => c.name)).toEqual(sol.map(([, name]) => name));
    const flat = sol.map(([type]) => (type === "IPonsV2LaunchFactory.Socials" || type === "MindVault.Limits" ? "tuple" : type));
    expect(input.map((c) => c.type)).toEqual(flat);
  });

  it("nests the socials and the mind's limits exactly as their own contracts declare them", () => {
    const socials = structFields(SOL("src/interfaces/IPons.sol"), "Socials");
    const limits = structFields(SOL("src/MindVault.sol"), "Limits");
    expect(input.find((c) => c.name === "socials")!.components!.map((c) => [c.type, c.name])).toEqual(socials);
    expect(input.find((c) => c.name === "limits")!.components!.map((c) => [c.type, c.name])).toEqual(limits);
  });

  it("reads the launcher's own event", () => {
    const sol = /event Launched\(([^)]*)\)/.exec(SOL("src/MindLauncher.sol"))![1].split(",").map((p) => p.trim().split(/\s+/)).map((p) => [p[0], p[p.length - 1], p.includes("indexed")]);
    const ev = MIND_LAUNCH_ABI.find((x) => x.type === "event" && x.name === "Launched") as { inputs: readonly { type: string; name: string; indexed?: boolean }[] };
    expect(ev.inputs.map((i) => [i.type, i.name, Boolean(i.indexed)])).toEqual(sol);
  });

  it("knows the same ceilings the contracts enforce", () => {
    expect(SOL("src/MindLauncher.sol")).toContain(`MAX_TAX_BPS = ${CEILINGS.taxBps}`);
    expect(SOL("src/MindVault.sol")).toContain(`MAX_ACTIONS_PER_DAY = ${CEILINGS.actionsPerDay}`);
    expect(SOL("src/MindVault.sol")).toContain(`MAX_COST_PER_DAY = ${CEILINGS.costPerDayEth} ether`);
    const flags = SOL("src/MindVault.sol");
    expect(flags).toContain(`CAN_BUYBACK = ${CAN.buyback}`);
    expect(flags).toContain(`CAN_REWARD = ${CAN.reward}`);
    expect(flags).toContain(`CAN_BURN_AXON = ${CAN.burnAxon}`);
  });

  it("carries what the creator chose and gives them whatever the three shares leave", () => {
    const s = settings({ taxBps: 500, burnBps: 3000, axonBps: 500, mindBps: 1500, canReward: false, maxPerDayEth: "0.2", maxPerActionEth: "0.05", maxActionsPerDay: 12, maxCostPerDayEth: "0.004", twitter: "https://x.com/lens" });
    const data = encodeFunctionData({ abi: MIND_LAUNCH_ABI, functionName: "launch", args: [launchInput({ name: "Ledger Lens", symbol: "LENS", logo: "https://a/b.png", description: "Reads filings" }, REF, s)] });
    const back = decodeFunctionData({ abi: MIND_LAUNCH_ABI, data }).args![0] as ReturnType<typeof launchInput>;
    expect(back).toMatchObject({ name: "Ledger Lens", symbol: "LENS", logo: "https://a/b.png", salt: REF, agentRef: REF, taxBps: 500, creatorBps: 5000, burnBps: 3000, axonBps: 500, mindBps: 1500 });
    expect(back.payout.toLowerCase()).toBe(s.payout);
    expect(back.socials).toMatchObject({ twitter: "https://x.com/lens", telegram: "", website: "" });
    expect(back.limits).toEqual({ allowed: CAN.buyback | CAN.burnAxon, maxPerDay: parseEther("0.2"), maxPerAction: parseEther("0.05"), maxActionsPerDay: 12, maxCostPerDay: parseEther("0.004") });
    expect(back.creatorBps + back.burnBps + back.axonBps + back.mindBps).toBe(10_000);
  });

  it("sends the launch fee plus a first buy of any size", () => {
    const fee = parseEther("0.0005");
    expect(launchValue(fee, { openingBuyEth: "" })).toBe(fee);
    expect(launchValue(fee, { openingBuyEth: "0.01" })).toBe(fee + parseEther("0.01"));
    expect(launchValue(fee, { openingBuyEth: "25" })).toBe(fee + parseEther("25"));
  });
});

describe("the settings a creator can choose", () => {
  it("opens with settings that can launch as they are", () => {
    const s = settings();
    expect(checkSettings(s)).toBeNull();
    expect(creatorBps(s)).toBe(5000);
  });

  it("refuses what the contracts would refuse, in words", () => {
    expect(checkSettings(settings({ taxBps: 1001 }))).toMatch(/0 and 10%/);
    expect(checkSettings(settings({ burnBps: 6000, axonBps: 3000, mindBps: 2000 }))).toMatch(/100%/);
    expect(checkSettings(settings({ payout: "0x123" }))).toMatch(/payout/);
    expect(checkSettings(settings({ payout: `0x${"0".repeat(40)}` }))).toMatch(/zero address/);
    expect(checkSettings(settings({ maxPerDayEth: "0.01", maxPerActionEth: "0.02" }))).toMatch(/One action/);
    expect(checkSettings(settings({ maxActionsPerDay: 25 }))).toMatch(/24 times/);
    expect(checkSettings(settings({ maxCostPerDayEth: "0.02" }))).toMatch(/0\.01 ETH a day/);
    expect(checkSettings(settings({ openingBuyEth: "lots" }))).toMatch(/first buy/);
    expect(checkSettings(settings({ website: "javascript:alert(1)" }))).toMatch(/https/);
  });

  it("takes everything for the creator, nothing for the creator, a tax of nothing and a first buy of any size", () => {
    expect(checkSettings(settings({ burnBps: 0, axonBps: 0, mindBps: 0 }))).toBeNull();
    expect(checkSettings(settings({ burnBps: 5000, axonBps: 0, mindBps: 5000 }))).toBeNull();
    expect(checkSettings(settings({ taxBps: 0 }))).toBeNull();
    expect(checkSettings(settings({ taxBps: 1000, openingBuyEth: "40" }))).toBeNull();
  });

  it("states what gets locked, and that Axon's share is nothing", () => {
    const s = settings({ canReward: false });
    const rows = Object.fromEntries(lockedSummary("LENS", s).map((r) => [r.label, r.value]));
    expect(rows["Tax on every trade"]).toBe("3%");
    expect(rows["Burns $LENS"]).toBe("20%");
    expect(rows["Burns $AXON"]).toBe("10%");
    expect(rows["To the mind"]).toBe("20%");
    expect(rows["The mind may"]).toBe("buy back and burn $LENS, burn $AXON");
    expect(rows["To Axon"]).toBe("0%");
    expect(Object.keys(rows).find((k) => k.startsWith("To you"))).toContain(`${s.payout.slice(0, 6)}…${s.payout.slice(-4)}`);
  });
});

describe("a token's picture", () => {
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(randomUUID())]);

  it("is known by its own bytes, not by what it is called", () => {
    expect(imageKind(PNG)).toBe("image/png");
    expect(imageKind(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]))).toBe("image/jpeg");
    expect(imageKind(Buffer.from("RIFF0000WEBPVP8 ", "latin1"))).toBe("image/webp");
    expect(imageKind(Buffer.from("GIF89a000", "latin1"))).toBe("image/gif");
    expect(imageKind(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>"))).toBeNull();
    expect(imageKind(Buffer.from("<!doctype html>"))).toBeNull();
  });

  it("is kept once under the hash of its bytes and read back the same", () => {
    const me = wallet();
    const a = saveLogo(me, PNG), b = saveLogo(wallet(), PNG);
    if (typeof a === "string" || typeof b === "string") throw new Error("not saved");
    expect(a.id).toMatch(/^[0-9a-f]{40}$/);
    expect(b.id).toBe(a.id);
    expect(getLogo(a.id)).toMatchObject({ mime: "image/png" });
    expect(Buffer.compare(getLogo(a.id)!.bytes, PNG)).toBe(0);
    expect(getLogo("../../etc/passwd")).toBeNull();
    expect(getLogo("0".repeat(40))).toBeNull();
  });

  it("refuses what is not a small picture, and a wallet that sends picture after picture", () => {
    const me = wallet();
    expect(saveLogo(me, Buffer.alloc(0))).toMatch(/empty/);
    expect(saveLogo(me, Buffer.from("just some text"))).toMatch(/PNG, JPEG, WebP or GIF/);
    expect(saveLogo(me, Buffer.concat([PNG, Buffer.alloc(LOGO_LIMITS.bytes)]))).toMatch(/too large/);
    for (let i = 0; i < LOGO_LIMITS.perDay; i++) expect(typeof saveLogo(me, Buffer.concat([PNG, Buffer.from(String(i))]))).toBe("object");
    expect(saveLogo(me, Buffer.concat([PNG, Buffer.from("one more")]))).toMatch(/tomorrow/);
  });

  it("links a picture over http only from a server on this machine, never in production", () => {
    const me = wallet();
    const ask = { name: "Ledger Lens", symbol: "LENS", line: "Explains company filings well", logo: "http://localhost:3000/api/minds/logo/abc" };
    expect(typeof prepare(me, ask)).toBe("object");
    expect(prepare(me, { ...ask, logo: "http://evil.example/x.png" })).toMatch(/https or ipfs/);
    vi.stubEnv("NODE_ENV", "production");
    expect(prepare(me, ask)).toMatch(/https or ipfs/);
  });
});

describe("an agent the wallet already owns", () => {
  it("can be picked until a token stands behind it", () => {
    const me = wallet();
    const a = ownAgent(me, "Free Agent"), b = ownAgent(me, "Taken Agent");
    ownAgent(wallet(), "Somebody Else's");
    upsertToken({ token: wallet(), creator: me, agentId: b.agentId, agentRef: REF, pot: wallet(), splitter: wallet(), vault: wallet(), payout: me, taxBps: 300, creatorBps: 5000, burnBps: 2000, axonBps: 1000, mindBps: 2000, attached: false, name: "T", symbol: "T", logo: null, description: null, blockNumber: 1, txHash: `0x${"c".repeat(64)}`, launchedAt: new Date().toISOString() });
    expect(launchableAgents(me.toUpperCase().replace("0X", "0x"))).toEqual([{ agentId: a.agentId, name: "Free Agent" }]);
  });
});

describe("Mylo getting a launch ready", () => {
  const ctx = (w: string) => ({ wallet: w, owner: w, conversationId: startConversation(w, "t").id });

  it("is the tool it always was while Agent Minds is off", async () => {
    vi.stubEnv("AGENT_MINDS", "off");
    expect(myloToolDefs()).toBe(MYLO_TOOL_DEFS);
    const out = await runTool("launch_token", { name: "Ledger Lens", ticker: "lens", what_the_agent_does: "Reads a company's filings and explains what changed" }, ctx(wallet()));
    expect(out.result).toMatchObject({ can_launch: false });
    expect(out.card).toBeUndefined();
  });

  it("fills in the one launch screen from a sentence, for a new agent", async () => {
    vi.stubEnv("AGENT_MINDS", "on");
    const def = myloToolDefs().find((t) => t.name === "launch_token")!;
    expect(def.description).toMatch(/new agent/);
    expect(myloToolDefs().length).toBe(MYLO_TOOL_DEFS.length);
    const out = await runTool("launch_token", { name: "Ledger Lens", ticker: "$lens", what_the_agent_does: "Reads a company's filings and explains what changed" }, ctx(wallet()));
    expect(out.result).toMatchObject({ can_launch: true, filled_in: { name: "Ledger Lens", ticker: "LENS" } });
    expect(out.card).toMatchObject({ kind: "launch", agentId: null, name: "Ledger Lens", ticker: "LENS" });
    const page = new URL((out.card as { page: string }).page, "https://x");
    expect(page.pathname).toBe("/launch");
    expect(Object.fromEntries(page.searchParams)).toEqual({ name: "Ledger Lens", ticker: "LENS", line: "Reads a company's filings and explains what changed" });
  });

  it("asks what the agent does before it prepares anything", async () => {
    vi.stubEnv("AGENT_MINDS", "on");
    const out = await runTool("launch_token", { name: "Ledger Lens", ticker: "LENS" }, ctx(wallet()));
    expect(out.result).toMatchObject({ can_launch: false, why_not: expect.stringMatching(/one line/) });
    expect(out.card).toBeUndefined();
  });

  it("takes one of their own agents, and nobody else's", async () => {
    vi.stubEnv("AGENT_MINDS", "on");
    const me = wallet();
    const mine = ownAgent(me, "My Analyst");
    const out = await runTool("launch_token", { agent_id: mine.agentId, name: "Analyst", ticker: "ANLST" }, ctx(me));
    expect(out.card).toMatchObject({ kind: "launch", agentId: mine.agentId, agentName: "My Analyst", page: `/launch?agent=${mine.agentId}&name=Analyst&ticker=ANLST` });
    const theirs = await runTool("launch_token", { agent_id: mine.agentId, name: "Analyst", ticker: "ANLST" }, ctx(wallet()));
    expect(theirs.result).toMatchObject({ can_launch: false });
    expect(theirs.card).toBeUndefined();
  });
});

describe("the tables", () => {
  it("keeps pictures where the migration put them", () => {
    const cols = (getDb().prepare("PRAGMA table_info(mind_logos)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(["id", "wallet", "mime", "bytes", "size", "created_at"]);
  });
});
