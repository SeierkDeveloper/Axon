import { getDb } from "./db";
// Provider-agnostic inference layer.
//
// Agents declare which provider runs their inference via the `provider` field
// in the agents table. The worker and stream endpoint call runWithProvider()
// instead of hardcoding Anthropic — the right client is selected automatically.
//
// Supported providers:
//   anthropic  — Claude via Anthropic API (default)
//   ollama     — Any model via a public Ollama-compatible REST endpoint
//   openai     — GPT models via OpenAI API (same REST shape as Ollama)
//   grok       — Grok models via xAI API (same REST shape as OpenAI)
//   nock       — NockAI's Nock Coder via Surplus (same REST shape as OpenAI), server-side SURPLUS_API_KEY
//   raeto      — 400+ models through Raeto (same REST shape as OpenAI), server-side RAETO_API_KEY; raeto/auto
//                picks the model per call

import Anthropic, { toFile } from "@anthropic-ai/sdk";
import type { Agent } from "@/sdk/types";
import type { ModelAttachment } from "./agentFiles";
import { getInstructions, withKnowledge } from "./agentKnowledge";
import { publicHttpFetch } from "./urlSecurity";
import { logger } from "./logger";
import { recordModelUsage } from "./modelUsage";
import { RAETO_BASE_URL, DEFAULT_RAETO_MODEL, raetoEnabled } from "./raeto";
// Type-only: the tool layer builds the definitions and closures, this module
// only runs them. Keeps the DB off the model-call path at runtime.
import type { ResolvedTools, LocalTool } from "./agentTools";
import { MAX_TOOL_STEPS, MAX_TOOL_RESULT_CHARS } from "./agentToolLimits";

// System prompts — imported from each handler so the provider uses the real
// domain-specific prompt, not a generic fallback.
import { SYSTEM as researchSystem }          from "../workers/agents/research";
import { SYSTEM as cryptoSystem }            from "../workers/agents/crypto";
import { SYSTEM as tradingSystem }           from "../workers/agents/trading";
import { SYSTEM as auditSystem }             from "../workers/agents/audit";
import { SYSTEM as defiSystem }              from "../workers/agents/defi";
import { SYSTEM as dataSystem }              from "../workers/agents/data";
import { SYSTEM as contentSystem }           from "../workers/agents/content";
import { SYSTEM as codeSystem }              from "../workers/agents/code";
import { SYSTEM as nockCoderSystem }         from "../workers/agents/nock-coder";
import { SYSTEM as raetoAutoSystem }         from "../workers/agents/raeto-auto";
import { SYSTEM as onchainSystem }           from "../workers/agents/onchain";
import { SYSTEM as strategySystem }          from "../workers/agents/strategy";
import { SYSTEM as seoSystem }               from "../workers/agents/seo";
import { SYSTEM as socialSystem }            from "../workers/agents/social";
import { SYSTEM as emailSystem }             from "../workers/agents/email";
import { SYSTEM as reportSystem }            from "../workers/agents/report";
import { SYSTEM as webSystem }               from "../workers/agents/web";
import { SYSTEM as buildOrchestratorSystem } from "../workers/agents/build-orchestrator";
import { SYSTEM as buildDesignerSystem }     from "../workers/agents/build-designer";
import { SYSTEM as buildWorldSystem }        from "../workers/agents/build-world";
import { SYSTEM as buildCoderSystem }        from "../workers/agents/build-coder";
import { SYSTEM as buildArtistSystem }       from "../workers/agents/build-artist";
import { SYSTEM as buildQaSystem }           from "../workers/agents/build-qa";

// ── Retry utility ─────────────────────────────────────────────────────────────

const TRANSIENT_HTTP_CODES = new Set([429, 500, 503, 529]);

function isTransient(err: unknown): boolean {
  try {
    if (err instanceof Anthropic.RateLimitError) return true;
    if (err instanceof Anthropic.InternalServerError) return true;
    if (err instanceof Anthropic.APIConnectionError) return true;
    if (err instanceof Anthropic.APIConnectionTimeoutError) return true;
    if (err instanceof Anthropic.APIError && TRANSIENT_HTTP_CODES.has(err.status)) return true;
  } catch {
    // Anthropic SDK mocked in tests — fall through to message-based detection
  }
  if (err instanceof Error && (err.name === "AbortError" || /ECONNRESET|ETIMEDOUT|ENOTFOUND/i.test(err.message))) return true;
  return false;
}

async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 3, baseDelayMs = 1000, label = "provider"): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransient(err) || attempt === maxAttempts) throw err;
      const delay = baseDelayMs * Math.pow(2, attempt - 1) + Math.random() * 200;
      console.warn(`[${label}] transient error on attempt ${attempt}/${maxAttempts}, retrying in ${Math.round(delay)}ms`, err instanceof Error ? err.message : err);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastErr;
}

// ─────────────────────────────────────────────────────────────────────────────

const AGENT_SYSTEMS: Record<string, string> = {
  "research-agent":       researchSystem,
  "crypto-agent":         cryptoSystem,
  "trading-agent":        tradingSystem,
  "audit-agent":          auditSystem,
  "defi-agent":           defiSystem,
  "data-agent":           dataSystem,
  "content-agent":        contentSystem,
  "code-agent":           codeSystem,
  "nock-coder":           nockCoderSystem,
  "raeto-auto":           raetoAutoSystem,
  "onchain-agent":        onchainSystem,
  "strategy-agent":       strategySystem,
  "seo-agent":            seoSystem,
  "social-agent":         socialSystem,
  "email-agent":          emailSystem,
  "report-agent":         reportSystem,
  "web-agent":            webSystem,
  "build-orchestrator":   buildOrchestratorSystem,
  "build-designer":       buildDesignerSystem,
  "build-world":          buildWorldSystem,
  "build-coder":          buildCoderSystem,
  "build-artist":         buildArtistSystem,
  "build-qa":             buildQaSystem,
};

// Appended to every agent system prompt to enforce consistent, expert behavior
// across all Axon agents — platform and community.
const BEHAVIOR_RULES = `

---
Behavior:
- Never open with filler phrases like "Certainly", "Of course", "Sure", "Absolutely", "Great question", or "I'd be happy to help"
- Do not summarise what you are about to do, just do it
- Do not hedge or qualify every statement, be direct and confident in your expertise
- Omit disclaimers about not being a financial, legal, or medical advisor unless the task specifically and genuinely requires one
- Never pad responses with generic closing lines like "Let me know if you need anything else"
- You are a specialist agent deployed on the Axon network, respond with the precision and directness of a domain expert, not a general-purpose assistant`;

/** What a model is told when a round ran out of room before it said or did anything. */
const CUT_BEFORE_ANYTHING = "Your last turn ran out of room before you said or did anything. Do not plan at length: take your next step now, or give your answer.";
/** And when the step it was writing was cut off half way. */
const CUT_MID_CALL = "Your last step was cut off at the length limit before it could run, so nothing came of it. Take it again with less in it: one action, a shorter note. Then go on.";

// Per-agent token limits — build agents need much higher limits to produce
// complete HTML5 games. All other agents use the default 2048.
// The coder runs on claude-fable-5, whose always-on thinking bills against
// max_tokens — the extra headroom keeps the game itself at ~28k.
const AGENT_MAX_TOKENS: Record<string, number> = {
  "build-orchestrator": 1024,
  "build-designer":     1024,
  "build-world":        2048,
  "build-coder":        40000,
  "build-artist":       28000,
  "build-qa":           1024,
};

