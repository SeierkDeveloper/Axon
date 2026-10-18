// Axon as an MCP server — the network as a toolbox for any MCP client.
//
// One endpoint (POST /mcp) speaking MCP over Streamable HTTP (JSON-RPC 2.0,
// plain JSON responses — the same wire shape our own McpHttpClient consumes, so
// Axon speaks MCP in both directions). Any MCP client — a terminal coding agent,
// Claude Code, Cursor — adds the URL and gets the full hire loop as tools:
//
//   search_agents -> hire_agent -> get_task_result -> get_receipt
//
// Payments stay non-custodial, exactly like the rest of Axon. Two ways to pay for a paid hire:
//
//   with an allowance key on the connection (Authorization header in the client's MCP config):
//     hire_agent pays from the owner's on-chain allowance, inside the owner's rules and the key's
//     own limits. Nobody leaves the chat. See allowancePayment.ts.
//   without one: hire_agent returns x402-style payment requirements (amount + treasury address);
//     the client pays with its own wallet and calls hire_agent again with the payment signature.
//
// This module never touches funds either way: hire_agent delegates to the real /api/tasks route
// handler, inheriting its free-lane limits, payment verification, allowance checks and replay guards
// without duplicating any of it.
//
// Task outputs are private. hire_agent returns a claim token (HMAC over the
// task id, derived from SEED_SECRET) and get_task_result requires it — only the
// party that hired can read the deliverable, with no API key and no DB state.

import { filesEnabled, filesOfTask, outputFileFor } from "./agentFiles";
import { sitesEnabled, siteViewOf } from "./agentSites";
import { liveLogEnabled, stepsOf } from "./liveLog";
import { agentBrowses, browserEnabled } from "./agentBrowser";
import { pagesOf } from "./taskPages";
import { sentOf } from "./taskSent";
import { getMcpServerByAgentId } from "./mcp";
import { claimTokenFor, claimTokenValid } from "./claimToken";
import { NextRequest } from "next/server";
import { getAgentById, searchAgents, toPublicAgent } from "./agents";
import { getTaskById } from "./tasks";
import { getPublicReceipt } from "./receipts";
import { getReproProof } from "./reproducibility";
import { getPublicTrace } from "./traceEvents";
import { computeProofScore } from "./proofScore";
import { semanticSearchAgents } from "./embeddings";
import { parsePriceToEth } from "./payments";
import { parsePaymentAmount } from "./money";
import { authenticateApiKey } from "./identity";
import type { Agent } from "@/sdk/types";
import { studioInfo } from "./studioPublish";
import { ASK_MYLO_TOOL, askMylo } from "./myloMcp";
import { callWorkTool, followedAgent, hireWorkBody, hireWorkNote, hireWorkProperties, resultWork, workTools } from "./mcpWork";
import { callShopTool, shopMcpTools } from "./mcpShop";
import { businessMcpTools, callBusinessTool } from "./mcpBusiness";
import { callPeopleTool, peopleMcpTools } from "./mcpPeople";

const PROTOCOL_VERSION = "2025-03-26";
const SERVER_INFO = { name: "axon", version: "1.0.0" };
const BASE_URL = "https://axon-agents.com";

// ── JSON-RPC types ────────────────────────────────────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

const rpcResult = (id: JsonRpcResponse["id"], result: unknown): JsonRpcResponse => ({ jsonrpc: "2.0", id, result });
const rpcError = (id: JsonRpcResponse["id"], code: number, message: string): JsonRpcResponse => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
});

// ── Claim tokens ──────────────────────────────────────────────────────────────
// They live in ./claimToken; exported from here as they always were.
export { claimTokenFor, claimTokenValid };

// ── Tool definitions (MCP inputSchema = JSON Schema) ──────────────────────────

export const MCP_TOOLS = [
  {
    name: "search_agents",
    description:
      "Search the Axon agent marketplace. Returns agents with their id, capabilities, price (ETH per task; absent = free lane), reputation (0-10) and portable Proof Score (0-1000, third-party verifiable).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Free-text description of the work you need" },
        capability: { type: "string", description: "Exact capability filter, e.g. 'research' or 'coding'" },
        limit: { type: "number", description: "Max results (default 5, max 20)" },
      },
    },
  },
  {
    name: "get_agent",
    description:
      "Full profile for one agent: capabilities, price, reputation, verification status, and its Proof Score with the evidence link so you can verify the track record independently.",
    inputSchema: {
      type: "object",
      properties: { agentId: { type: "string", description: "The agent id from search_agents" } },
      required: ["agentId"],
    },
  },
  {
    name: "hire_agent",
    description:
      "Hire an Axon agent for a task. Free-lane agents run immediately. Paid agents: if this connection carries an Axon allowance key, the hire is paid automatically from the owner's on-chain allowance, within their limits; if a limit would be exceeded the reason comes back in words. Without a key, paid agents return payment requirements (an ETH amount and an address): pay with your own wallet, then call again with paymentSignature. Returns a taskId plus a claimToken; keep the claimToken, it is the only way to read the result. An agent can also build a working web page or small app when the task asks for one (a landing page, a calculator, a sign-up form, a dashboard): the result then carries a page with a link the person opens.",
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string", description: "The agent to hire (from search_agents)" },
        task: { type: "string", description: "The work to do" },
        context: { type: "object", description: "Optional structured hints for the agent" },
        paymentSignature: {
          type: "string",
          description: "Transaction hash of your ETH payment (required for paid agents, second call)",
        },
        payerWallet: {
          type: "string",
          description: "The address that sent the payment (send with paymentSignature for paid agents)",
        },
        payIn: {
          type: "string",
          enum: ["ETH", "AXON"],
          description: "With an allowance key: pay in ETH (default) or in $AXON, for agents that accept it",
        },
        idempotencyKey: {
          type: "string",
          description: "A unique string for this hire, 8-128 characters of letters, numbers, '.', '_', ':' or '-'. Retrying with the same key returns the same task instead of paying twice",
        },
      },
      required: ["agentId", "task"],
    },
  },
  {
    name: "get_task_result",
    description:
      "Fetch a hired task's status and, once completed, its output. Requires the claimToken returned by hire_agent, task outputs are private to the hirer.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        claimToken: { type: "string", description: "The claim token from hire_agent" },
      },
      required: ["taskId", "claimToken"],
    },
  },
  {
    name: "get_allowance",
    description:
      "What the allowance behind this connection's key can still spend: available balance, per-task and daily limits and what is left today, for ETH and $AXON, plus this key's own limits. Needs an Axon allowance key in the connection's Authorization header.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "schedule_agent",
    description:
      "Put a paid agent on a schedule (a retainer): Axon hires it every time the schedule comes round and pays from the owner's on-chain allowance, inside its limits; failed runs cost nothing. Use for anything recurring: a morning brief, a wallet check every few hours, a weekly report. Needs an Axon key on this connection. Daily and weekly times are in the given time zone (ask the user theirs). Hourly needs a holder tier; every 4 hours works for everyone.",
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string", description: "A paid agent from search_agents" },
        instructions: { type: "string", description: "What the agent does on every run" },
        schedule: {
          type: "object",
          description: 'One of {"kind":"interval","everyHours":1|2|3|4|6|8|12}, {"kind":"daily","time":"08:00","timeZone":"Europe/Oslo"}, {"kind":"weekly","day":0-6 (0 = Sunday),"time":"09:00","timeZone":"UTC"}',
          properties: {
            kind: { type: "string", enum: ["interval", "daily", "weekly"] },
            everyHours: { type: "number" },
            time: { type: "string", description: "HH:MM, 24-hour" },
            timeZone: { type: "string", description: "IANA name, e.g. America/New_York" },
            day: { type: "number", description: "0 Sunday to 6 Saturday" },
          },
          required: ["kind"],
        },
        payIn: { type: "string", enum: ["ETH", "AXON"], description: "Default ETH; AXON for agents that accept it" },
        maxPrice: { type: "string", description: "Most one run may cost, in ETH, e.g. \"0.0002\". Default: a quarter above the agent's current price" },
        maxRuns: { type: "number", description: "Optional: stop after this many runs" },
        endsAt: { type: "string", description: "Optional: stop after this date (ISO 8601)" },
      },
      required: ["agentId", "instructions", "schedule"],
    },
  },
  {
    name: "list_retainers",
    description:
      "The retainers this connection's key can see: what each does, its schedule in words, when it runs next, its status and why it is paused if it is, and the latest completed result. Also the wallet's limits: how many retainers its $AXON tier allows, how many are in use, and the fastest schedule. Needs an Axon key on this connection.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_retainer_runs",
    description:
      "A retainer's recent runs, newest first: each completed run's output and receipt, or why a run did not happen (price above the maximum, allowance refused, previous run still working, agent unavailable, missed). Use to answer \"what did my morning brief say?\".",
    inputSchema: {
      type: "object",
      properties: {
        retainerId: { type: "string" },
        limit: { type: "number", description: "Default 5, max 20" },
      },
      required: ["retainerId"],
    },
  },
  {
    name: "manage_retainer",
    description: "Pause, resume or cancel a retainer. Cancel is final; its history stays readable. Resume carries on from the next slot.",
    inputSchema: {
      type: "object",
      properties: {
        retainerId: { type: "string" },
        action: { type: "string", enum: ["pause", "resume", "cancel"] },
      },
      required: ["retainerId", "action"],
    },
  },
  {
    name: "get_receipt",
    description:
      "The public, verifiable proof for a task: parties, spec/output hashes, on-chain settlement, hash-chained execution trace, and the reproducibility verdict when the task has been re-run. Safe to share, never exposes task content.",
    inputSchema: {
      type: "object",
      properties: { taskId: { type: "string" } },
      required: ["taskId"],
    },
  },
  ASK_MYLO_TOOL,
] as const;

// ── Files (only while AGENT_FILES is on) ──────────────────────────────────────────────────────────────────────────────
// With the switch off the tool list is exactly MCP_TOOLS: no upload tool, no files on a hire.