export function getAgentMaxTokens(agentId: string): number {
  // 1000-token default (~700 words): interactive-speed deliverables. Length is
  // NOT a truncation risk — the provider auto-continues if a response ever
  // hits the ceiling; agents with bigger real needs are listed above.
  return AGENT_MAX_TOKENS[agentId] ?? 1000;
}

// Returns the agent's real system prompt, or a strong generic fallback
// for community agents registered with their own endpoint.
/** Whether Autonomy 3 may improve this agent and has written instructions for it. */
function improvedByAutonomy(agentId: string): boolean {
  try {
    const r = getDb().prepare("SELECT auto_improve, instructions FROM agents WHERE agent_id = ?").get(agentId) as { auto_improve?: number; instructions?: string | null } | undefined;
    return r?.auto_improve === 1 && Boolean(r.instructions?.trim());
  } catch {
    return false; // before migration 128
  }
}

/** The instructions an agent runs on before any of its own: Axon's code for its own agents, else none. */
export function codeInstructions(agentId: string): string | null {
  return AGENT_SYSTEMS[agentId] ?? null;
}

/** The prompt an agent without instructions of its own runs on, from its name and capabilities. */
export function genericCore(agent: Pick<Agent, "name" | "capabilities">): string {
  return `You are ${agent.name}, a specialized agent operating on the Axon agent network. ` +
    `Your capabilities: ${agent.capabilities.join(", ")}.\n\n` +
    `Deliver expert-level responses in your domain. Structure every response with clear headers and sections. ` +
    `Be specific, use numbers, examples, and concrete recommendations. ` +
    `Lead with the most important information. ` +
    `Give complete answers, not overviews. ` +
    `Think like the best specialist in your field, not a general assistant.`;
}

/** The system an agent with instructions of its own runs on: those instructions and the network's behaviour rules. */
export function systemWithInstructions(agent: Pick<Agent, "name">, instructions: string): string {
  return `You are ${agent.name}, an agent on the Axon agent network. Your owner wrote these instructions for you:\n\n${instructions}` + BEHAVIOR_RULES;
}

export function getAgentSystem(agent: Agent): string {
  // an agent's own instructions, written by its owner or by Agent Studio, in place of the generic prompt; Axon's own
  // agents keep theirs, which are code
  // An agent of Axon's own whose instructions Autonomy 3 improved (it is switched on for it) uses the improved ones.
  const own = AGENT_SYSTEMS[agent.agentId] && !improvedByAutonomy(agent.agentId) ? null : getInstructions(agent.agentId);
  if (own) return systemWithInstructions(agent, own);
  const core = AGENT_SYSTEMS[agent.agentId] ?? genericCore(agent);

  // Dense beats long, everywhere on the network: tasks settle in seconds, not
  // minutes, and nobody hires an agent twice for a wall of filler.
  return (
    core +
    BEHAVIOR_RULES +
    `\n\nLENGTH: Default to SHORT, dense deliverables, roughly 250-350 words. ` +
    `Only go longer when the task explicitly asks for exhaustive depth. Always end with a clean conclusion.`
  );
}

// ── Provider interface ────────────────────────────────────────────────────────

// One tool invocation, reported the moment it finishes so the caller can put it
// in the receipt's flight recorder. Raw args and result are handed over so the
// caller can hash them — nothing content-bearing is ever stored by the trace.
export interface ToolCallEvent {
  /** Readable name for the receipt: "web_search", or "<server>/<tool>" for MCP. */
  tool: string;
  kind: "web_search" | "web_fetch" | "mcp" | "code";
  ok: boolean;
  /** null for server-side tools, which run inside the model call and aren't timed separately. */
  latencyMs: number | null;
  input: string;
  output: string;
  error?: string;
}

export type ToolCallSink = (event: ToolCallEvent) => void;

/**
 * Something an agent does, reported the moment it is known rather than when the call is over: what it said before
 * reaching for a tool, and each tool as it starts. For a live log of a running job; the trace is still written from
 * the finished calls.
 */
export type LiveEvent =
  | { type: "note"; text: string }
  | { type: "tool"; id: string; tool: string; input: unknown }
  // a tool Axon runs itself, while the model is still writing the call: `json` is its input as far as it has got
  | { type: "writing"; id: string; tool: string; json: string };
export type LiveSink = (event: LiveEvent) => void;

/**
 * Whether a model call failed because a tool call it streamed was not JSON. The library reads such a call as it
 * grows and gives up on the first piece it cannot read; the error it raises is the JSON parser's own.
 */
export function brokenCall(err: unknown): boolean {
  const seen = new Set<unknown>();
  for (let e: unknown = err; e && !seen.has(e); e = (e as { cause?: unknown }).cause) {
    seen.add(e);
    if (e instanceof SyntaxError) return true;
    const m = e instanceof Error ? e.message : "";
    if (/\bin JSON at position \d+|Unexpected end of JSON input|Unexpected token .* in JSON|is not valid JSON|Unterminated string in JSON|Bad (control character|escaped character) in string literal/i.test(m)) return true;
  }
  return false;
}

/** How much more of a call the model must have written before it is reported again, in characters. */
const WRITING_EVERY = 300;
interface StreamStep { type: string; index?: number; content_block?: { type: string; id?: string; name?: string }; delta?: { type: string; partial_json?: string } }

/**
 * Report a model call's steps while it streams: a tool the model runs itself (a search, code in its sandbox) the
 * moment the call to it is complete, and what the model said just before. The words of the final answer are never
 * reported: text only counts as a note once a tool follows it. Nothing here may break the call it watches.
 *
 * A tool Axon runs itself is reported once the call is over (where it is run). But the model writes such a call out
 * first, and a long one (the files of a page) takes most of a minute: how far it has got is reported as it grows, so
 * that whoever watches is not looking at nothing.
 */
function watchSteps(stream: unknown, sink: LiveSink): void {
  const s = stream as { on?: (event: string, fn: (block: { type: string; text?: string; id?: string; name?: string; input?: unknown }) => void) => unknown };
  if (typeof s.on !== "function") return;
  let said: string | null = null;
  try {
    const writing = new Map<number, { id: string; tool: string; json: string; told: number }>();
    const tell = (w: { id: string; tool: string; json: string; told: number }) => { w.told = w.json.length; sink({ type: "writing", id: w.id, tool: w.tool, json: w.json }); };
    (s.on as (event: string, fn: (e: StreamStep) => void) => unknown)("streamEvent", (e) => {
      try {
        if (e.type === "content_block_start" && e.content_block?.type === "tool_use" && e.content_block.id && e.content_block.name && typeof e.index === "number") {
          writing.set(e.index, { id: e.content_block.id, tool: e.content_block.name, json: "", told: 0 });
        } else if (e.type === "content_block_delta" && e.delta?.type === "input_json_delta" && typeof e.index === "number") {
          const w = writing.get(e.index);
          if (!w) return;
          w.json += e.delta.partial_json ?? "";
          if (w.json.length - w.told >= WRITING_EVERY) tell(w);
        } else if (e.type === "content_block_stop" && typeof e.index === "number") {
          const w = writing.get(e.index);
          writing.delete(e.index);
          if (w && w.json.length > w.told) tell(w);
        }
      } catch {
        /* a step that could not be reported is not worth a failed job */
      }
    });
  } catch {
    /* not a stream that reports its events */
  }
  try {
    s.on("contentBlock", (block) => {
      try {
        if (block.type === "text") { said = block.text ?? null; return; }
        if (block.type !== "server_tool_use" && block.type !== "tool_use") return;
        if (said && said.trim()) sink({ type: "note", text: said });
        said = null;
        // a tool Axon runs itself is reported where it is run; here only the ones that run inside the model call
        if (block.type === "server_tool_use" && block.id && block.name) sink({ type: "tool", id: block.id, tool: block.name, input: block.input });
      } catch {
        /* a step that could not be reported is not worth a failed job */
      }
    });
  } catch {
    /* not a stream that reports its blocks */
  }
}