const UPLOAD_FILE_TOOL = {
    name: "upload_file",
    description:
      "Hand over a file for an agent to work on, before hiring it. Give the file's name and either its text (for a text, Markdown, CSV or JSON file) or its bytes as base64 (for a PDF or a picture: PNG, JPEG, GIF, WebP). Returns the file's id and token: pass both in hire_agent's files. A file is attached to one hire and is not public. Only available where files are switched on.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The file's name, for example report.pdf or sales.csv" },
        text: { type: "string", description: "The file's contents, when it is a text file" },
        base64: { type: "string", description: "The file's bytes as base64, when it is a PDF or a picture" },
      },
      required: ["name"],
    },
  } as const;

const HIRE_FILES_PROPERTY = {
  type: "array",
  description: "Files for the agent to work on, uploaded first with upload_file: each entry is the id and token upload_file returned. Up to 2 on a free hire, 5 on a paid one",
  items: { type: "object", properties: { id: { type: "string" }, token: { type: "string" } }, required: ["id"] },
} as const;

const HIRE_REPORT_PROPERTY = {
  type: "boolean",
  description: "Set true to get the answer as a Markdown file as well. get_task_result then lists it under files, with a link that downloads it",
} as const;

const RESULT_WITH_STEPS = " While the job is still running, steps lists what the agent has done so far, one line a step.";

/** What get_task_result says about itself while files are on: it also lists what the agent handed back. */
const RESULT_WITH_FILES = " When the agent handed back files (a chart, a table, the answer as a file), they are listed under files, each with its SHA-256 and a url that downloads it.";

/** And while agents have a browser: where it went, and what it sent. */
const RESULT_WITH_BROWSER = " When the agent used its browser, the pages it opened are listed under pages (each with its address and title), a form it sent is listed under sent with what was typed into it, and a file it saved or downloaded from a page says where it came from under from.";
/** What the hire tool says while agents have a browser. */
const HIRE_WITH_BROWSER = " An agent Axon runs can open websites in a real browser when the task names one or asks it to go somewhere: it reads the page as it is drawn, clicks, scrolls, fills in forms, compares pages, and saves a page or downloads a file from it. It signs in nowhere, pays nowhere, and sends a form only when the task asks for that. get_agent says whether an agent browses.";

/**
 * The tools on offer right now: the standing list, plus files while they are switched on, plus what working with
 * an agent adds (follow-ups, questions, plans, notes, the library) and the shop, each by its own switch.
 */
export function mcpTools(): readonly McpTool[] {
  // the shop's tools join the ones that working with an agent adds, each by its own switch
  const more = hireWorkProperties(), note = hireWorkNote(), added = [...workTools(), ...shopMcpTools(), ...businessMcpTools(), ...peopleMcpTools()];
  const base = toolsWithFiles();
  if (!Object.keys(more).length && !note && !added.length) return base;
  return [
    ...base.map((t) => (t.name === "hire_agent"
      // with a job to follow, the agent can be left out: it stays with the one that did the job
      ? { ...t, description: t.description + note, inputSchema: { ...t.inputSchema, properties: { ...t.inputSchema.properties, ...more }, ...("followUpOf" in more ? { required: ["task"] } : {}) } }
      : t)),
    ...added,
  ];
}

function toolsWithFiles(): readonly McpTool[] {
  const standing = MCP_TOOLS as unknown as McpTool[];
  // while the live log is on, reading a result also says what the agent has done so far
  const logged = liveLogEnabled() ? standing.map((t) => (t.name === "get_task_result" ? { ...t, description: t.description + RESULT_WITH_STEPS } : t)) : standing;
  // while agents have a browser, hiring says so and reading a result says where the browser went
  const base = browserEnabled()
    ? logged.map((t) => (t.name === "hire_agent" ? { ...t, description: t.description + HIRE_WITH_BROWSER } : t.name === "get_task_result" ? { ...t, description: t.description + RESULT_WITH_BROWSER } : t))
    : logged;
  if (!filesEnabled()) return base;
  const out: McpTool[] = [];
  for (const t of base) {
    if (t.name === "hire_agent") {
      out.push({ ...t, inputSchema: { ...t.inputSchema, properties: { ...t.inputSchema.properties, files: HIRE_FILES_PROPERTY, reportFile: HIRE_REPORT_PROPERTY } } });
      out.push(UPLOAD_FILE_TOOL as unknown as McpTool);
    } else if (t.name === "get_task_result") out.push({ ...t, description: t.description + RESULT_WITH_FILES });
    else out.push(t);
  }
  return out;
}


/** A tool as MCP lists it. */
export interface McpTool { name: string; description: string; inputSchema: { type: string; properties: Record<string, unknown>; required?: readonly string[] } }

/** The tools that come with a single agent, beside the agent itself: reading its answer and its proof. */
const WITH_AN_AGENT = ["get_task_result", "get_receipt", "get_allowance", "answer_agent", "decide_plan", "steer_task", "get_library"];

/**
 * One agent as its own toolset, for a link that adds just that agent to an assistant (/mcp/agents/:id, and
 * /api/tools?agent=:id for function calling). The agent is one tool, named after it, taking a task; calling it hires
 * that agent through hire_agent, payments, allowance keys and claim tokens exactly as the whole marketplace does. With
 * it come the tools to read the answer. Null for an agent that is not there to hire.
 */
export function agentToolset(agentId: string): { toolName: string; agent: Agent; tools: McpTool[] } | null {
  const agent = getAgentById(agentId);
  if (!agent || agent.agentId.startsWith("build-")) return null;
  // what every function-calling API accepts as a name: letters, digits, _ and -, at most 64
  const toolName = agent.agentId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  const hire = mcpTools().find((t) => t.name === "hire_agent")!;
  const { agentId: _id, ...props } = hire.inputSchema.properties as Record<string, unknown>;
  const studio = studioInfo(agent.agentId);
  const what = (agent.description ?? agent.capabilities.join(", ")).replace(/\.$/, "");
  const tool: McpTool = {
    name: toolName,
    description: `${agent.name}: ${what}. ${agent.price ? `${agent.price} per task` : "Free"}.${studio ? ` Built in Axon Agent Studio, tested ${studio.score.toFixed(1)}/10.` : ""} Give it a task; it returns a taskId and a claimToken, and get_task_result with both returns the answer.`,
    inputSchema: { type: "object", properties: props, required: ["task"] },
  };
  // read from the tools on offer right now, so what working with an agent adds comes along while it is switched on
  return { toolName, agent, tools: [tool, ...mcpTools().filter((t) => WITH_AN_AGENT.includes(t.name))] };
}

// ── Tool implementations ──────────────────────────────────────────────────────

function agentSummary(a: Agent) {
  const pub = toPublicAgent(a) as Agent;
  return {
    agentId: pub.agentId,
    name: pub.name,
    capabilities: pub.capabilities,
    price: pub.price ?? null,
    reputation: pub.reputation,
    proofScore: pub.proofScore ?? null,
    verificationStatus: pub.verificationStatus ?? null,
    // Whether this agent can go and look things up. A caller choosing between
    // agents needs this: it's the difference between an answer from training
    // data and one grounded in live sources.
    tools: pub.tools?.length ? pub.tools : null,
  };
}

async function toolSearchAgents(args: Record<string, unknown>) {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  const capability = typeof args.capability === "string" ? args.capability.trim() : undefined;
  const limit = Math.min(Math.max(Number(args.limit) || 5, 1), 20);

  let agents: Agent[] | null = null;
  if (query) {
    agents = await semanticSearchAgents(query, { q: query, capability, limit });
  }
  if (!agents) {
    // Keyword fallback: capability filter first, then match query terms.
    const pool = searchAgents({ capability, sort: "reputation", limit: 200 });
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    agents =
      terms.length === 0
        ? pool
        : pool.filter((a) => {
            const hay = `${a.name} ${a.capabilities.join(" ")} ${a.category ?? ""}`.toLowerCase();
            return terms.some((t) => hay.includes(t));
          });
  }
  return { agents: agents.slice(0, limit).map(agentSummary) };
}

function toolGetAgent(args: Record<string, unknown>) {
  const agentId = String(args.agentId ?? "");
  const agent = getAgentById(agentId);
  if (!agent) return { error: `agent '${agentId}' not found` };
  const proof = computeProofScore(agentId);
  return {
    agent: agentSummary(agent),
    // whether a task that names a website is given a browser to open it with
    ...(agentBrowses(agent, { viaMcp: Boolean(getMcpServerByAgentId(agentId)) }) ? { browses: true } : {}),
    proofScore: proof
      ? { score: proof.score, tier: proof.tier, verify: `${BASE_URL}/api/agents/${agentId}/proof-score?verify=1` }
      : null,
    profileUrl: `${BASE_URL}/agents/${agentId}`,
  };
}

// Delegates to the real /api/tasks route handler so the MCP path inherits its
// free-lane limits, x402 payment verification, and replay guards verbatim. The
// caller's IP is forwarded so per-IP limits apply to the actual client.
/** What one upload_file call may carry: tool arguments travel as JSON, so a large file does not belong here. */
const MCP_UPLOAD_MAX_BYTES = 2 * 1024 * 1024;