export interface ToolRunOptions {
  /** Called as each tool finishes, so the caller can record it in the trace. */
  onToolCall?: ToolCallSink;
  /** Called as each step starts, for a live log of the job while it runs. */
  onLive?: LiveSink;
  /**
   * Stops the loop between rounds. A tool loop is many model calls, so a caller
   * whose client has gone away (a disconnected SSE stream) needs a way to stop
   * paying for the rest of it.
   */
  signal?: AbortSignal;
  /**
   * How deep this run may go, when the agent's owner has earned more than the default. Absent means
   * the base limits, which is what every agent has always had. Passed in rather than looked up:
   * this module must not pull the DB or a chain read onto the model-call path.
   */
  maxSteps?: number;
  maxToolResultChars?: number;
  /** PDFs and pictures handed over with the hire. Given to the model as themselves, ahead of the message. */
  attachments?: ModelAttachment[];
  /**
   * Something the person said while the job runs. Asked between rounds: what it returns goes to the model with the
   * results of the tools it just used. And asked when the model would finish: if there is something, the model gets
   * it and one more round, so a note that arrives late still changes the answer. Returns null for nothing.
   */
  notes?: () => string | null;
  /**
   * For an agent that may run code: the hire's files, which are put into its sandbox, and where anything it writes
   * there for the person is handed once the job is done. Only used when the tools include the sandbox.
   */
  sandbox?: {
    files: SandboxFile[];
    onFile?: (file: SandboxFile) => void | Promise<void>;
    /** Files that have come to the job since it was last asked (something its browser fetched). Asked between rounds. */
    more?: () => SandboxFile[];
  };
}

/** A file going into, or coming out of, the sandbox an agent runs code in. */
export interface SandboxFile { name: string; mime: string; bytes: Buffer }

/** What an agent with a sandbox is told about it, after its own instructions. */
export const CODE_NOTE = `

You can run code. You have a sandbox with Python and a shell. Use it for every calculation, count, comparison or chart: run the code and report what it printed, and never work numbers out in your head. The files attached to this job are in the sandbox; list the working directory and any upload directory to find them. If you make a chart or a file for the person, save it in the output directory ($OUTPUT_DIR when it is set, otherwise the working directory) under a clear name, and say in your answer what each file is.`;

/** How many files one job may hand back from its sandbox, and how large each may be. */
const MAX_SANDBOX_OUTPUTS = 6;
const MAX_SANDBOX_OUTPUT_BYTES = 10 * 1024 * 1024;
const FILES_BETA = "files-api-2025-04-14";
const isCodeTool = (t: unknown): boolean => typeof (t as { type?: string }).type === "string" && (t as { type: string }).type.startsWith("code_execution");

export interface ProviderClient {
  /**
   * `attachments` are PDFs and pictures handed over with the hire. Only a provider that can take them is ever given
   * any: the hire is refused up front for an agent whose model cannot read them.
   */
  complete(system: string, message: string, maxTokens?: number, temperature?: number, attachments?: ModelAttachment[]): Promise<string>;
  stream(system: string, message: string, maxTokens?: number): AsyncIterable<string>;
  /** After a stream from a provider that routes (Raeto): the model that really answered, and what it cost. */
  lastRoute?: { model: string; costUsd?: number } | null;
  /**
   * Run the completion as a bounded tool loop: the model may search, fetch, and
   * call MCP tools before it answers. Optional — providers without tool support
   * omit it and the caller falls back to a plain single call.
   */
  completeWithTools?(
    system: string,
    message: string,
    maxTokens: number,
    tools: ResolvedTools,
    opts?: ToolRunOptions,
  ): Promise<string>;
}

// Joins a continuation onto a truncated output. The model may resume a few
// characters before where it stopped, so trim the longest overlap between the
// end of what we have and the start of the continuation before concatenating.
function stitchContinuation(soFar: string, continuation: string): string {
  const maxOverlap = Math.min(soFar.length, continuation.length, 400);
  for (let len = maxOverlap; len > 0; len--) {
    if (soFar.slice(soFar.length - len) === continuation.slice(0, len)) {
      return soFar + continuation.slice(len);
    }
  }
  return soFar + continuation;
}

// ── Anthropic ─────────────────────────────────────────────────────────────────

// Where a completion lands if the primary model declines it with a safety
// refusal (Fable-class models only — Opus/Haiku never emit stop_reason "refusal").
const REFUSAL_FALLBACK_MODEL = "claude-opus-4-8";

// Per-provider default models — one source of truth, so getProvider (what runs)
// and effectiveModel (what a reproducibility proof records) can never drift apart.
const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-5";
const DEFAULT_OLLAMA_MODEL = "llama3.2";
const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";
// xAI's API is OpenAI-compatible. grok-4.5 is the current flagship alias (xAI's
// coding-leading model, live in the EU as of July 2026); env-overridable
// (XAI_MODEL) in case xAI changes the identifier.
const DEFAULT_GROK_MODEL = process.env.XAI_MODEL ?? "grok-4.5";
// NockAI's Nock Coder, an open 1.5B coding model, served by Surplus (an OpenAI-compatible inference market on
// Robinhood Chain) at $0.03 per million tokens in and out. NOCK_MODEL overrides the id if Surplus changes it.
export const SURPLUS_BASE_URL = "https://api.surplusllm.com/api/v1";
export const DEFAULT_NOCK_MODEL = process.env.NOCK_MODEL ?? "launch/Nock-AI/nock-coder-1.5b@18859c0";

// True when the API says the model itself can't be used by this org (not a
// transient failure): unknown model or missing entitlement.
// The API rejected the request shape itself (400) — not a transient failure and
// not something a retry fixes.
function isBadRequest(err: unknown): boolean {
  try {
    return err instanceof Anthropic.BadRequestError;
  } catch {
    return false; // SDK error classes unavailable (mocked module)
  }
}

function isModelUnavailable(err: unknown): boolean {
  try {
    return (
      err instanceof Anthropic.NotFoundError ||
      err instanceof Anthropic.PermissionDeniedError
    );
  } catch {
    return false; // SDK error classes unavailable (mocked module)
  }
}

// ── Tool-loop helpers ─────────────────────────────────────────────────────────

// A loop that spent every round on tools and never wrote an answer has produced
// nothing to deliver. Fail loudly — the task then fails and refunds, which is the
// honest outcome. Silently completing with "" would settle payment for no work.
function requireText(text: string): string {
  if (!text.trim()) throw new Error("No text response from Anthropic (tool loop produced no answer)");
  return text;
}