// Hands the upload to the real /api/files route, so its type check, its limits and a visitor's daily allowance are
// the same from an assistant as from the site.
async function toolUploadFile(args: Record<string, unknown>, clientIp: string, apiKey: string | null) {
  const name = typeof args.name === "string" ? args.name.trim() : "";
  if (!name) return { error: "name is required" };
  let bytes: Buffer;
  if (typeof args.text === "string" && args.text.length) bytes = Buffer.from(args.text, "utf8");
  else if (typeof args.base64 === "string" && args.base64.length) {
    if (!/^[A-Za-z0-9+/=\s_-]+$/.test(args.base64)) return { error: "base64 is not valid base64" };
    bytes = Buffer.from(args.base64.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  } else return { error: "send the file as text or as base64" };
  if (bytes.length > MCP_UPLOAD_MAX_BYTES) return { error: `a file sent through this tool is at most ${MCP_UPLOAD_MAX_BYTES / 1048576} MB; upload larger files with POST /api/files` };

  const { POST: uploadRoute } = await import("@/app/api/files/route");
  const res = await uploadRoute(new NextRequest(`${BASE_URL}/api/files`, {
    method: "POST",
    headers: { "content-length": String(bytes.length), "x-file-name": encodeURIComponent(name), "x-forwarded-for": clientIp, ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
    body: new Uint8Array(bytes),
  }));
  const json = (await res.json()) as { file?: { id: string; name: string; mime: string; size: number; sha256: string; expiresAt: string }; fileToken?: string; error?: string; code?: string };
  if (!res.ok || !json.file) return { error: String(json.error ?? `upload failed (${res.status})`), code: json.code ?? null };
  return { id: json.file.id, token: json.fileToken, name: json.file.name, type: json.file.mime, size: json.file.size, sha256: json.file.sha256, expiresAt: json.file.expiresAt, next: "Pass { id, token } in hire_agent's files." };
}

async function toolHireAgent(args: Record<string, unknown>, clientIp: string, apiKey: string | null) {
  // a follow-up that names no agent stays with the one that did the job
  const agentId = String(args.agentId ?? "") || followedAgent(args);
  const task = typeof args.task === "string" ? args.task.trim() : "";
  if (!agentId || !task) return { error: "agentId and task are required" };

  const agent = getAgentById(agentId);
  if (!agent) return { error: `agent '${agentId}' not found` };

  const paymentSignature = typeof args.paymentSignature === "string" ? args.paymentSignature.trim() : "";
  const payerWallet = typeof args.payerWallet === "string" ? args.payerWallet.trim() : "";
  // Paid means exactly what the tasks route will enforce (parsePriceToEth) — a
  // price of "0 ETH" or unparseable text is free there, so it is free here too.
  const paid = parsePriceToEth(agent.price ?? undefined) !== null;
  if (paid && !paymentSignature && apiKey) {
    return hireFromAllowance(args, agent, task, clientIp, apiKey);
  }
  if (paid && !paymentSignature) {
    const parsed = parsePaymentAmount(agent.price!);
    const payTo = process.env.NEXT_PUBLIC_PAYMENT_RECEIVER_WALLET_ADDRESS ?? null;
    return {
      status: "payment_required",
      price: agent.price,
      amount: parsed?.amount ?? null,
      currency: parsed?.currency ?? null,
      payTo,
      network: "eip155:4663",
      instructions: `Pay ${agent.price} to ${payTo ?? "the Axon treasury"} on Robinhood Chain with your own wallet, then call hire_agent again with the transaction hash as paymentSignature and your wallet address as payerWallet. The payment is the authorization, no account needed.`,
      orUseAnAllowance: "Or add an Axon allowance key to this MCP connection's Authorization header, and hire_agent pays from your on-chain allowance automatically, within your limits.",
    };
  }

  const { POST: createTaskRoute } = await import("@/app/api/tasks/route");
  const body: Record<string, unknown> = { from: "anonymous", to: agentId, task, ...hireWorkBody(args) };
  if (args.context && typeof args.context === "object") body.context = args.context;
  if (Array.isArray(args.files) && args.files.length) body.files = args.files;
  if (args.reportFile === true) body.reportFile = true;
  if (paymentSignature) body.paymentSignature = paymentSignature;
  if (payerWallet) body.payerWallet = payerWallet;

  const req = new NextRequest(`${BASE_URL}/api/tasks`, {
    method: "POST",
    // a key on the connection says whose memory and library a free hire belongs to; it pays nothing here
    headers: { "Content-Type": "application/json", "x-forwarded-for": clientIp, ...(apiKey ? { "x-api-key": apiKey } : {}) },
    body: JSON.stringify(body),
  });
  const res = await createTaskRoute(req);
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    return { error: String(json.error ?? `hire failed (${res.status})`), code: json.code ?? null };
  }

  const taskId = String(json.taskId);

  // A claim token is minted ONLY for a task this call newly created (201). A
  // payment-signature replay returns someone's EXISTING task (200 +
  // X-Payment-Replay) — Solana signatures are public on-chain, so minting a
  // token here would let anyone who watches the treasury read another hirer's
  // output. Refuse instead; the original hire already received its token.
  const isReplay = res.status !== 201 || res.headers.get("X-Payment-Replay") === "true";
  if (isReplay) {
    return {
      taskId,
      status: json.status,
      alreadyHired: true,
      receiptUrl: `${BASE_URL}/r/${taskId}`,
      note: "This payment signature was already used for an existing task. No claim token is issued on a replay, if this was your original hire, use the claimToken returned by that call. The public receipt remains viewable.",
    };
  }

  return {
    taskId,
    status: json.status,
    claimToken: claimTokenFor(taskId),
    receiptUrl: `${BASE_URL}/r/${taskId}`,
    note: "Keep the claimToken, it is the only way to read this task's output via get_task_result.",
  };
}

/** The wallet a key on this connection belongs to, or null if it is not a key we know. */
function walletForKey(apiKey: string): string | null {
  const probe = new NextRequest(`${BASE_URL}/mcp`, { headers: { "x-api-key": apiKey } });
  return authenticateApiKey(probe, { allowAllowanceScope: true })?.walletAddress ?? null;
}

/** An error the tasks route returned, as the words it said. */
function routeError(json: Record<string, unknown>, status: number) {
  return { error: typeof json.error === "string" ? json.error : `hire failed (${status})`, code: json.code ?? null };
}

// A paid hire, paid from the allowance of the wallet this connection's key belongs to. The tasks route
// does every check: the owner's rules on chain, the key's own limits, and refusal in words.
async function hireFromAllowance(
  args: Record<string, unknown>,
  agent: Agent,
  task: string,
  clientIp: string,
  apiKey: string,
) {
  const wallet = walletForKey(apiKey);
  if (!wallet) return { error: "The Authorization key on this MCP connection is not a valid Axon key" };

  const body: Record<string, unknown> = { from: wallet, to: agent.agentId, task, paymentMethod: "allowance", ...hireWorkBody(args) };
  if (args.context && typeof args.context === "object") body.context = args.context;
  if (Array.isArray(args.files) && args.files.length) body.files = args.files;
  if (args.reportFile === true) body.reportFile = true;

  // The route makes a quote for this hire alone; see freshAxonQuoteFor.
  if (args.payIn === "AXON") body.payIn = "AXON";

  const { POST: createTaskRoute } = await import("@/app/api/tasks/route");
  const idempotencyKey = typeof args.idempotencyKey === "string" ? args.idempotencyKey.trim() : "";
  const res = await createTaskRoute(new NextRequest(`${BASE_URL}/api/tasks`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-forwarded-for": clientIp,
      "x-api-key": apiKey,
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: JSON.stringify(body),
  }));
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok) return routeError(json, res.status);

  const taskId = String(json.taskId);
  return {
    taskId,
    status: json.status,
    paidFrom: "allowance",
    ...(res.headers.get("X-Idempotent-Replay") === "true" ? { alreadyHired: true } : {}),
    claimToken: claimTokenFor(taskId),
    receiptUrl: `${BASE_URL}/r/${taskId}`,
    note: "Paid from your allowance. Keep the claimToken, it is the only way to read this task's output via get_task_result.",
  };
}

async function toolGetAllowance(apiKey: string | null) {
  if (!apiKey) {
    return { error: "get_allowance needs an Axon allowance key in this MCP connection's Authorization header" };
  }
  const { GET: allowanceRoute } = await import("@/app/api/allowance/route");
  const res = await allowanceRoute(new NextRequest(`${BASE_URL}/api/allowance`, { headers: { "x-api-key": apiKey } }));
  const json = (await res.json()) as Record<string, unknown>;
  return res.ok ? json : routeError(json, res.status);
}

// ── Retainers ─────────────────────────────────────────────────────────────────
//
// Every retainer tool goes through the /api/retainers routes with the connection's own key, so an
// allowance key sees and controls only the retainers it created and stays inside its limits, exactly
// as over plain HTTP.

const NEEDS_KEY = { error: "Retainers need an Axon key in this MCP connection's Authorization header (an allowance key works)" };

async function retainerCall(
  apiKey: string,
  load: () => Promise<Record<string, (req: NextRequest, ctx: { params: Promise<{ retainerId: string }> }) => Promise<Response>>>,
  method: string,
  path: string,
  retainerId: string | null,
  body?: unknown,
) {
  const mod = await load();
  const handler = mod[method];
  const req = new NextRequest(`${BASE_URL}${path}`, {
    method,
    headers: { "x-api-key": apiKey, "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const res = await handler(req, { params: Promise.resolve({ retainerId: retainerId ?? "" }) });
  const json = (await res.json()) as Record<string, unknown>;
  return res.ok ? json : { error: typeof json.error === "string" ? json.error : `request failed (${res.status})` };
}

async function toolScheduleAgent(args: Record<string, unknown>, apiKey: string | null) {
  if (!apiKey) return NEEDS_KEY;
  const body: Record<string, unknown> = {
    agentId: args.agentId,
    instructions: args.instructions,
    schedule: args.schedule,
  };
  for (const k of ["payIn", "maxPrice", "maxRuns", "endsAt"]) if (args[k] !== undefined) body[k] = args[k];
  const out = await retainerCall(apiKey, () => import("@/app/api/retainers/route") as never, "POST", "/api/retainers", null, body);
  if ("error" in out) return out;
  const r = out.retainer as Record<string, unknown>;
  return {
    retainer: r,
    note:
      `Scheduled: ${r.scheduleText}. First run ${r.nextRunAt}. Each run pays up to ${r.maxPrice} ETH from the allowance; use get_retainer_runs for results.` +
      // Set up through this key, it pays through this key: tell the user when that stops.
      (r.keyExpiresAt ? ` It runs through this connection's key, which expires ${r.keyExpiresAt}; tell the user, since the retainer pauses then until they resume it.` : ""),
  };
}

async function toolListRetainers(apiKey: string | null) {
  if (!apiKey) return NEEDS_KEY;
  const out = await retainerCall(apiKey, () => import("@/app/api/retainers/route") as never, "GET", "/api/retainers", null);
  if ("error" in out) return out;
  // The latest result for each, so "how is my morning brief doing" is one call.
  const withLatest = await Promise.all(
    (out.retainers as { retainerId: string }[]).map(async (r) => {
      const one = await retainerCall(apiKey, () => import("@/app/api/retainers/[retainerId]/route") as never, "GET", `/api/retainers/${r.retainerId}`, r.retainerId);
      return "error" in one ? r : one.retainer;
    }),
  );
  // The limits too, so an assistant can say "you have room for one more" before trying to add it.
  return { retainers: withLatest, limits: out.limits };
}

async function toolGetRetainerRuns(args: Record<string, unknown>, apiKey: string | null) {
  if (!apiKey) return NEEDS_KEY;
  const id = String(args.retainerId ?? "");
  if (!id) return { error: "retainerId is required" };
  const limit = Math.min(20, Math.max(1, Number(args.limit) || 5));
  return retainerCall(apiKey, () => import("@/app/api/retainers/[retainerId]/runs/route") as never, "GET", `/api/retainers/${id}/runs?limit=${limit}`, id);
}

async function toolManageRetainer(args: Record<string, unknown>, apiKey: string | null) {
  if (!apiKey) return NEEDS_KEY;
  const id = String(args.retainerId ?? "");
  if (!id) return { error: "retainerId is required" };
  switch (args.action) {
    case "pause":
      return retainerCall(apiKey, () => import("@/app/api/retainers/[retainerId]/pause/route") as never, "POST", `/api/retainers/${id}/pause`, id);
    case "resume":
      return retainerCall(apiKey, () => import("@/app/api/retainers/[retainerId]/resume/route") as never, "POST", `/api/retainers/${id}/resume`, id);
    case "cancel":
      return retainerCall(apiKey, () => import("@/app/api/retainers/[retainerId]/route") as never, "DELETE", `/api/retainers/${id}`, id);
    default:
      return { error: "action must be pause, resume or cancel" };
  }
}

function toolGetTaskResult(args: Record<string, unknown>) {
  const taskId = String(args.taskId ?? "");
  const token = String(args.claimToken ?? "");
  if (!taskId || !token) return { error: "taskId and claimToken are required" };
  if (!claimTokenValid(taskId, token)) return { error: "invalid claim token for this task" };

  const task = getTaskById(taskId);
  if (!task) return { error: `task '${taskId}' not found` };
  // What the agent handed back, each with a link that downloads it. The link carries the file's own token, which only
  // whoever holds this job's claim token is ever given.
  const files = filesEnabled() && task.status === "completed"
    ? filesOfTask(taskId, "out").map((f) => {
        const o = outputFileFor(f);
        return { name: o.name, type: o.type, size: o.size, sha256: o.sha256, url: `${BASE_URL}${o.path}?token=${o.token}`, ...(o.madeBy ? { madeBy: o.madeBy.name } : {}), ...(o.version ? { version: o.version } : {}), ...(o.from ? { from: { url: o.from.url, title: o.from.title, how: o.from.kind } } : {}) };
      })
    : [];
  // What the agent has done so far, one line a step: something to show while the job is still running.
  const steps = liveLogEnabled() ? stepsOf(taskId).map((x) => x.text) : [];
  // Where the job's browser went and what it sent, for a job that used one.
  const pages = pagesOf(taskId).map((p) => ({ url: p.url, title: p.title }));
  const sent = sentOf(taskId).map((f) => ({ url: f.url, button: f.button, fields: f.fields }));
  // The page the job built or changed, for a job that did: a link the person opens.
  const built = sitesEnabled() ? siteViewOf(taskId, BASE_URL) : null;
  // A failed TASK is a valid tool result, not a tool failure — report it as
  // `failureReason`, never `error` (the dispatcher flags isError by the presence
  // of an `error` key, so a completed result must not carry one).
  return {
    taskId,
    status: task.status,
    output: task.status === "completed" ? (task.output ?? null) : null,
    failureReason: task.status === "failed" ? (task.error ?? null) : null,
    ...(steps.length ? { steps } : {}),
    ...(files.length ? { files } : {}),
    ...(pages.length ? { pages } : {}),
    ...(sent.length ? { sent } : {}),
    ...(built ? { page: { title: built.title, url: built.url, version: built.version, note: "The agent built this page. Give the person the link: it opens in a browser. A follow-up to this job changes the same page at the same link." } } : {}),
    ...resultWork(task),
    receiptUrl: `${BASE_URL}/r/${taskId}`,
  };
}

function toolGetReceipt(args: Record<string, unknown>) {
  const taskId = String(args.taskId ?? "");
  const receipt = getPublicReceipt(taskId);
  if (!receipt) return { error: `no receipt for task '${taskId}'` };
  const trace = getPublicTrace(taskId);
  const repro = getReproProof(taskId);
  return {
    receipt,
    trace: trace ? { verified: trace.verified, events: trace.events.length, url: `${BASE_URL}/api/receipts/${taskId}/trace` } : null,
    reproducibility: repro
      ? { verdict: repro.verdict, similarity: repro.similarity, contentHash: repro.contentHash }
      : null,
    receiptUrl: `${BASE_URL}/r/${taskId}`,
  };
}

// ── Dispatcher ────────────────────────────────────────────────────────────────

async function callTool(name: string, args: Record<string, unknown>, clientIp: string, apiKey: string | null): Promise<unknown> {
  switch (name) {
    case "search_agents":
      return toolSearchAgents(args);
    case "get_agent":
      return toolGetAgent(args);
    case "hire_agent":
      return toolHireAgent(args, clientIp, apiKey);
    case "upload_file":
      return toolUploadFile(args, clientIp, apiKey);
    case "get_allowance":
      return toolGetAllowance(apiKey);
    case "ask_mylo":
      return askMylo(args, clientIp, apiKey);
    case "schedule_agent":
      return toolScheduleAgent(args, apiKey);
    case "list_retainers":
      return toolListRetainers(apiKey);
    case "get_retainer_runs":
      return toolGetRetainerRuns(args, apiKey);
    case "manage_retainer":
      return toolManageRetainer(args, apiKey);
    case "get_task_result":
      return toolGetTaskResult(args);
    case "get_receipt":
      return toolGetReceipt(args);
    default:
      return (await callWorkTool(name, args, apiKey, BASE_URL)) ?? (await callShopTool(name, args, apiKey, BASE_URL)) ?? (await callBusinessTool(name, args, apiKey, BASE_URL)) ?? (await callPeopleTool(name, args, apiKey, BASE_URL)) ?? null;
  }
}

// Handle one JSON-RPC message. Returns null for notifications (no id) — the
// route replies 202 with no body, per Streamable HTTP.
/**
 * @param apiKey the key on the connection's Authorization header, if any. Optional: discovery, free
 *   hires and receipts need none. With one, paid hires pay from the owner's allowance.
 */
export async function handleMcpMessage(
  msg: JsonRpcRequest,
  clientIp: string,
  apiKey: string | null = null,
  // set when the connection is one agent's own link: its tools are that agent and the tools to read its answer
  scope: string | null = null,
): Promise<JsonRpcResponse | null> {
  const id = msg.id ?? null;
  const isNotification = msg.id === undefined;
  const scoped = scope ? agentToolset(scope) : null;
  if (scope && !scoped) return rpcError(id, -32602, `no agent '${scope}' to hire`);

  switch (msg.method) {
    case "initialize": {
      // Echo the client's requested protocol version when it sends one (our tool
      // surface is version-agnostic JSON-RPC), else advertise our own — per the
      // MCP handshake, so a newer-spec client doesn't reject an older reply.
      const requested = msg.params?.protocolVersion;
      const protocolVersion = typeof requested === "string" && requested ? requested : PROTOCOL_VERSION;
      return rpcResult(id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: scoped ? { name: `axon-${scoped.toolName}`, version: SERVER_INFO.version } : SERVER_INFO,
        instructions: scoped
          ? `This connection is one Axon agent, ${scoped.agent.name}. Call ${scoped.toolName} with a task to hire it, then get_task_result with the taskId and claimToken for the answer. Paid: with an Axon allowance key on this connection it pays from the owner's allowance; without one it returns ETH payment requirements to pay with your own wallet and retry with paymentSignature.`
          :
          "Axon is an open agent marketplace: search_agents to discover, hire_agent to create a task, get_task_result with your claimToken for the output, get_receipt for the public verifiable proof. Paid agents: with an Axon allowance key on this connection, hire_agent pays from the owner's on-chain allowance automatically (get_allowance shows what is left); without one, it returns ETH payment requirements to pay with your own wallet and retry with paymentSignature. For anything recurring, schedule_agent puts an agent on a schedule paid from the same allowance; list_retainers and get_retainer_runs read what it did. To talk to Mylo, Axon's own AI, use ask_mylo (it needs the connection's key; anything it proposes is confirmed on the site).",
      });
    }
    case "notifications/initialized":
    case "initialized":
      return null;
    case "ping":
      return isNotification ? null : rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: scoped ? scoped.tools : mcpTools() });
    case "tools/call": {
      const params = msg.params ?? {};
      const name = String(params.name ?? "");
      const args = (params.arguments && typeof params.arguments === "object" ? params.arguments : {}) as Record<string, unknown>;
      let result: unknown;
      // on one agent's link, its own tool is hire_agent for that agent, and only its own tools are there
      if (scoped && name !== scoped.toolName && !scoped.tools.some((t) => t.name === name)) return rpcError(id, -32602, `unknown tool '${name}'`);
      const [tool, input] = scoped && name === scoped.toolName ? ["hire_agent", { ...args, agentId: scoped.agent.agentId }] : [name, args];
      try {
        result = await callTool(tool, input, clientIp, apiKey);
      } catch (e) {
        return rpcResult(id, {
          content: [{ type: "text", text: e instanceof Error ? e.message : "tool execution failed" }],
          isError: true,
        });
      }
      if (result === null) return rpcError(id, -32602, `unknown tool '${name}'`);
      const isError = typeof result === "object" && result !== null && "error" in result;
      return rpcResult(id, {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        isError: Boolean(isError),
      });
    }
    default:
      return isNotification ? null : rpcError(id, -32601, `method '${msg.method}' not found`);
  }
}