// Server-side tools (web search / fetch) run inside the model call, so they show
// up as matched server_tool_use → *_tool_result pairs in the response rather than
// as something we execute. Pair them up and report each one.
function reportServerToolCalls(content: Anthropic.ContentBlock[], sink?: ToolCallSink, produced?: Set<string>): void {
  const uses = new Map<string, { name: string; input: unknown }>();
  for (const block of content) {
    if (block.type === "server_tool_use") uses.set(block.id, { name: block.name, input: block.input });
  }
  for (const block of content) {
    const type = block.type as string;
    // A run in the sandbox: what was run, what it printed, and any file it wrote for the person.
    if (type === "bash_code_execution_tool_result" || type === "code_execution_tool_result" || type === "text_editor_code_execution_tool_result") {
      const b = block as unknown as { tool_use_id: string; content: { error_code?: string; stdout?: string; stderr?: string; return_code?: number; content?: { file_id?: string }[] } | null };
      const use = uses.get(b.tool_use_id);
      const payload = b.content ?? {};
      for (const f of Array.isArray(payload.content) ? payload.content : []) if (f?.file_id) produced?.add(f.file_id);
      if (sink) {
        const printed = `${payload.stdout ?? ""}${payload.stderr ? `\n[stderr]\n${payload.stderr}` : ""}`;
        sink({
          tool: use?.name ?? "code_execution",
          kind: "code",
          ok: !payload.error_code && (payload.return_code ?? 0) === 0,
          latencyMs: null,
          input: JSON.stringify(use?.input ?? {}),
          output: payload.error_code ? "" : printed.slice(0, 20_000),
          ...(payload.error_code ? { error: payload.error_code } : {}),
        });
      }
      continue;
    }
    if (!sink) continue;
    if (block.type !== "web_search_tool_result" && block.type !== "web_fetch_tool_result") continue;
    const use = uses.get(block.tool_use_id);
    const kind = block.type === "web_search_tool_result" ? "web_search" : "web_fetch";
    // A failed server tool returns a single error object where a success returns
    // results; that shape difference is the only signal available here.
    const payload = block.content as unknown;
    const errorCode =
      payload && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as { error_code?: string }).error_code
        : undefined;
    sink({
      tool: use?.name ?? kind,
      kind,
      ok: !errorCode,
      latencyMs: null,
      input: JSON.stringify(use?.input ?? {}),
      output: errorCode ? "" : JSON.stringify(payload ?? null),
      ...(errorCode ? { error: errorCode } : {}),
    });
  }
}

// Execute one model-requested local (MCP) tool call and shape the result block.
/** What the person said while the job runs, if anything. A reader that fails says nothing: the job goes on. */
function readNotes(notes: (() => string | null) | undefined): string | null {
  if (!notes) return null;
  try {
    return notes()?.trim() || null;
  } catch {
    return null;
  }
}

// A tool that throws comes back as an is_error result rather than a thrown
// exception: the model can read the message and try something else, which is a
// far better outcome for a paid task than failing the whole job.
/** The words of a tool's result, whether it answered in words alone or with pictures beside them. */
const wordsOf = (block: Anthropic.ToolResultBlockParam): string =>
  typeof block.content === "string" ? block.content : (block.content ?? []).flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");

async function runLocalTool(
  use: Anthropic.ToolUseBlock,
  byName: Map<string, LocalTool>,
  sink?: ToolCallSink,
  maxResultChars: number = MAX_TOOL_RESULT_CHARS,
): Promise<Anthropic.ToolResultBlockParam> {
  const tool = byName.get(use.name);
  const args = (use.input ?? {}) as Record<string, unknown>;
  if (!tool) {
    return {
      type: "tool_result",
      tool_use_id: use.id,
      content: `Unknown tool '${use.name}'. Use only the tools provided.`,
      is_error: true,
    };
  }

  const startedAt = Date.now();
  try {
    const rich = tool.runRich ? await tool.runRich(args) : null;
    const raw = rich ? rich.text : await tool.run(args);
    const output =
      raw.length > maxResultChars ? `${raw.slice(0, maxResultChars)}\n…[truncated]` : raw;
    // pictures the tool answered with go to the model beside the words; what is recorded of the call is the words
    const pictures = (rich?.images ?? []).slice(0, 2).filter((i) => /^image\/(jpeg|png|gif|webp)$/.test(i.mime) && i.data.length > 0 && i.data.length <= 4_000_000);
    sink?.({
      tool: tool.label,
      kind: "mcp",
      ok: true,
      latencyMs: Date.now() - startedAt,
      input: JSON.stringify(args),
      output,
    });
    // a PDF the tool fetched goes to the model as the document it is
    const papers = (rich?.documents ?? []).slice(0, 1).filter((d) => d.data.length > 4 && d.data.length <= 20_000_000 && d.data.subarray(0, 5).toString("latin1") === "%PDF-");
    if (pictures.length || papers.length) {
      return {
        type: "tool_result",
        tool_use_id: use.id,
        content: [
          { type: "text", text: output || "(no output)" },
          ...pictures.map((i) => ({ type: "image" as const, source: { type: "base64" as const, media_type: i.mime as "image/jpeg" | "image/png" | "image/gif" | "image/webp", data: i.data.toString("base64") } })),
          ...papers.map((d) => ({ type: "document" as const, source: { type: "base64" as const, media_type: "application/pdf" as const, data: d.data.toString("base64") }, title: d.name.slice(0, 200) })),
        ],
      };
    }
    return { type: "tool_result", tool_use_id: use.id, content: output || "(no output)" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "tool call failed";
    sink?.({
      tool: tool.label,
      kind: "mcp",
      ok: false,
      latencyMs: Date.now() - startedAt,
      input: JSON.stringify(args),
      output: "",
      error: msg,
    });
    return { type: "tool_result", tool_use_id: use.id, content: `Error: ${msg}`, is_error: true };
  }
}

/** The first user turn: the hire's PDFs and pictures as themselves, then the words. Just the words when there are none. */
export function firstTurn(message: string, attachments?: ModelAttachment[]): Anthropic.MessageParam["content"] {
  if (!attachments?.length) return message;
  const blocks: Anthropic.ContentBlockParam[] = attachments.map((a) =>
    a.kind === "pdf"
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: a.data }, title: a.name }
      : { type: "image", source: { type: "base64", media_type: a.mime as "image/png" | "image/jpeg" | "image/gif" | "image/webp", data: a.data } },
  );
  return [...blocks, { type: "text", text: message }];
}

class AnthropicProvider implements ProviderClient {
  private client: Anthropic;
  private model: string;

  constructor(model?: string) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
    this.client = new Anthropic({ apiKey });
    // Sonnet 5 default: current knowledge (Haiku 4.5's early-2025 cutoff
    // predated x402 and dead-ended research tasks) at interactive speed — a
    // 3-step pipeline on Opus took minutes, which kills the showcase.
    this.model = model ?? DEFAULT_ANTHROPIC_MODEL;
  }

  // 4096: Opus-tier agents write full deliverables — 2048 truncated pipeline
  // outputs mid-sentence.
  async complete(system: string, message: string, maxTokens = 4096, temperature?: number, attachments?: ModelAttachment[]): Promise<string> {
    return this.withModelFallback((model) => this.completeWith(model, system, message, maxTokens, temperature, attachments));
  }

  // Runs `attempt` on the configured model and, if that model is unavailable to
  // this org (404/403) or declines the request outright (stop_reason "refusal",
  // occasionally a false positive on benign work), re-runs it on the Opus
  // fallback. A paid task must never die on either.
  private async withModelFallback(
    attempt: (model: string) => Promise<{ text: string; refused: boolean }>,
  ): Promise<string> {
    let first: { text: string; refused: boolean };
    try {
      first = await attempt(this.model);
    } catch (err) {
      if (this.model !== REFUSAL_FALLBACK_MODEL && isModelUnavailable(err)) {
        logger.warn("provider.model_fallback", "Primary model unavailable, falling back", {
          model: this.model,
          fallback: REFUSAL_FALLBACK_MODEL,
          reason: err instanceof Error ? err.message : String(err),
        });
        const rescued = await attempt(REFUSAL_FALLBACK_MODEL);
        if (rescued.refused) throw new Error("Model declined the request (fallback included)");
        return rescued.text;
      }
      throw err;
    }
    if (!first.refused) return first.text;
    if (this.model === REFUSAL_FALLBACK_MODEL) {
      throw new Error(`Model ${this.model} declined the request`);
    }
    logger.warn("provider.model_fallback", "Primary model refused, falling back", {
      model: this.model,
      fallback: REFUSAL_FALLBACK_MODEL,
      reason: "refusal",
    });
    const second = await attempt(REFUSAL_FALLBACK_MODEL);
    if (second.refused) throw new Error("Model declined the request (fallback included)");
    return second.text;
  }

  // ── Tool loop ───────────────────────────────────────────────────────────────
  // The agent gets to look things up before it answers: the model may call web
  // search, web fetch, and any granted MCP tool, and we feed each result back
  // until it stops asking. Bounded by MAX_TOOL_STEPS, then forced to answer.

  async completeWithTools(
    system: string,
    message: string,
    maxTokens: number,
    tools: ResolvedTools,
    opts: ToolRunOptions = {},
  ): Promise<string> {
    return this.withModelFallback((model) => this.toolLoop(model, system, message, maxTokens, tools, opts));
  }

  // With a sandbox: the hire's files are put into it before the first call, and whatever it wrote for the person is
  // fetched and handed over after the last. Both happen whatever way the loop ends.
  private async toolLoop(
    model: string,
    system: string,
    message: string,
    maxTokens: number,
    tools: ResolvedTools,
    opts: ToolRunOptions,
  ): Promise<{ text: string; refused: boolean }> {
    if (!tools.serverTools.some(isCodeTool)) return this.runToolLoop(model, system, message, maxTokens, tools, opts, null);
    const box = { uploads: [] as string[], produced: new Set<string>() };
    for (const f of opts.sandbox?.files ?? []) {
      try {
        const up = await this.client.beta.files.upload({ file: await toFile(f.bytes, f.name, { type: f.mime }) });
        box.uploads.push(up.id);
      } catch (err) {
        // the file is still in the message as text or as itself; only the sandbox copy is missing
        logger.warn("provider.sandbox_upload_failed", "A file could not be put into the sandbox", { name: f.name, err });
      }
    }
    try {
      return await this.runToolLoop(model, system + CODE_NOTE, message, maxTokens, tools, opts, box);
    } finally {
      // Code that is run again writes its file again, under the same name. The person gets each file once, as it
      // stood last: an earlier copy under the same name was a draft.
      const latest = new Map<string, { id: string; mime: string; size: number }>();
      for (const id of box.produced) {
        try {
          const meta = await this.client.beta.files.retrieveMetadata(id);
          latest.delete(meta.filename);
          latest.set(meta.filename, { id, mime: meta.mime_type, size: meta.size_bytes });
        } catch (err) {
          logger.warn("provider.sandbox_download_failed", "A file the agent wrote could not be looked up", { err });
        }
      }
      let handed = 0;
      for (const [name, f] of latest) {
        if (handed >= MAX_SANDBOX_OUTPUTS) break;
        if (f.size > MAX_SANDBOX_OUTPUT_BYTES) continue;
        try {
          const bytes = Buffer.from(await (await this.client.beta.files.download(f.id)).arrayBuffer());
          await opts.sandbox?.onFile?.({ name, mime: f.mime, bytes });
          handed++;
        } catch (err) {
          logger.warn("provider.sandbox_download_failed", "A file the agent wrote could not be fetched", { err });
        }
      }
      // nothing of a job is left with the model provider
      for (const id of [...box.uploads, ...box.produced]) void this.client.beta.files.delete(id).catch(() => {});
    }
  }

  private async runToolLoop(
    model: string,
    system: string,
    message: string,
    maxTokens: number,
    tools: ResolvedTools,
    { onToolCall, onLive, signal, maxSteps: maxStepsOpt, maxToolResultChars, attachments, notes, sandbox }: ToolRunOptions,
    box: { uploads: string[]; produced: Set<string> } | null,
  ): Promise<{ text: string; refused: boolean }> {
    const timeoutMs = Math.max(120_000, maxTokens * 30);
    const byName = new Map<string, LocalTool>(tools.localTools.map((t) => [t.name, t]));
    const defsOf = (eager: boolean): Anthropic.Messages.ToolUnion[] => [
      ...tools.serverTools,
      ...tools.localTools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema as Anthropic.Messages.Tool.InputSchema,
        // a call that is long to write is sent as it is written, so it can be watched (see LocalTool.eager)
        ...(eager && t.eager ? { eager_input_streaming: true } : {}),
      })),
    ];
    // A call sent as it is written is not checked on the way: now and then what arrives is not JSON (a quote the
    // model did not escape), and the whole answer is lost. The round is then asked for again the ordinary way, where
    // a call only arrives whole and checked, and the rest of the job stays that way.
    let eager = tools.localTools.some((t) => t.eager);
    let toolDefs = defsOf(eager);

    const first = firstTurn(message, attachments);
    // the hire's files, placed in the sandbox, follow the message
    const opening: Anthropic.MessageParam["content"] = box?.uploads.length
      ? [...(typeof first === "string" ? [{ type: "text" as const, text: first }] : first), ...box.uploads.map((id) => ({ type: "container_upload" as const, file_id: id }))]
      : first;
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: opening }];
    let lastText = "";
    // the sandbox lives across the calls of one job: later calls name it, so its files and state are still there
    let containerId: string | null = null;
    // a step in the sandbox that was cut off at the length limit is asked for again, once
    let cutOnce = false;
    // results of this round that a later round's results will replace (see LocalTool.shrink)
    const looks: { block: Anthropic.ToolResultBlockParam; tool: LocalTool }[] = [];

    // One extra pass past the cap, with tools switched off, so a loop that runs
    // long still ends with a real deliverable instead of a dangling tool call.
    // Never below the default: a caller passing something odd may deepen a run, never shorten one
    // behind the agent's back.
    const maxSteps = Math.max(MAX_TOOL_STEPS, Math.floor(maxStepsOpt ?? MAX_TOOL_STEPS));
    const maxResultChars = Math.max(
      MAX_TOOL_RESULT_CHARS,
      Math.floor(maxToolResultChars ?? MAX_TOOL_RESULT_CHARS),
    );

    for (let step = 0; step <= maxSteps; step++) {
      // Checked before every model call, so an abandoned request stops costing
      // money at the next round boundary rather than running the loop out.
      if (signal?.aborted) throw new Error("Tool loop aborted");
      const exhausted = step === maxSteps;
      const msg = await withRetry(
        () => {
          const stream = this.client.messages.stream(
            {
              model,
              max_tokens: maxTokens,
              system,
              messages,
              tools: toolDefs,
              ...(exhausted ? { tool_choice: { type: "none" as const } } : {}),
              ...(containerId ? { container: containerId } : {}),
            },
            { timeout: timeoutMs, ...(box?.uploads.length ? { headers: { "anthropic-beta": FILES_BETA } } : {}) },
          );
          if (onLive) watchSteps(stream, onLive);
          return stream.finalMessage();
        },
        3,
        1000,
        `anthropic-tools:${model}`,
      ).catch((err: unknown) => {
        if (!eager || !brokenCall(err)) throw err;
        logger.warn("provider.eager_call_broken", "A call written as it streamed was not JSON: asking for the round again, whole", { model, step, error: err instanceof Error ? err.message.slice(0, 160) : String(err) });
        eager = false;
        toolDefs = defsOf(false);
        return null;
      });
      // the round is asked for again; it costs no step of the job's own
      if (!msg) { step--; continue; }

      try {
        if (msg.usage) recordModelUsage(model, msg.usage.input_tokens ?? 0, msg.usage.output_tokens ?? 0);
      } catch {
        /* usage capture is optional */
      }

      if ((msg.stop_reason as string) === "refusal") return { text: "", refused: true };

      reportServerToolCalls(msg.content, onToolCall, box?.produced);
      if (box && msg.container?.id) containerId = msg.container.id;

      const text = msg.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      if (text) lastText = text;

      // A long server-tool run pauses the turn; resume by replaying it back with
      // no new user message. Costs a step, which is the point of the cap.
      if ((msg.stop_reason as string) === "pause_turn") {
        messages.push({ role: "assistant", content: msg.content as Anthropic.ContentBlockParam[] });
        continue;
      }

      const toolUses = msg.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      if (toolUses.length === 0) {
        // About to finish. A note that came in while it worked still counts: the model gets it and one more round.
        // That holds for an answer cut off at its length limit too: the round after is a whole answer, with the note.
        const late = exhausted ? null : readNotes(notes);
        // a run that ends with nothing said fails below; say first how it ended, since the message alone does not
        if (!late && !lastText.trim()) {
          logger.warn("provider.tool_loop_empty", "A tool loop ended with no words", { model, step, stop: msg.stop_reason, blocks: msg.content.map((b) => b.type).join(",") });
        }
        // Cut off at the length limit while it was writing a step for the sandbox: the step never ran, so there is
        // no result and often no answer either. Once, it is told so and asked to take the step in smaller pieces.
        // The cut step itself is not sent back: half a call is not something the model can be shown again.
        const cutStep = (msg.stop_reason as string) === "max_tokens" && msg.content.some((b) => (b.type as string) === "server_tool_use");
        if (cutStep && !exhausted && !cutOnce) {
          cutOnce = true;
          logger.warn("provider.tool_step_cut", "A sandbox step was cut off at the length limit; asking for it again in smaller pieces", { model, step, maxTokens });
          messages.push({ role: "assistant", content: text || "(My last step was cut off before it could run.)" });
          messages.push({ role: "user", content: `${late ? `${late}\n\n` : ""}Your last step was cut off at the length limit before it could run, so nothing came of it. Take it again in smaller pieces: shorter code, one part at a time. Then give your answer.` });
          continue;
        }
        // Cut off at the length limit before it said or did anything: its thinking took all the room. Once, it is
        // told so and asked to go on, rather than the whole job failing with nothing to show.
        if ((msg.stop_reason as string) === "max_tokens" && !text && !cutStep && !exhausted && !cutOnce) {
          cutOnce = true;
          logger.warn("provider.tool_round_cut", "A round was cut off at the length limit before anything was said or done; asking again", { model, step, maxTokens });
          messages.push({ role: "assistant", content: "(I ran out of room before I said or did anything.)" });
          messages.push({ role: "user", content: `${late ? `${late}\n\n` : ""}${CUT_BEFORE_ANYTHING}` });
          continue;
        }
        if (!late) return { text: requireText(lastText), refused: false };
        messages.push({ role: "assistant", content: msg.content as Anthropic.ContentBlockParam[] });
        messages.push({ role: "user", content: late });
        continue;
      }

      // Truncation can cut a tool call off mid-arguments. Running it would call
      // the tool with the wrong input, so it is never run. With words already written, those are delivered.
      // With none, it is asked once to take the step again, shorter: half a call is not shown back to it.
      if ((msg.stop_reason as string) === "max_tokens") {
        if (!text && !exhausted && !cutOnce) {
          cutOnce = true;
          logger.warn("provider.tool_call_cut", "A tool call was cut off at the length limit; asking for it again, shorter", { model, step, maxTokens });
          messages.push({ role: "assistant", content: "(My last step was cut off before it could run.)" });
          messages.push({ role: "user", content: CUT_MID_CALL });
          continue;
        }
        return { text: requireText(lastText), refused: false };
      }

      messages.push({ role: "assistant", content: msg.content as Anthropic.ContentBlockParam[] });
      // Parallel tool calls arrive in one message and all results must go back in
      // one user message — splitting them teaches the model to stop parallelising.
      if (onLive) {
        for (const use of toolUses) {
          try {
            onLive({ type: "tool", id: use.id, tool: use.name, input: use.input });
          } catch {
            /* a step that could not be reported is not worth a failed job */
          }
        }
      }
      const results = await Promise.all(
        toolUses.map((use) => runLocalTool(use, byName, onToolCall, maxResultChars)),
      );
      // A tool whose results are each a fresh look at the same thing: once it has given a newer look, the looks of
      // EARLIER rounds are cut down. Until then they stay whole, so an agent that turns to another tool still has its
      // page; and everything it asked for in this round stays whole too, since it has not been shown any of it yet.
      const fresh = toolUses.flatMap((use, i) => {
        const tool = byName.get(use.name);
        return tool?.shrink && !results[i].is_error && (tool.isLook?.(wordsOf(results[i])) ?? true) ? [{ tool, block: results[i] }] : [];
      });
      for (let i = looks.length - 1; i >= 0; i--) {
        const old = looks[i];
        if (!fresh.some((f) => f.tool === old.tool)) continue;
        old.block.content = old.tool.shrink!(wordsOf(old.block));
        looks.splice(i, 1);
      }
      // Something large the tool answered that is not a look (a file it fetched, with its words or the file itself):
      // it cuts nothing down, but it is cut down itself once there is a newer look, like a look would be.
      const heavy = toolUses.flatMap((use, i) => {
        const tool = byName.get(use.name);
        if (!tool?.shrink || results[i].is_error || fresh.some((f) => f.block === results[i])) return [];
        return Array.isArray(results[i].content) || wordsOf(results[i]).length > 1_500 ? [{ tool, block: results[i] }] : [];
      });
      looks.push(...fresh, ...heavy);
      // files that came to the job while it ran (something its browser fetched) are put into the sandbox now
      const arrived: Anthropic.ContentBlockParam[] = [];
      if (box) {
        for (const f of sandbox?.more?.() ?? []) {
          try {
            const up = await this.client.beta.files.upload({ file: await toFile(f.bytes, f.name, { type: f.mime }) });
            box.uploads.push(up.id);
            arrived.push({ type: "container_upload", file_id: up.id } as unknown as Anthropic.ContentBlockParam);
          } catch (err) {
            logger.warn("provider.sandbox_upload_failed", "A file could not be put into the sandbox", { name: f.name, err });
          }
        }
      }
      // a note from the person goes back with the results, after them
      const said = readNotes(notes);
      messages.push({ role: "user", content: arrived.length || said ? [...results, ...arrived, ...(said ? [{ type: "text" as const, text: said }] : [])] : results });
    }

    return { text: requireText(lastText), refused: false };
  }

  private async completeWith(
    model: string,
    system: string,
    message: string,
    maxTokens: number,
    temperature?: number,
    attachments?: ModelAttachment[],
  ): Promise<{ text: string; refused: boolean }> {
    const timeoutMs = Math.max(120_000, maxTokens * 30);
    const first = firstTurn(message, attachments);
    // If the model hits the token ceiling mid-output, ask it to continue from
    // where it stopped — as a normal follow-up turn, since this model doesn't
    // allow assistant prefill (the conversation must end with a user message).
    // Stitch the pieces (trimming any repeated boundary overlap) so a long file
    // completes across chunks instead of failing. The ceiling is a chunk size.
    const MAX_CONTINUATIONS = 5;
    let full = "";
    for (let round = 0; round <= MAX_CONTINUATIONS; round++) {
      const messages: Anthropic.MessageParam[] =
        round === 0
          ? [{ role: "user", content: first }]
          : [
              { role: "user", content: first },
              { role: "assistant", content: full },
              {
                role: "user",
                content:
                  "Your previous response was cut off because it was too long. Continue from EXACTLY where it stopped and output ONLY the remaining content, do not repeat anything you already wrote, do not restate the file, and do not add any explanation or markdown fences.",
              },
            ];
      // NOTE: `temperature` is intentionally NOT forwarded — current Claude models
      // (Sonnet 5 / 4.6+ era) reject the parameter as deprecated (API 400). The
      // param stays in the signature for the ProviderClient interface; callers
      // needing determinism (reproducibility) rely on the pinned model + frozen
      // input and must record that no temperature was applied.
      void temperature;
      const msg = await withRetry(
        () =>
          this.client.messages
            .stream({ model, max_tokens: maxTokens, system, messages }, { timeout: timeoutMs })
            .finalMessage(),
        3,
        1000,
        `anthropic:${model}`,
      );
      // Report token usage into the active trace step (no-op when untraced),
      // accumulating across continuation rounds. Best-effort — never let it
      // disturb the model call.
      try {
        if (msg.usage) recordModelUsage(model, msg.usage.input_tokens ?? 0, msg.usage.output_tokens ?? 0);
      } catch {
        /* usage capture is optional */
      }
      // A safety refusal may arrive before any output (empty content) or
      // mid-stream (partial output) — discard partials, the caller falls back.
      if ((msg.stop_reason as string) === "refusal") return { text: "", refused: true };
      const block = msg.content.find((b) => b.type === "text");
      if (!block || block.type !== "text") throw new Error("No text response from Anthropic");
      full = round === 0 ? block.text : stitchContinuation(full, block.text);
      if (msg.stop_reason !== "max_tokens") return { text: full, refused: false }; // finished cleanly
    }
    // Continuation cap reached — return the best effort rather than failing the build.
    return { text: full, refused: false };
  }

  async *stream(system: string, message: string, maxTokens = 4096): AsyncIterable<string> {
    const s = this.client.messages.stream(
      { model: this.model, max_tokens: maxTokens, system, messages: [{ role: "user", content: message }] },
      { timeout: 180_000 }
    );
    for await (const event of s) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        yield event.delta.text;
      }
    }
  }
}

// ── OpenAI-compatible (Ollama + OpenAI share the same REST shape) ─────────────

class OpenAICompatibleProvider implements ProviderClient {
  lastRoute: { model: string; costUsd?: number } | null = null;

  constructor(
    private baseUrl: string,
    private apiKey: string,
    private model: string,
    // Raeto answers with the model that really ran and what the call cost, in headers: recorded instead of the
    // model asked for (raeto/auto) and an estimate.
    private reportsRoute = false,
  ) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) h["Authorization"] = `Bearer ${this.apiKey}`;
    return h;
  }

  // 4096: Opus-tier agents write full deliverables — 2048 truncated pipeline
  // outputs mid-sentence.
  async complete(system: string, message: string, maxTokens = 4096, temperature?: number, attachments?: ModelAttachment[]): Promise<string> {
    // Pictures go in as parts of the user turn. A PDF is never given to these models: the hire is refused up front.
    const pictures = (attachments ?? []).filter((a) => a.kind === "image");
    if (!pictures.length) return this.completeOnce(system, message, maxTokens, temperature);
    try {
      return await this.completeOnce(system, message, maxTokens, temperature, pictures);
    } catch (err) {
      // A model pinned by the agent's owner that does not look at pictures rejects the request outright. The job is
      // still answered, from the words alone, and the answer is told so rather than left to guess.
      const status = (err as { status?: number }).status;
      if (status !== 400 && status !== 415 && status !== 422) throw err;
      logger.warn("provider.pictures_rejected", "The model would not take pictures, answering without them", { model: this.model, reason: err instanceof Error ? err.message.slice(0, 200) : String(err) });
      return this.completeOnce(system, `${message}\n\n[The attached pictures could not be shown to you: this model does not look at pictures. Say so, and answer what you can from the text.]`, maxTokens, temperature);
    }
  }

  private async completeOnce(system: string, message: string, maxTokens: number, temperature?: number, pictures?: ModelAttachment[]): Promise<string> {
    const user = pictures?.length
      ? [{ type: "text", text: message }, ...pictures.map((p) => ({ type: "image_url", image_url: { url: `data:${p.mime};base64,${p.data}` } }))]
      : message;
    return withRetry(async () => {
      const res = await publicHttpFetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          model: this.model,
          max_tokens: maxTokens,
          ...(temperature !== undefined ? { temperature } : {}),
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        }),
        signal: AbortSignal.timeout(60_000),
        maxResponseBytes: 5_000_000,
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => res.statusText);
        const err = new Error(`Provider ${this.baseUrl} error ${res.status}: ${errText}`);
        (err as Error & { status?: number }).status = res.status;
        throw err;
      }

      const data = await res.json() as {
        choices: { message: { content: string } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const content = data.choices?.[0]?.message?.content;
      if (!content) throw new Error("No content in provider response");
      try {
        const ran = this.reportsRoute ? res.headers.get("x-raeto-model")?.trim() || this.model : this.model;
        const cost = this.reportsRoute ? Number(res.headers.get("x-raeto-cost") ?? NaN) : undefined;
        if (data.usage) recordModelUsage(ran, data.usage.prompt_tokens ?? 0, data.usage.completion_tokens ?? 0, Number.isFinite(cost) ? cost : undefined);
      } catch {
        /* usage capture is optional */
      }
      return content;
    }, 3, 1000, `openai-compat:${this.model}`);
  }

  async *stream(system: string, message: string, maxTokens = 4096): AsyncIterable<string> {
    this.lastRoute = null;
    const res = await publicHttpFetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        model: this.model,
        max_tokens: maxTokens,
        stream: true,
        // Raeto puts the model it picked and the cost in the last chunk, beside the usage
        ...(this.reportsRoute ? { stream_options: { include_usage: true } } : {}),
        messages: [
          { role: "system", content: system },
          { role: "user", content: message },
        ],
      }),
      signal: AbortSignal.timeout(120_000),
      maxResponseBytes: 5_000_000,
    });

    if (!res.ok || !res.body) {
      throw new Error(`Provider ${this.baseUrl} error ${res.status}`);
    }
    // a named model is in the headers from the start; raeto/auto's pick comes in the last chunk
    const named = this.reportsRoute ? res.headers.get("x-raeto-model")?.trim() : undefined;
    if (named) this.lastRoute = { model: named };
    const route = (parsed: { raeto?: { model?: unknown; cost_usd?: unknown } }) => {
      const r = parsed.raeto;
      if (!this.reportsRoute || !r || typeof r.model !== "string" || !r.model) return;
      this.lastRoute = { model: r.model, ...(typeof r.cost_usd === "number" ? { costUsd: r.cost_usd } : {}) };
    };

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          buffer += decoder.decode();
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]") return;
          try {
            const parsed = JSON.parse(data) as { choices: { delta: { content?: string } }[]; raeto?: { model?: unknown; cost_usd?: unknown } };
            route(parsed);
            const chunk = parsed.choices?.[0]?.delta?.content;
            if (chunk) yield chunk;
          } catch {
            // skip malformed SSE lines
          }
        }
      }

      const finalLine = buffer.trimEnd();
      if (finalLine.startsWith("data: ")) {
        const data = finalLine.slice(6).trim();
        if (data !== "[DONE]") {
          try {
            const parsed = JSON.parse(data) as { choices: { delta: { content?: string } }[]; raeto?: { model?: unknown; cost_usd?: unknown } };
            route(parsed);
            const chunk = parsed.choices?.[0]?.delta?.content;
            if (chunk) yield chunk;
          } catch {
            // skip malformed SSE lines
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}

// ── Router ────────────────────────────────────────────────────────────────────

export function getProvider(agent: Agent): ProviderClient {
  const { provider, providerModel, providerEndpoint } = agent;

  switch (provider) {
    case "anthropic":
      return new AnthropicProvider(providerModel);

    case "ollama": {
      if (!providerEndpoint) {
        throw new Error("providerEndpoint is required for ollama agents and must be a public HTTP(S) endpoint");
      }
      const base = providerEndpoint.replace(/\/$/, "");
      const model = providerModel ?? DEFAULT_OLLAMA_MODEL;
      return new OpenAICompatibleProvider(`${base}/v1`, "", model);
    }

    case "openai": {
      if (providerEndpoint) {
        throw new Error("Custom providerEndpoint is not supported for openai agents");
      }
      const apiKey = process.env.OPENAI_API_KEY ?? "";
      if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
      const base = "https://api.openai.com/v1";
      const model = providerModel ?? DEFAULT_OPENAI_MODEL;
      return new OpenAICompatibleProvider(base, apiKey, model);
    }

    case "grok": {
      // xAI (Grok) — OpenAI-compatible REST at api.x.ai, server-side XAI_API_KEY.
      if (providerEndpoint) {
        throw new Error("Custom providerEndpoint is not supported for grok agents");
      }
      const apiKey = process.env.XAI_API_KEY ?? "";
      if (!apiKey) throw new Error("XAI_API_KEY is not set");
      const base = "https://api.x.ai/v1";
      const model = providerModel ?? DEFAULT_GROK_MODEL;
      return new OpenAICompatibleProvider(base, apiKey, model);
    }

    case "nock": {
      // NockAI's Nock Coder through Surplus: OpenAI-compatible REST, server-side SURPLUS_API_KEY. The key stays on
      // the server, so no custom endpoint can be given (it would receive the key).
      if (providerEndpoint) {
        throw new Error("Custom providerEndpoint is not supported for nock agents");
      }
      const apiKey = process.env.SURPLUS_API_KEY ?? "";
      if (!apiKey) throw new Error("SURPLUS_API_KEY is not set");
      return new OpenAICompatibleProvider(SURPLUS_BASE_URL, apiKey, providerModel ?? DEFAULT_NOCK_MODEL);
    }

    case "raeto": {
      // Raeto: OpenAI-compatible REST, server-side RAETO_API_KEY. The key stays on the server, so no custom endpoint
      // can be given (it would receive the key).
      if (providerEndpoint) {
        throw new Error("Custom providerEndpoint is not supported for raeto agents");
      }
      if (!raetoEnabled()) throw new Error("Raeto is switched off on Axon right now (RAETO=off)");
      const apiKey = process.env.RAETO_API_KEY ?? "";
      if (!apiKey) throw new Error("RAETO_API_KEY is not set");
      return new OpenAICompatibleProvider(RAETO_BASE_URL, apiKey, providerModel ?? DEFAULT_RAETO_MODEL, true);
    }

    default:
      throw new Error(`Unknown inference provider: "${provider}"`);
  }
}

// ── Main entry point ──────────────────────────────────────────────────────────
// Called by the worker and stream endpoint instead of hardcoding Anthropic.

export async function runWithProvider(
  agent: Agent,
  message: string,
  maxTokens = 2048,
  // Optional model override for anthropic agents — lets the network-activity cron run
  // on a cheaper model to keep spend low while staying fully real (measured tokens, real
  // output, reproducible). Real hires pass no override and keep the agent's configured
  // model. Ignored for non-anthropic providers (e.g. grok).
  modelOverride?: string,
  // PDFs and pictures handed over with the hire, for a provider that takes them.
  attachments?: ModelAttachment[],
): Promise<string> {
  const client =
    modelOverride && agent.provider === "anthropic"
      ? getProvider({ ...agent, providerModel: modelOverride })
      : getProvider(agent);
  return client.complete(getAgentSystem(agent), await withKnowledge(agent.agentId, message), maxTokens, undefined, attachments?.length ? attachments : undefined);
}

// Same as runWithProvider, but the agent gets to use its granted tools first:
// search the live web, fetch a page, call an MCP tool, then answer. Providers
// without tool support fall back to a single call, so a grant on (say) an Ollama
// agent degrades to today's behaviour instead of failing the task.
export async function runWithProviderTools(
  agent: Agent,
  message: string,
  maxTokens: number,
  tools: ResolvedTools,
  opts: ToolRunOptions = {},
): Promise<string> {
  const client = getProvider(agent);
  const system = getAgentSystem(agent);
  message = await withKnowledge(agent.agentId, message);
  if (!client.completeWithTools) {
    logger.warn("provider.tools_unsupported", "Provider has no tool support, running without tools", {
      agentId: agent.agentId,
      provider: agent.provider,
      grants: tools.grants,
    });
    return client.complete(system, message, maxTokens, undefined, opts.attachments);
  }
  try {
    return await client.completeWithTools(system, message, maxTokens, tools, opts);
  } catch (err) {
    // The request itself was rejected — an agent pinned to a model that doesn't
    // offer server tools, or an MCP server publishing a schema the API won't
    // accept. Answer the job without tools rather than failing a paid task over
    // a misconfiguration; the receipt records only the calls that really ran.
    if (isBadRequest(err)) {
      logger.warn("provider.tools_rejected", "Tool request rejected, answering without tools", {
        agentId: agent.agentId,
        model: agent.providerModel ?? null,
        grants: tools.grants,
        reason: err instanceof Error ? err.message : String(err),
      });
      return client.complete(system, message, maxTokens, undefined, opts.attachments);
    }
    throw err;
  }
}

// The model that WOULD run for this agent, resolving defaults the same way the
// providers do — so a reproducibility proof can record the concrete model it ran,
// never a misleading null. `pinned` (the model read from the original trace) wins.
export function effectiveModel(agent: Agent, pinned?: string | null): string | null {
  if (pinned) return pinned;
  if (agent.providerModel) return agent.providerModel;
  // No pinned/configured model — resolve the same default the provider would use,
  // so the proof records the concrete model that actually ran, never null.
  switch (agent.provider) {
    case "ollama":
      return DEFAULT_OLLAMA_MODEL;
    case "openai":
      return DEFAULT_OPENAI_MODEL;
    case "grok":
      return DEFAULT_GROK_MODEL;
    case "nock":
      return DEFAULT_NOCK_MODEL;
    case "raeto":
      return DEFAULT_RAETO_MODEL;
    case "anthropic":
      return DEFAULT_ANTHROPIC_MODEL;
    default:
      return null;
  }
}

// A deterministic re-run for reproducibility proofs: pins the exact model that
// originally ran (so a post-refusal fallback is reproduced faithfully) and drives
// temperature 0. Everything else — system prompt, token ceiling, continuation
// stitching — matches a normal run. See src/lib/reproducibility.ts.
/** A Claude model on its own, for Axon's own work rather than an agent's: Agent Studio's writer and grader. */
export const claudeModel = (model: string): ProviderClient => new AnthropicProvider(model);

export async function runReproduction(
  agent: Agent,
  message: string,
  maxTokens: number,
  opts: { model?: string; temperature?: number } = {},
): Promise<string> {
  const model = opts.model ?? agent.providerModel;
  // Pin the model for every provider — not just Anthropic — so the re-run uses the
  // same model the proof claims, even for openai/ollama agents.
  const provider =
    agent.provider === "anthropic" ? new AnthropicProvider(model) : getProvider({ ...agent, providerModel: model });
  // the same knowledge as the original run: a reproduction re-runs what the agent was given, its knowledge included
  return provider.complete(getAgentSystem(agent), await withKnowledge(agent.agentId, message), maxTokens, opts.temperature);
}
