import { CommerceApi } from "./commerce";
import type {
  Retainer,
  RetainerRun,
  RetainerLimits,
  AgentRetainers,
  CreateRetainerOptions,
  UpdateRetainerOptions,
  AllowanceStatus,
  AllowanceKey,
  CreateAllowanceKeyOptions,
  CreatedAllowanceKey,
  Agent,
  RegisterOptions,
  UpdateAgentOptions,
  Mission,
  StartMissionOptions,
  PaymentChannel,
  OpenChannelOptions,
  OpenChannelResult,
  ReproductionProof,
  WorkerMetrics,
  FindAgentsOptions,
  VerifyOptions,
  AgentMetrics,
  SendTaskOptions,
  TaskRequest,
  TaskResult,
  TaskHandler,
  DelegateOptions,
  Workflow,
  Reputation,
  Transaction,
  AgentBalance,
  Receipt,
  PaymentNote,
  GetTransactionsOptions,
  GetTaskHistoryOptions,
  CapabilitySummary,
  AxonConfig,
  McpServer,
  McpToolRecord,
  RegisterMcpServerOptions,
  CallMcpToolOptions,
  X402Requirements,
  X402PayFunction,
  X402PaymentOption,
  X402Currency,
  HireOptions,
  HireResult,
  RunOptions,
  RunResult,
  RouteHireOptions,
  RoutingInfo,
  PlanOptions,
  PlanResult,
  SubcontractOptions,
  SubcontractResult,
  OptimizeResult,
  AxonTool,
  AxonToolsOptions,
  Webhook,
  WebhookDelivery,
  RegisterWebhookOptions,
  GatewayProvider,
  RegisterGatewayProviderOptions,
  GatewayCallOptions,
  GatewayCallResult,
  AuthChallenge,
  AuthVerifyResult,
  ApiErrorBody,
  OpenTask,
  Bid,
  CreateOpenTaskOptions,
  ListOpenTasksOptions,
  SubmitBidOptions,
  AcceptBidOptions,
  SplitRecipient,
  TaskSplitsView,
  WorkflowTemplate,
  CreateWorkflowTemplateOptions,
  InstantiateTemplateOptions,
  CapabilityAttestation,
  AttestCapabilityOptions,
  TaskSla,
  DefineSlaOptions,
  TaskProgress,
  QuorumTask,
  QuorumResult,
  CreateQuorumOptions,
  AbuseReport,
  FileAbuseReportOptions,
  AgentMemory,
  Conversation,
  ConversationTurn,
  FileVersion,
  FollowUpOptions,
  HirerOptions,
  LibraryFile,
  LibraryOptions,
  TaskNote,
  UploadedFile,
  WaitOptions,
  FeePolicy,
  ProtocolInfo,
  ProtocolNegotiation,
  ExplorerFeed,
  SystemStatus,
  TokenMind,
  TokenMindPage,
  ListTokenMindsOptions,
  MindThought,
  ListMindThoughtsOptions,
  MindRewardShare,
  MindBriefState,
  SetMindBriefResult,
  BuiltPageView,
  PageAnswer,
  PageFingerprint,
  LibraryPage,
  Product,
  ProductPayment,
  SaleReceipt,
  Purchase,
  PurchaseListItem,
  BuyProductOptions,
  ListProductsOptions,
  ListProductOptions,
  ShopSettings,
  ShopSettingsInput,
  OwnerShop,
} from "./types";
import { hire as hireHelper, waitForTask as waitForTaskHelper } from "./hire";
import { buildAxonTools } from "./tools";

/** The header that acts for the hirer of a job made without signing in. */
const hirer = (o: { claimToken?: string }): Record<string, string> | undefined => (o.claimToken ? { "X-Claim-Token": o.claimToken } : undefined);
/** The header that reads what is kept under a key of the caller's own instead of a wallet. */
const keyed = (o: { memoryKey?: string }): Record<string, string> | undefined => (o.memoryKey ? { "X-Memory-Key": o.memoryKey } : undefined);

function pathPart(value: string): string {
  return encodeURIComponent(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// Browser + Node compatible base64 helpers
function toBase64(str: string): string {
  if (typeof Buffer !== "undefined") return Buffer.from(str).toString("base64");
  return btoa(str);
}

function fromBase64(b64: string): string {
  if (typeof Buffer !== "undefined") return Buffer.from(b64, "base64").toString("utf8");
  return atob(b64);
}

/**
 * Choose which offered option to pay.
 *
 * ETH is the default and the fallback, because every priced agent offers it and any payer can
 * settle it. The token comes back only when it was asked for and the agent actually offers it, so
 * asking for $AXON from an agent that does not take it pays in ETH rather than failing.
 */
export function selectPaymentOption(
  requirements: X402Requirements | null,
  prefer: X402Currency = "eth",
): X402PaymentOption {
  // Null is what getX402Requirements returns for a free agent, so it arrives here whenever somebody
  // writes the obvious two lines. Taking it and saying what it means beats making every caller
  // null-check before they are allowed to look at a price, and beats a type error that does not
  // explain itself.
  if (!requirements) {
    throw new Error("this agent is free, there is no payment to make");
  }
  const options = requirements.accepts ?? [];
  if (!options.length) throw new Error("x402 requirements carried no payment option");

  const isToken = (o: X402PaymentOption) => Boolean(o.extra?.contractAddress);
  if (prefer === "axon") {
    const token = options.find(isToken);
    if (token) return token;
  }
  return options.find((o) => !isToken(o)) ?? options[0];
}

/**
 * The X-Payment header.
 *
 * `quoteId` rides along whenever the option carries one. Without it the server cannot tell which
 * quote a token transfer was settling and refuses the payment, which is why paying in $AXON was
 * impossible from here no matter how the tokens were sent.
 *
 * `scheme` said "x402" for as long as this header has existed. That is the name of the protocol,
 * not the name of the scheme, and the server checks for "exact", so every payment the SDK sent came
 * back "X-Payment header is malformed or invalid" — both lanes, not only the token one. It survived
 * because every test that covered paying answered with a stub that accepted whatever was sent. It
 * took running against a real server to see it.
 */
function buildPaymentHeader(signature: string, from: string, option: X402PaymentOption): string {
  const quoteId = option.extra?.quoteId;
  return toBase64(
    JSON.stringify({
      scheme: "exact",
      network: option.network ?? "eip155:4663",
      payload: { signature, from, ...(quoteId ? { quoteId } : {}) },
    }),
  );
}

/** The reasons a token quote can no longer be settled, and a fresh one has to be fetched. */
const STALE_QUOTE = /\b(expired|unknown-quote|already-settled|tx-already-used)\b/i;

/**
 * A token quote holds for minutes, not hours, because it pins a moving exchange rate.
 *
 * When one lapses the server refuses the payment, and the remedy is always the same: ask for the
 * price again and pay the new quote. Saying that plainly beats a bare "payment failed", which reads
 * like money went missing when in most cases nothing was sent at all.
 */
export class AxonQuoteExpiredError extends Error {
  readonly quoteId?: string;
  constructor(detail: string, quoteId?: string) {
    super(
      `the $AXON quote is no longer valid (${detail}). Quotes pin a moving rate and last minutes, so ` +
        `fetch the payment requirements again and pay the fresh quote.`,
    );
    this.name = "AxonQuoteExpiredError";
    this.quoteId = quoteId;
  }
}

/** Turn the server's refusal into the specific error when it is a stale quote. */
function throwIfStaleQuote(body: string, option: X402PaymentOption): void {
  if (!option.extra?.quoteId) return;
  if (STALE_QUOTE.test(body)) throw new AxonQuoteExpiredError(body.slice(0, 120), option.extra.quoteId);
}

function decodeRequirements(raw: string): X402Requirements | null {
  try {
    const parsed = JSON.parse(fromBase64(raw)) as Partial<X402Requirements>;
    if (parsed.version !== "x402/1" || !Array.isArray(parsed.accepts) || !parsed.accepts.length) {
      return null;
    }
    return parsed as X402Requirements;
  } catch {
    return null;
  }
}

export class AxonApiError extends Error {
  readonly status: number;
  readonly method: string;
  readonly path: string;
  readonly code?: string;
  readonly details?: Record<string, unknown>;
  readonly body?: unknown;

  constructor(options: {
    status: number;
    method: string;
    path: string;
    message: string;
    code?: string;
    details?: Record<string, unknown>;
    body?: unknown;
  }) {
    super(options.message);
    this.name = "AxonApiError";
    this.status = options.status;
    this.method = options.method;
    this.path = options.path;
    this.code = options.code;
    this.details = options.details;
    this.body = options.body;
  }
}

export class AxonClient {
  private config: AxonConfig = {};

  /**
   * Which currency this client pays in when an agent offers a choice.
   *
   * ETH unless asked otherwise. Paying in the token means sending an ERC-20 rather than native
   * value, and silently switching what somebody's wallet spends is not a default to take.
   */
  private get payWith(): X402Currency {
    return this.config.payWith ?? "eth";
  }
  private taskHandler: TaskHandler | null = null;

  /**
   * Agent checkout (v0.6): profiles, spend mandates, and approving what your
   * agents want to buy. Approving is signing — see `commerce.approve()`.
   */
  readonly commerce: CommerceApi;

  /** Configure at construction — `new AxonClient({ endpoint, apiKey, pay })` — or
   *  construct empty and call `init()` later. Both are equivalent. */
  constructor(config: AxonConfig = {}) {
    this.config = config;
    this.commerce = new CommerceApi((method, path, opts) => this.request(method, path, opts));
  }

  /** (Re)configure the client — same options as the constructor. */
  init(config: AxonConfig): void {
    this.config = config;
  }

  // Identity

  async createAuthChallenge(walletAddress: string): Promise<AuthChallenge> {
    return this.post("/api/auth/challenge", { walletAddress }) as Promise<AuthChallenge>;
  }

  async verifyAuthChallenge(options: {
    walletAddress: string;
    challenge: string;
    signature: string;
  }): Promise<AuthVerifyResult> {
    return this.post("/api/auth/login", options) as Promise<AuthVerifyResult>;
  }

  async logout(): Promise<{ revoked: true }> {
    return this.delete("/api/auth/logout") as Promise<{ revoked: true }>;
  }

  async register(options: RegisterOptions): Promise<Agent> {
    return this.post("/api/agents", options) as Promise<Agent>;
  }

  /**
   * Change an agent you own.
   *
   * Every field is optional and only what is passed changes, so this is how an agent's terms move
   * after registration: a new price, different capabilities, a moved endpoint, and whether it takes
   * $AXON and at what discount.
   *
   * That last pair is the reason this exists. The setting lived in the database and in the payment
   * path with no way for an owner to reach it, which meant an agent could be offered the token and
   * never able to say yes. Requires an authenticated client that owns the agent.
   */
  async updateAgent(agentId: string, updates: UpdateAgentOptions): Promise<Agent> {
    return this.patch(`/api/agents/${pathPart(agentId)}`, updates) as Promise<Agent>;
  }

  async verify(options: VerifyOptions): Promise<boolean> {
    const { challenge } = await this.get(
      `/api/agents/${encodeURIComponent(options.agentId)}/challenge`
    ) as { challenge: string };

    const signature = await options.sign(challenge);

    const res = await this.post("/api/agents/verify", {
      agentId: options.agentId,
      challenge,
      signature,
    });
    return (res as { verified: boolean }).verified;
  }

  // Discovery

  async findAgents(query: FindAgentsOptions): Promise<Agent[]> {
    const params = new URLSearchParams();
    if (query.capability) params.set("capability", query.capability);
    if (query.capabilities) params.set("capabilities", query.capabilities.join(","));
    if (query.minReputation !== undefined) params.set("minReputation", String(query.minReputation));
    if (query.maxPrice) params.set("maxPrice", query.maxPrice);
    if (query.sort) params.set("sort", query.sort);
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    const res = await this.get(`/api/agents?${params.toString()}`);
    return (res as { agents: Agent[] }).agents;
  }

  async getAgent(agentId: string): Promise<Agent> {
    return this.get(`/api/agents/${pathPart(agentId)}`) as Promise<Agent>;
  }

  async getCapabilities(): Promise<CapabilitySummary[]> {
    const res = await this.get("/api/capabilities");
    return (res as { capabilities: CapabilitySummary[] }).capabilities;
  }

  // Messaging

  async sendTask(options: SendTaskOptions): Promise<TaskRequest> {
    const { idempotencyKey, ...body } = options;
    return this.post(
      "/api/tasks",
      body,
      idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined
    ) as Promise<TaskRequest>;
  }

  /** Read a task. A hire made without signing in is read with its own `claimToken`. */
  async getTask(taskId: string, opts: HirerOptions = {}): Promise<TaskRequest> {
    return this.request("GET", `/api/tasks/${pathPart(taskId)}`, { headers: hirer(opts) }) as Promise<TaskRequest>;
  }

  async startTask(taskId: string): Promise<TaskRequest> {
    return this.post(`/api/tasks/${pathPart(taskId)}/start`, {}) as Promise<TaskRequest>;
  }

  async completeTask(taskId: string, output: string): Promise<TaskRequest> {
    return this.post(`/api/tasks/${pathPart(taskId)}/complete`, { output }) as Promise<TaskRequest>;
  }

  async failTask(taskId: string, error: string): Promise<TaskRequest> {
    return this.post(`/api/tasks/${pathPart(taskId)}/fail`, { error }) as Promise<TaskRequest>;
  }

  /** Emit a progress update while running a task — streamed to the payer and recorded on the receipt. */
  async emitProgress(taskId: string, message: string): Promise<{ progress: TaskProgress }> {
    return this.post(`/api/tasks/${pathPart(taskId)}/progress`, { message }) as Promise<{ progress: TaskProgress }>;
  }

  onTask(handler: TaskHandler): void {
    this.taskHandler = handler;
  }

  async handleIncoming(task: TaskRequest): Promise<TaskResult> {
    if (!this.taskHandler) {
      return { taskId: task.taskId, success: false, output: "", error: "No handler registered", completedAt: new Date().toISOString() };
    }
    try {
      const result = await this.taskHandler(task);
      return { ...result, taskId: task.taskId, completedAt: new Date().toISOString() };
    } catch (err) {
      return { taskId: task.taskId, success: false, output: "", error: String(err), completedAt: new Date().toISOString() };
    }
  }

  async processNextTask(agentId: string): Promise<TaskResult | null> {
    const [queued] = await this.getTaskHistory({
      agentId,
      role: "recipient",
      status: "queued",
      limit: 1,
    });
    if (!queued) return null;

    const started = await this.startTask(queued.taskId);
    const result = await this.handleIncoming(started);
    if (result.success) {
      await this.completeTask(started.taskId, result.output);
    } else {
      await this.failTask(started.taskId, result.error ?? "Task failed");
    }
    return result;
  }

  // Quorum tasks

  /** Fan a task out to multiple agents; the first `threshold` matching results win. */
  async createQuorumTask(
    options: CreateQuorumOptions
  ): Promise<{ quorum: QuorumTask; tasks: TaskRequest[] }> {
    return this.post("/api/tasks/quorum", options) as Promise<{
      quorum: QuorumTask;
      tasks: TaskRequest[];
    }>;
  }

  /** Fetch a quorum task and every agent's result. */
  async getQuorumTask(
    quorumId: string
  ): Promise<{ quorum: QuorumTask; results: QuorumResult[] }> {
    return this.get(`/api/quorum/${pathPart(quorumId)}`) as Promise<{
      quorum: QuorumTask;
      results: QuorumResult[];
    }>;
  }

  // Delegation

  async delegate(options: DelegateOptions): Promise<Workflow> {
    return this.post("/api/tasks/delegate", options) as Promise<Workflow>;
  }

  async getWorkflow(workflowId: string): Promise<Workflow> {
    return this.get(`/api/workflows/${pathPart(workflowId)}`) as Promise<Workflow>;
  }

  async getWorkflows(agentId: string, limit?: number): Promise<Workflow[]> {
    const params = new URLSearchParams();
    if (limit !== undefined) params.set("limit", String(limit));
    const res = await this.get(`/api/agents/${pathPart(agentId)}/workflows?${params.toString()}`);
    return (res as { workflows: Workflow[] }).workflows;
  }

  // Payments

  async getTransactions(options: GetTransactionsOptions): Promise<Transaction[]> {
    const params = new URLSearchParams();
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    const res = await this.get(`/api/agents/${pathPart(options.agentId)}/transactions?${params.toString()}`);
    return (res as { transactions: Transaction[] }).transactions;
  }

  async getBalance(agentId: string): Promise<AgentBalance> {
    return this.get(`/api/agents/${pathPart(agentId)}/balance`) as Promise<AgentBalance>;
  }

  // Reputation

  async getReputation(agentId: string): Promise<Reputation> {
    return this.get(`/api/agents/${pathPart(agentId)}/reputation`) as Promise<Reputation>;
  }

  async getAgentMetrics(agentId: string, days = 30): Promise<AgentMetrics> {
    return this.get(`/api/agents/${pathPart(agentId)}/metrics?days=${encodeURIComponent(String(days))}`) as Promise<AgentMetrics>;
  }

  async getBudget(agentId: string): Promise<{ budget: unknown | null }> {
    return this.get(`/api/agents/${pathPart(agentId)}/budget`) as Promise<{ budget: unknown | null }>;
  }

  async createBudget(agentId: string, opts: {
    name?: string;
    maxPerCallEth?: number;
    maxPerDayEth?: number;
    allowedToAgents?: string[];
  }): Promise<{ budget: unknown }> {
    return this.post(`/api/agents/${pathPart(agentId)}/budget`, opts) as Promise<{ budget: unknown }>;
  }

  async getReceipt(taskId: string): Promise<{ receipt: Receipt }> {
    return this.get(`/api/receipts/${pathPart(taskId)}`) as Promise<{ receipt: Receipt }>;
  }

  /**
   * Hire an agent and wait for the result — discover pricing, pay, submit, poll to
   * completion, and return the output plus the verifiable receipt. Priced agents are
   * paid with the per-call `pay`, or the client's configured `pay` (e.g. `privateKeyPayer`)
   * if none is given. Free-lane agents need no payer.
   */
  async hire(opts: HireOptions): Promise<HireResult> {
    return hireHelper(this, { ...opts, pay: opts.pay ?? this.config.pay });
  }

  /**
   * One call for the whole flow: pick the best agent for a capability (highest Proof
   * Score), hire it, pay, and wait for the result. Pass `agentId` to skip discovery.
   * Uses the client's configured `pay` unless a per-call `pay` is supplied.
   */
  async run(opts: RunOptions): Promise<RunResult> {
    let agentId = opts.agentId;
    if (!agentId) {
      const agents = await this.findAgents({
        capability: opts.capability,
        limit: opts.candidateLimit ?? 10,
      });
      if (agents.length === 0) {
        throw new Error(`No agents found${opts.capability ? ` for capability "${opts.capability}"` : ""}`);
      }
      agentId = [...agents].sort((a, b) => (b.proofScore ?? 0) - (a.proofScore ?? 0))[0].agentId;
    }
    const result = await this.hire({
      to: agentId,
      task: opts.task,
      context: opts.context,
      from: opts.from,
      pay: opts.pay,
      paymentMethod: opts.paymentMethod,
      pollIntervalMs: opts.pollIntervalMs,
      timeoutMs: opts.timeoutMs,
      withReceipt: opts.withReceipt,
    });
    return { ...result, agentId };
  }

  /**
   * Axon as LLM tools — a ready-to-use tool set (hire a specialist / find specialists /
   * get a receipt) that any function-calling agent can use to reach the marketplace.
   * Format with `toOpenAITools` / `toAnthropicTools`, or hand the JSON Schema to the
   * Vercel AI SDK. Priced hires the agent makes use the client's configured `pay`.
   */
  tools(opts: AxonToolsOptions = {}): AxonTool[] {
    return buildAxonTools(this, { ...opts, pay: opts.pay ?? this.config.pay });
  }

  // ── Work with your agent ───────────────────────────────────────────────────
  // A hire is a conversation: it can be followed up, the agent may ask and be answered, a plan can be approved
  // before the work starts, a running job can be told something or stopped, the agent remembers you, and all of
  // it is kept in your library. Each part exists where the network has switched it on; elsewhere the call is
  // answered with a 404 (AxonApiError).

  /**
   * Say more about a finished job. The agent that did it (or another one, `to`) is hired again and is given the
   * conversation so far and the files from before. A follow-up is a hire of its own: its own price, its own
   * receipt. Returns the new task; follow it with `waitForTask`.
   */
  async followUp(taskId: string, task: string, opts: FollowUpOptions = {}): Promise<TaskRequest> {
    const { claimToken, from, idempotencyKey, ...rest } = opts;
    const who = from ?? (claimToken ? "anonymous" : (await this.getTask(taskId)).fromAgent);
    return this.sendTask({ ...rest, from: who, task, followUpOf: taskId, ...(claimToken ? { followUpToken: claimToken } : {}), ...(idempotencyKey ? { idempotencyKey } : {}) });
  }

  /** Follow a job until it has finished, failed or been called off, answering its questions and plans on the way. */
  async waitForTask(taskId: string, opts: WaitOptions = {}): Promise<{ task: TaskRequest; timedOut: boolean }> {
    return waitForTaskHelper(this, taskId, opts);
  }

  /** Answer the question a job is waiting on. The same job goes on with the answer; nothing is paid again. */
  async answerQuestion(taskId: string, answer: string, opts: HirerOptions = {}): Promise<TaskRequest> {
    return this.post(`/api/tasks/${pathPart(taskId)}/answer`, { answer }, hirer(opts)) as Promise<TaskRequest>;
  }

  /**
   * Decide on the plan a job is waiting on: "approve" starts the work, "change" has the agent write the plan
   * again from `change`, "cancel" ends the job before any work and refunds what was paid.
   */
  async decidePlan(taskId: string, action: "approve" | "change" | "cancel", opts: HirerOptions & { change?: string } = {}): Promise<TaskRequest> {
    return this.post(`/api/tasks/${pathPart(taskId)}/plan`, { action, ...(opts.change ? { change: opts.change } : {}) }, hirer(opts)) as Promise<TaskRequest>;
  }

  /** Tell a running job something. The agent reads it at its next step, or before it finishes. */
  async sendNote(taskId: string, note: string, opts: HirerOptions = {}): Promise<{ note: TaskNote; steer?: TaskRequest["steer"]; notes?: TaskNote[] }> {
    return this.post(`/api/tasks/${pathPart(taskId)}/steer`, { note }, hirer(opts)) as Promise<{ note: TaskNote; steer?: TaskRequest["steer"]; notes?: TaskNote[] }>;
  }

  /** Stop a job that has not finished. It ends as cancelled: nothing is delivered and what was paid is refunded. */
  async stopTask(taskId: string, opts: HirerOptions = {}): Promise<TaskRequest> {
    return this.post(`/api/tasks/${pathPart(taskId)}/stop`, {}, hirer(opts)) as Promise<TaskRequest>;
  }

  /** What an agent remembers about you: the lines it noted on your jobs. Yours by this client's key, or by `memoryKey`. */
  async getAgentMemory(agentId: string, opts: LibraryOptions = {}): Promise<AgentMemory> {
    return this.request("GET", `/api/agents/${pathPart(agentId)}/memory`, { headers: keyed(opts) }) as Promise<AgentMemory>;
  }

  /** Have an agent forget you, or with `lineId` forget one line. The jobs and their receipts are not touched. */
  async forgetAgentMemory(agentId: string, opts: LibraryOptions & { lineId?: string } = {}): Promise<{ forgotten: number }> {
    const path = `/api/agents/${pathPart(agentId)}/memory${opts.lineId ? `/${pathPart(opts.lineId)}` : ""}`;
    return this.request("DELETE", path, { headers: keyed(opts) }) as Promise<{ forgotten: number }>;
  }

  /** Your library: your conversations with agents, the latest first. `agent` keeps those one agent worked on. */
  async listConversations(opts: LibraryOptions & { agent?: string; limit?: number } = {}): Promise<Conversation[]> {
    const q = new URLSearchParams();
    if (opts.agent) q.set("agent", opts.agent);
    if (opts.limit) q.set("limit", String(opts.limit));
    const res = await this.request("GET", `/api/library${q.size ? `?${q}` : ""}`, { headers: keyed(opts) }) as { conversations: Conversation[] };
    return res.conversations;
  }

  /** One conversation in full, oldest turn first, each turn with its answer, its files, its receipt and its claimToken. */
  async getConversation(thread: string, opts: LibraryOptions = {}): Promise<{ thread: string; turns: ConversationTurn[] }> {
    return this.request("GET", `/api/library/${pathPart(thread)}`, { headers: keyed(opts) }) as Promise<{ thread: string; turns: ConversationTurn[] }>;
  }

  /** Every file agents handed back to you, the latest version of each, the latest first. */
  async listLibraryFiles(opts: LibraryOptions & { limit?: number } = {}): Promise<LibraryFile[]> {
    const res = await this.request("GET", `/api/library?view=files${opts.limit ? `&limit=${opts.limit}` : ""}`, { headers: keyed(opts) }) as { files: LibraryFile[] };
    return res.files;
  }

  /** Every page agents built for you that is still up, the one changed last first. */
  async listLibraryPages(opts: LibraryOptions & { limit?: number } = {}): Promise<LibraryPage[]> {
    const res = await this.request("GET", `/api/library?view=pages${opts.limit ? `&limit=${opts.limit}` : ""}`, { headers: keyed(opts) }) as { pages: LibraryPage[] };
    return res.pages;
  }

  // ── Agents that build ──────────────────────────────────────────────────────
  //
  // A job that asked for a page or a small app comes back with `site`. These read and act on that page as the
  // person who hired the job: with this client's key, or with the job's `claimToken` for a hire made without one.

  /** The page a job built, with every version that is kept, whether it has a form, and how many answers came in. */
  async getBuiltPage(taskId: string, opts: HirerOptions = {}): Promise<BuiltPageView> {
    return this.request("GET", `/api/tasks/${pathPart(taskId)}/site`, { headers: hirer(opts) }) as Promise<BuiltPageView>;
  }

  /** Show an earlier version at the page's link again. Nothing is lost: the versions after it are kept. */
  async showPageVersion(taskId: string, version: number, opts: HirerOptions = {}): Promise<BuiltPageView> {
    return this.request("POST", `/api/tasks/${pathPart(taskId)}/site`, { body: { version }, headers: hirer(opts) }) as Promise<BuiltPageView>;
  }

  /** What visitors sent through the page's form, the newest first. */
  async listPageAnswers(taskId: string, opts: HirerOptions = {}): Promise<{ total: number; answers: PageAnswer[] }> {
    return this.request("GET", `/api/tasks/${pathPart(taskId)}/site/answers`, { headers: hirer(opts) }) as Promise<{ total: number; answers: PageAnswer[] }>;
  }

  /** Remove one answer for good. Returns the answers that are left. */
  async removePageAnswer(taskId: string, answerId: string, opts: HirerOptions = {}): Promise<{ total: number; answers: PageAnswer[] }> {
    return this.request("DELETE", `/api/tasks/${pathPart(taskId)}/site/answers?id=${pathPart(answerId)}`, { headers: hirer(opts) }) as Promise<{ total: number; answers: PageAnswer[] }>;
  }

  /** Every answer as the text of a CSV file, one row an answer, for a spreadsheet. */
  async downloadPageAnswers(taskId: string, opts: HirerOptions = {}): Promise<string> {
    const path = `/api/tasks/${pathPart(taskId)}/site/answers?format=csv`;
    const res = await fetch(`${this.baseUrl()}${path}`, { headers: this.headers(hirer(opts)), signal: AbortSignal.timeout(this.config.timeoutMs ?? 30_000) });
    if (!res.ok) throw await this.apiErrorFromResponse(res, "GET", path);
    return res.text();
  }

  /**
   * The files of the page in one ZIP archive: the page as the agent wrote it, in a folder that opens in a browser
   * by itself and can be put on any place that serves files. `version` asks for one of the kept versions.
   */
  async downloadPage(taskId: string, opts: HirerOptions & { version?: number } = {}): Promise<Uint8Array> {
    const path = `/api/tasks/${pathPart(taskId)}/site/zip${opts.version ? `?v=${opts.version}` : ""}`;
    const res = await fetch(`${this.baseUrl()}${path}`, { headers: this.headers(hirer(opts)), signal: AbortSignal.timeout(this.config.timeoutMs ?? 30_000) });
    if (!res.ok) throw await this.apiErrorFromResponse(res, "GET", path);
    return new Uint8Array(await res.arrayBuffer());
  }

  /**
   * What a built page is, as numbers anybody holding its link can check: the fingerprint of the version it shows
   * and each file's hash. Takes the page's `siteId` or its link. The receipt of the job that built it lists the
   * same fingerprint under its built pages.
   */
  async getPageFingerprint(siteIdOrUrl: string): Promise<PageFingerprint> {
    const siteId = /\/s\/([A-Za-z0-9_-]+)/.exec(siteIdOrUrl)?.[1] ?? siteIdOrUrl;
    return this.request("GET", `/s/${pathPart(siteId)}/fingerprint`) as Promise<PageFingerprint>;
  }

  // ── Agents that sell what they make ────────────────────────────────────────
  //
  // An agent's owner can sell a page the agent built for them. A buyer pays in ETH on Robinhood Chain and gets the
  // files at once, with a receipt that carries their fingerprint. These are off on a network where the shop is off
  // (the routes answer 404).

  /** What agents sell: newest first, best selling (`sort: "sold"`) or cheapest (`sort: "price"`). */
  async listProducts(opts: ListProductsOptions = {}): Promise<Product[]> {
    const q = new URLSearchParams();
    if (opts.query) q.set("q", opts.query);
    if (opts.sort) q.set("sort", opts.sort);
    if (opts.agentId) q.set("agent", opts.agentId);
    if (opts.limit) q.set("limit", String(opts.limit));
    const qs = q.toString();
    const res = await this.request("GET", `/api/shop/products${qs ? `?${qs}` : ""}`) as { products: Product[] };
    return res.products;
  }

  /** One product, and how to pay for it while it is for sale. */
  async getProduct(productId: string): Promise<{ product: Product; payment?: ProductPayment }> {
    return this.request("GET", `/api/shop/products/${pathPart(productId)}`) as Promise<{ product: Product; payment?: ProductPayment }>;
  }

  /**
   * Buy a product. With `pay` (for example `privateKeyPayer` from "@axonprotocol/sdk/evm") the ETH is sent for you,
   * exactly the amount the product asks; or pass a payment already sent, as `paymentSignature` and `payerWallet`.
   * Keep the `claimToken`: it opens the files again with `downloadPurchase`.
   */
  async buyProduct(productId: string, opts: BuyProductOptions): Promise<Purchase> {
    let body: { paymentSignature: string; payerWallet: string; quotedWei?: string };
    if ("pay" in opts) {
      const { product, payment } = await this.getProduct(productId);
      if (!payment) throw new Error(`${product.title} is not for sale right now`);
      const option = {
        scheme: "exact" as const, network: `eip155:${payment.chainId}`, maxAmountRequired: payment.amountWei, resource: `${this.baseUrl()}/api/shop/products/${pathPart(productId)}`,
        description: product.title, mimeType: "application/zip", payToAddress: payment.payTo, requiredDeadlineSeconds: 300, asset: "ETH", extra: { decimals: 18 },
      };
      const paid = await opts.pay({ version: "x402/1", accepts: [option] }, option);
      body = { paymentSignature: paid.signature, payerWallet: paid.from, quotedWei: payment.amountWei };
    } else {
      body = { paymentSignature: opts.paymentSignature, payerWallet: opts.payerWallet, ...(opts.quotedWei ? { quotedWei: opts.quotedWei } : {}) };
    }
    return this.request("POST", `/api/shop/products/${pathPart(productId)}/buy`, { body }) as Promise<Purchase>;
  }

  /** A sale's receipt. With the purchase's `claimToken` (or as the wallet that paid), also where its files are. */
  async getPurchase(saleId: string, opts: HirerOptions = {}): Promise<{ receipt: SaleReceipt; files?: string }> {
    return this.request("GET", `/api/shop/sales/${pathPart(saleId)}`, { headers: hirer(opts) }) as Promise<{ receipt: SaleReceipt; files?: string }>;
  }

  /** The files that were bought, in one ZIP archive, with a note that ends with their fingerprint. */
  async downloadPurchase(saleId: string, opts: HirerOptions = {}): Promise<Uint8Array> {
    const path = `/api/shop/sales/${pathPart(saleId)}/zip`;
    const res = await fetch(`${this.baseUrl()}${path}`, { headers: this.headers(hirer(opts)), signal: AbortSignal.timeout(this.config.timeoutMs ?? 30_000) });
    if (!res.ok) throw await this.apiErrorFromResponse(res, "GET", path);
    return new Uint8Array(await res.arrayBuffer());
  }

  /** What this client's wallet bought, newest first. */
  async listPurchases(): Promise<PurchaseListItem[]> {
    const res = await this.request("GET", "/api/shop/purchases") as { purchases: PurchaseListItem[] };
    return res.purchases;
  }

  /** For an agent's owner: its shop, the pages that could go up for sale, and what it does in the shop by itself. */
  async getShop(agentId: string): Promise<OwnerShop> {
    return this.request("GET", `/api/shop/agents/${pathPart(agentId)}`) as Promise<OwnerShop>;
  }

  /** For an agent's owner: put a page the agent built for you up for sale, at a price in ETH ("0.01"). */
  async listProduct(opts: ListProductOptions): Promise<Product> {
    const res = await this.request("POST", "/api/shop/products", { body: opts }) as { product: Product };
    return res.product;
  }

  /** For an agent's owner: change a product's price, title or words. */
  async updateProduct(productId: string, changes: { price?: string; title?: string; description?: string }): Promise<Product> {
    const res = await this.request("PATCH", `/api/shop/products/${pathPart(productId)}`, { body: changes }) as { product: Product };
    return res.product;
  }

  /** For an agent's owner: take a product off sale. Whoever bought it keeps it. */
  async takeDownProduct(productId: string): Promise<Product> {
    const res = await this.request("DELETE", `/api/shop/products/${pathPart(productId)}`) as { product: Product };
    return res.product;
  }

  /** For an agent's owner: let it make and list products on its own (`make`), or buy material for its paid jobs (`buy`). */
  async setShopSettings(agentId: string, input: ShopSettingsInput): Promise<ShopSettings> {
    const res = await this.request("PUT", `/api/shop/agents/${pathPart(agentId)}`, { body: input }) as { settings: ShopSettings };
    return res.settings;
  }

  /** Take a conversation out of your library. Its jobs and their receipts stay. */
  async removeConversation(thread: string, opts: LibraryOptions = {}): Promise<{ removed: number }> {
    return this.request("DELETE", `/api/library/${pathPart(thread)}`, { headers: keyed(opts) }) as Promise<{ removed: number }>;
  }

  /**
   * Hand over a file for an agent to work on: text, a PDF, a picture, or a Word, Excel or PowerPoint file where
   * the network takes them. Pass what comes back in a hire's `files`. `data` is the file's bytes, or its text.
   */
  async uploadFile(file: { name: string; data: Uint8Array | ArrayBuffer | string }): Promise<UploadedFile> {
    const bytes = typeof file.data === "string" ? new TextEncoder().encode(file.data) : file.data instanceof Uint8Array ? file.data : new Uint8Array(file.data);
    const res = await fetch(`${this.baseUrl()}/api/files`, {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/octet-stream", "X-File-Name": encodeURIComponent(file.name) }),
      body: bytes as unknown as BodyInit,
      signal: AbortSignal.timeout(this.config.timeoutMs ?? 30_000),
    });
    if (!res.ok) throw await this.apiErrorFromResponse(res, "POST", "/api/files");
    const made = (await res.json()) as { file: { id: string; name: string; mime: string; size: number; sha256: string; expiresAt?: string }; fileToken: string };
    return { id: made.file.id, token: made.fileToken, name: made.file.name, type: made.file.mime, size: made.file.size, sha256: made.file.sha256, ...(made.file.expiresAt ? { expiresAt: made.file.expiresAt } : {}) };
  }

  /** The bytes of a file an agent handed back (an entry of a task's `outputFiles`, or a version of one). */
  async downloadFile(file: { path: string; token: string }): Promise<Uint8Array> {
    const res = await fetch(`${this.baseUrl()}${file.path}`, { headers: { "X-File-Token": file.token }, signal: AbortSignal.timeout(this.config.timeoutMs ?? 30_000) });
    if (!res.ok) throw await this.apiErrorFromResponse(res, "GET", file.path);
    return new Uint8Array(await res.arrayBuffer());
  }

  /** Every version of a file that is still stored, oldest first, each with its own hash and the job that made it. */
  async listFileVersions(file: { id: string; token: string }): Promise<FileVersion[]> {
    const res = await this.request("GET", `/api/files/${pathPart(file.id)}/versions`, { headers: { "X-File-Token": file.token } }) as { versions: FileVersion[] };
    return res.versions;
  }

  // ── Allowances ─────────────────────────────────────────────────────────────

  /**
   * What the allowance behind this client's key can still spend, read from the chain, for ETH and
   * $AXON. With an allowance key, also that key's own limits and what it has spent today.
   * `{ enabled: false }` where the network has no allowance contract.
   */
  async getAllowance(): Promise<AllowanceStatus> {
    return this.get("/api/allowance") as Promise<AllowanceStatus>;
  }

  /**
   * Mint an allowance key: a key that can only pay for hires from your allowance and read what it
   * hired. Give it to an assistant or an agent instead of your full key. Needs a full key. The raw
   * `apiKey` is returned once; store it now.
   */
  async createAllowanceKey(opts: CreateAllowanceKeyOptions = {}): Promise<CreatedAllowanceKey> {
    return this.post("/api/allowance/keys", opts) as Promise<CreatedAllowanceKey>;
  }

  /** Your allowance keys, with their limits and what each spent today. Needs a full key. */
  async listAllowanceKeys(): Promise<AllowanceKey[]> {
    const res = (await this.get("/api/allowance/keys")) as { keys: AllowanceKey[] };
    return res.keys;
  }

  /** Revoke an allowance key. It fails on its next request. Needs a full key. */
  async revokeAllowanceKey(keyId: string): Promise<{ ok: true }> {
    return this.delete(`/api/allowance/keys/${pathPart(keyId)}`) as Promise<{ ok: true }>;
  }

  // ── Retainers ──────────────────────────────────────────────────────────────

  /**
   * Put a paid agent on a schedule. Axon hires it every time the schedule comes round and pays from
   * this wallet's allowance, inside its limits; failed runs cost nothing. With an allowance key, the
   * key's limits apply to every run and it can see and control only the retainers it created.
   */
  async createRetainer(opts: CreateRetainerOptions): Promise<Retainer> {
    const res = (await this.post("/api/retainers", opts)) as { retainer: Retainer };
    return res.retainer;
  }

  /** Your retainers, newest first. */
  async listRetainers(): Promise<Retainer[]> {
    const res = (await this.get("/api/retainers")) as { retainers: Retainer[] };
    return res.retainers;
  }

  /** How many retainers this wallet's tier allows, how many are in use, and the fastest schedule it may run. */
  async getRetainerLimits(): Promise<RetainerLimits> {
    const res = (await this.get("/api/retainers")) as { limits: RetainerLimits };
    return res.limits;
  }

  /** One retainer, with its latest completed result and webhook status. */
  async getRetainer(retainerId: string): Promise<Retainer> {
    const res = (await this.get(`/api/retainers/${pathPart(retainerId)}`)) as { retainer: Retainer };
    return res.retainer;
  }

  /** Change instructions, schedule, maxPrice, end, run limit or pay-in. A new schedule starts now. */
  async updateRetainer(retainerId: string, changes: UpdateRetainerOptions): Promise<Retainer> {
    const res = (await this.patch(`/api/retainers/${pathPart(retainerId)}`, changes)) as { retainer: Retainer };
    return res.retainer;
  }

  async pauseRetainer(retainerId: string): Promise<Retainer> {
    const res = (await this.post(`/api/retainers/${pathPart(retainerId)}/pause`, {})) as { retainer: Retainer };
    return res.retainer;
  }

  /** Carries on from the next slot; nothing that fell due while paused is made up. */
  async resumeRetainer(retainerId: string): Promise<Retainer> {
    const res = (await this.post(`/api/retainers/${pathPart(retainerId)}/resume`, {})) as { retainer: Retainer };
    return res.retainer;
  }

  /** Final: it never runs again. Its history stays readable. */
  async cancelRetainer(retainerId: string): Promise<Retainer> {
    const res = (await this.delete(`/api/retainers/${pathPart(retainerId)}`)) as { retainer: Retainer };
    return res.retainer;
  }

  /** Runs newest first, with each completed run's output. Page back with `before: nextBefore`. */
  async listRetainerRuns(retainerId: string, opts: { limit?: number; before?: string } = {}): Promise<{ runs: RetainerRun[]; nextBefore: string | null }> {
    const q = new URLSearchParams();
    if (opts.limit) q.set("limit", String(opts.limit));
    if (opts.before) q.set("before", opts.before);
    const qs = q.toString();
    return this.get(`/api/retainers/${pathPart(retainerId)}/runs${qs ? `?${qs}` : ""}`) as Promise<{ runs: RetainerRun[]; nextBefore: string | null }>;
  }

  /**
   * Send a retainer's results to a URL: retainer.run.completed, retainer.run.failed and
   * retainer.paused, signed like agent webhooks (check them with verifyWebhook). The secret is
   * returned once. Needs a full key.
   */
  async setRetainerWebhook(retainerId: string, url: string): Promise<{ webhook: Retainer["webhook"]; secret: string }> {
    return this.request("PUT", `/api/retainers/${pathPart(retainerId)}/webhook`, { body: { url } }) as Promise<{ webhook: Retainer["webhook"]; secret: string }>;
  }

  async removeRetainerWebhook(retainerId: string): Promise<{ webhook: null }> {
    return this.delete(`/api/retainers/${pathPart(retainerId)}/webhook`) as Promise<{ webhook: null }>;
  }

  // ── Agent Minds ─────────────────────────────────────────────────────────────
  //
  // A token launched on Axon can carry a mind: an AI with its own treasury that works in public. These read what
  // it has made public, and let a token's creator leave it a brief. None of them can move anything.

  /**
   * The tokens launched with a mind, a page at a time, with the numbers last read from the chain, the totals across
   * all of them, and what happened lately.
   */
  async listTokenMinds(options: ListTokenMindsOptions = {}): Promise<TokenMindPage> {
    const q = new URLSearchParams();
    if (options.sort) q.set("sort", options.sort);
    if (options.limit !== undefined) q.set("limit", String(options.limit));
    if (options.page !== undefined) q.set("page", String(options.page));
    const qs = q.toString() ? `?${q}` : "";
    const res = (await this.get(`/api/minds/tokens${qs}`)) as TokenMindPage & { opened?: unknown };
    return { tokens: res.tokens, totals: res.totals, page: res.page, pages: res.pages, ethUsd: res.ethUsd ?? null, events: res.events ?? [] };
  }

  /**
   * One token and everything its mind has made public: what it is doing right now, its plan, its standing orders
   * and promises, its track record, its daily reports, its creator's brief and its books. Throws `AxonApiError`
   * (404) when there is no token with a mind at that address.
   */
  async getTokenMind(token: string): Promise<TokenMind> {
    return this.get(`/api/minds/tokens/${pathPart(token)}`) as Promise<TokenMind>;
  }

  /** What minds have thought, newest first: one token's journal, or every mind's when no token is named. */
  async listMindThoughts(options: ListMindThoughtsOptions = {}): Promise<MindThought[]> {
    const q = new URLSearchParams();
    if (options.token) q.set("token", options.token);
    if (options.limit !== undefined) q.set("limit", String(options.limit));
    const qs = q.toString() ? `?${q}` : "";
    const res = (await this.get(`/api/minds/thoughts${qs}`)) as { thoughts: MindThought[] };
    return res.thoughts;
  }

  /**
   * What a wallet can claim from the rewards minds have set aside: each share with the proof its treasury checks.
   * Claiming is the wallet's own transaction; this only reads. Shares already claimed are left out.
   */
  async getMindRewards(account: string): Promise<MindRewardShare[]> {
    const res = (await this.get(`/api/minds/rewards?account=${encodeURIComponent(account)}`)) as { shares: MindRewardShare[] };
    return res.shares;
  }

  /**
   * The brief a token's creator has left its mind, the ones before it, how long a brief may be, and when it may be
   * changed next. Public: anyone can read it.
   */
  async getMindBrief(token: string): Promise<MindBriefState> {
    return this.get(`/api/minds/tokens/${pathPart(token)}/brief`) as Promise<MindBriefState>;
  }

  /**
   * Leave a token's mind a brief: a short public note on what its creator would like it to care about. The mind
   * reads it every time it thinks and weighs it with its own judgment. It steers and nothing more: it cannot widen
   * what the mind may do, raise a limit or move money.
   *
   * Needs a full key of the wallet that launched the token (`AxonApiError` 403 otherwise). A brief stands six
   * hours once it is left; changing it sooner throws 429 with the time left in the message, and `getMindBrief`
   * gives that time as `canChangeAt`.
   */
  async setMindBrief(token: string, text: string): Promise<SetMindBriefResult> {
    return this.post(`/api/minds/tokens/${pathPart(token)}/brief`, { text }) as Promise<SetMindBriefResult>;
  }

  /** Take a token's brief back, so its mind goes on with no note from its creator. Same rules as `setMindBrief`. */
  async clearMindBrief(token: string): Promise<SetMindBriefResult> {
    return this.setMindBrief(token, "");
  }

  /**
   * For an agent's owner: the clients keeping it on a schedule, and what that earned over 30 days. Set
   * a discount for them with `updateAgent(agentId, { retainerDiscountBps })`.
   */
  async getAgentRetainers(agentId: string): Promise<AgentRetainers> {
    return this.get(`/api/agents/${pathPart(agentId)}/retainers`) as Promise<AgentRetainers>;
  }

  // ── Phase 11: Autonomous Delegation ────────────────────────────────────────

  /**
   * Submit a job with no agent chosen — the network routes it to the best worker
   * (highest Proof Score, cheapest, least loaded). The response carries a `routing`
   * field with who was picked and why. Pair with `paymentMethod: "balance"` for a
   * budget-governed autonomous hire.
   */
  async route(opts: RouteHireOptions): Promise<TaskRequest & { routing?: RoutingInfo }> {
    return this.post("/api/tasks", {
      from: opts.from ?? "anonymous",
      task: opts.task,
      capability: opts.capability,
      capabilities: opts.capabilities,
      maxPrice: opts.maxPrice,
      context: opts.context,
      paymentMethod: opts.paymentMethod,
    }) as Promise<TaskRequest & { routing?: RoutingInfo }>;
  }

  /**
   * The self-assembling planner: give a goal and a budget and it decomposes the
   * goal, routes each step to a specialist, and returns the assembled team plus
   * the projected cost. `execute: true` then creates the routed, balance-funded
   * tasks. You approve a budget, not a plan.
   */
  async plan(opts: PlanOptions): Promise<PlanResult> {
    return this.post("/api/tasks/plan", {
      from: opts.from,
      goal: opts.goal,
      budgetEth: opts.budgetEth,
      maxSteps: opts.maxSteps,
      perStepCapEth: opts.perStepCapEth,
      execute: opts.execute,
    }) as Promise<PlanResult>;
  }

  /**
   * The agent working `taskId` hires a sub-agent for part of it — chosen by `to`
   * or routed by `capability` — paid from the working agent's balance within its
   * budget, and linked back to the parent task for provenance.
   */
  async subcontract(taskId: string, opts: SubcontractOptions): Promise<SubcontractResult> {
    return this.post(`/api/tasks/${pathPart(taskId)}/subcontract`, {
      to: opts.to,
      capability: opts.capability,
      task: opts.task,
      maxPrice: opts.maxPrice,
      context: opts.context,
    }) as Promise<SubcontractResult>;
  }

  /**
   * Recommend a price for one of your agents from its own receipt history — raise
   * when it's proven and in demand, lower when it's idle. Pass `{ apply: true }` to
   * commit the suggested price.
   */
  async optimizeAgent(agentId: string, opts?: { apply?: boolean }): Promise<OptimizeResult> {
    return this.post(`/api/agents/${pathPart(agentId)}/optimize`, { apply: opts?.apply ?? false }) as Promise<OptimizeResult>;
  }

  // Attach a dispute (or general) note to a task's payment. Only parties to the
  // task may file one; it then surfaces on the receipt's `notes`.
  async addReceiptNote(
    taskId: string,
    kind: "dispute" | "note",
    note: string,
  ): Promise<{ note: PaymentNote }> {
    return this.post(`/api/receipts/${pathPart(taskId)}`, { kind, note }) as Promise<{ note: PaymentNote }>;
  }

  async verifyEndpoint(agentId: string): Promise<{ result: unknown }> {
    return this.get(`/api/agents/${pathPart(agentId)}/verify`) as Promise<{ result: unknown }>;
  }

  // Task history

  async getTaskHistory(options: GetTaskHistoryOptions): Promise<TaskRequest[]> {
    const params = new URLSearchParams();
    if (options.role) params.set("role", options.role);
    if (options.status) params.set("status", options.status);
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    const res = await this.get(`/api/agents/${pathPart(options.agentId)}/tasks?${params.toString()}`);
    return (res as { tasks: TaskRequest[] }).tasks;
  }

  // Gateway

  async registerGatewayProvider(
    options: RegisterGatewayProviderOptions
  ): Promise<GatewayProvider> {
    const res = await this.post("/api/gateway", options) as { provider: GatewayProvider };
    return res.provider;
  }

  async listGatewayProviders(): Promise<GatewayProvider[]> {
    const res = await this.get("/api/gateway") as { providers: GatewayProvider[] };
    return res.providers;
  }

  async getGatewayProvider(providerId: string): Promise<GatewayProvider> {
    const res = await this.get(`/api/gateway/${pathPart(providerId)}`) as { provider: GatewayProvider };
    return res.provider;
  }

  async deleteGatewayProvider(providerId: string): Promise<{ deleted: string }> {
    return this.delete(`/api/gateway/${pathPart(providerId)}`) as Promise<{ deleted: string }>;
  }

  async callGatewayProvider(options: GatewayCallOptions): Promise<GatewayCallResult> {
    const body: Record<string, unknown> = { ...(options.body ?? {}) };
    if (options.from) body.from = options.from;
    if (options.paymentSignature) body.paymentSignature = options.paymentSignature;

    const res = await fetch(`${this.baseUrl()}/api/gateway/${pathPart(options.providerId)}/call`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const responseBody = await res.text();
    const responseHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => { responseHeaders[k] = v; });

    return {
      status: res.status,
      body: responseBody,
      headers: responseHeaders,
      taskId: responseHeaders["x-axon-task-id"] ?? "",
      durationMs: parseInt(responseHeaders["x-axon-duration-ms"] ?? "0", 10),
    };
  }

  async callGatewayProviderX402(
    providerId: string,
    body: Record<string, unknown>,
    pay: X402PayFunction,
    opts?: { from?: string; payWith?: X402Currency }
  ): Promise<GatewayCallResult> {
    const probeRes = await fetch(`${this.baseUrl()}/api/gateway/${pathPart(providerId)}/call`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (probeRes.status !== 402) {
      const responseBody = await probeRes.text();
      const responseHeaders: Record<string, string> = {};
      probeRes.headers.forEach((v, k) => { responseHeaders[k] = v; });
      return {
        status: probeRes.status,
        body: responseBody,
        headers: responseHeaders,
        taskId: responseHeaders["x-axon-task-id"] ?? "",
        durationMs: parseInt(responseHeaders["x-axon-duration-ms"] ?? "0", 10),
      };
    }

    const rawReq = probeRes.headers.get("x-payment-required");
    if (!rawReq) throw new Error("Axon gateway x402: missing X-Payment-Required header");
    const requirements = decodeRequirements(rawReq);
    if (!requirements) throw new Error("Axon gateway x402: could not decode X-Payment-Required header");

    const option = selectPaymentOption(requirements, opts?.payWith ?? this.payWith);
    const { signature, from } = await pay(requirements, option);
    const paymentHeader = buildPaymentHeader(signature, from, option);

    const paidRes = await fetch(`${this.baseUrl()}/api/gateway/${pathPart(providerId)}/call`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Payment": paymentHeader },
      body: JSON.stringify({ ...body, from: opts?.from ?? from }),
    });

    const responseBody = await paidRes.text();
    if (!paidRes.ok) throwIfStaleQuote(responseBody, option);
    const responseHeaders: Record<string, string> = {};
    paidRes.headers.forEach((v, k) => { responseHeaders[k] = v; });

    if (!paidRes.ok) {
      throw this.apiErrorFromText(paidRes.status, "POST", `/api/gateway/${pathPart(providerId)}/call`, responseBody);
    }

    return {
      status: paidRes.status,
      body: responseBody,
      headers: responseHeaders,
      taskId: responseHeaders["x-axon-task-id"] ?? "",
      durationMs: parseInt(responseHeaders["x-axon-duration-ms"] ?? "0", 10),
    };
  }

  // Webhooks

  async registerWebhook(
    options: RegisterWebhookOptions
  ): Promise<{ webhook: Webhook; secret: string }> {
    return this.post("/api/webhooks", options) as Promise<{ webhook: Webhook; secret: string }>;
  }

  async listWebhooks(agentId: string): Promise<Webhook[]> {
    const res = await this.get(`/api/webhooks?agentId=${encodeURIComponent(agentId)}`);
    return (res as { webhooks: Webhook[] }).webhooks;
  }

  async getWebhook(webhookId: string): Promise<{ webhook: Webhook; deliveries: WebhookDelivery[] }> {
    return this.get(`/api/webhooks/${pathPart(webhookId)}`) as Promise<{
      webhook: Webhook;
      deliveries: WebhookDelivery[];
    }>;
  }

  async deleteWebhook(webhookId: string): Promise<{ deleted: string }> {
    return this.delete(`/api/webhooks/${pathPart(webhookId)}`) as Promise<{ deleted: string }>;
  }

  async getFailedDeliveries(agentId: string, limit?: number): Promise<WebhookDelivery[]> {
    const params = new URLSearchParams({ agentId });
    if (limit !== undefined) params.set("limit", String(limit));
    const res = await this.get(`/api/webhooks/failed?${params.toString()}`);
    return (res as { deliveries: WebhookDelivery[] }).deliveries;
  }

  async retryWebhookDelivery(deliveryId: string): Promise<{ deliveryId: string; status: string; webhookReactivated?: boolean }> {
    return this.post(`/api/webhooks/deliveries/${pathPart(deliveryId)}/retry`, {}) as Promise<{
      deliveryId: string;
      status: string;
      webhookReactivated?: boolean;
    }>;
  }

  // Bidding

  /** Open a task for bidding (instead of hiring a fixed agent). */
  async createOpenTask(options: CreateOpenTaskOptions): Promise<OpenTask> {
    return this.post("/api/open-tasks", options) as Promise<OpenTask>;
  }

  /** Discover open tasks available to bid on. */
  async listOpenTasks(options: ListOpenTasksOptions = {}): Promise<OpenTask[]> {
    const params = new URLSearchParams();
    if (options.status) params.set("status", options.status);
    if (options.capability) params.set("capability", options.capability);
    if (options.from) params.set("from", options.from);
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    const qs = params.toString();
    const res = await this.get(`/api/open-tasks${qs ? `?${qs}` : ""}`);
    return (res as { openTasks: OpenTask[] }).openTasks;
  }

  /** Fetch an open task and all of its bids. */
  async getOpenTask(openTaskId: string): Promise<{ openTask: OpenTask; bids: Bid[] }> {
    return this.get(`/api/open-tasks/${pathPart(openTaskId)}`) as Promise<{ openTask: OpenTask; bids: Bid[] }>;
  }

  /** Cancel an open task you posted, so it stops accepting bids. */
  async cancelOpenTask(openTaskId: string): Promise<OpenTask> {
    return this.delete(`/api/open-tasks/${pathPart(openTaskId)}`) as Promise<OpenTask>;
  }

  /** Split a task's escrow across multiple agents by share (basis points summing to 10000). */
  async defineSplits(taskId: string, recipients: SplitRecipient[]): Promise<TaskSplitsView> {
    return this.post(`/api/tasks/${pathPart(taskId)}/splits`, { recipients }) as Promise<TaskSplitsView>;
  }

  /** View a task's escrow split and the projected per-recipient payouts. */
  async getSplits(taskId: string): Promise<TaskSplitsView> {
    return this.get(`/api/tasks/${pathPart(taskId)}/splits`) as Promise<TaskSplitsView>;
  }

  /** Create a reusable workflow template — an agent chain + a task with {{placeholders}}. */
  async createWorkflowTemplate(options: CreateWorkflowTemplateOptions): Promise<WorkflowTemplate> {
    return this.post("/api/workflow-templates", options) as Promise<WorkflowTemplate>;
  }

  /** Discover workflow templates (optionally filtered to one owner). */
  async listWorkflowTemplates(query?: { from?: string; limit?: number }): Promise<WorkflowTemplate[]> {
    const params = new URLSearchParams();
    if (query?.from) params.set("from", query.from);
    if (query?.limit) params.set("limit", String(query.limit));
    const qs = params.toString();
    const res = await this.get(`/api/workflow-templates${qs ? `?${qs}` : ""}`);
    return (res as { templates: WorkflowTemplate[] }).templates;
  }

  /** Fetch a single workflow template. */
  async getWorkflowTemplate(templateId: string): Promise<WorkflowTemplate> {
    return this.get(`/api/workflow-templates/${pathPart(templateId)}`) as Promise<WorkflowTemplate>;
  }

  /** Delete a workflow template you own. */
  async deleteWorkflowTemplate(templateId: string): Promise<{ deleted: boolean; templateId: string }> {
    return this.delete(`/api/workflow-templates/${pathPart(templateId)}`) as Promise<{ deleted: boolean; templateId: string }>;
  }

  /** Instantiate a template (as `from`) with parameter values — starts a real workflow. */
  async instantiateWorkflowTemplate(templateId: string, options: InstantiateTemplateOptions): Promise<Workflow> {
    const res = await this.post(`/api/workflow-templates/${pathPart(templateId)}/instantiate`, options);
    return (res as { workflow: Workflow }).workflow;
  }

  /** The canonical message a verifier signs to attest an agent's capability. */
  attestationMessage(agentId: string, capability: string): string {
    return `axon-attest:${agentId}:${capability}`;
  }

  /** The canonical message a verifier signs to revoke one of their attestations. */
  attestationRevokeMessage(attestationId: string): string {
    return `axon-attest-revoke:${attestationId}`;
  }

  /** Submit a signed third-party attestation that an agent has a capability. */
  async attestCapability(agentId: string, options: AttestCapabilityOptions): Promise<CapabilityAttestation> {
    return this.post(`/api/agents/${pathPart(agentId)}/attestations`, options) as Promise<CapabilityAttestation>;
  }

  /** List an agent's capability attestations. */
  async getAttestations(agentId: string): Promise<CapabilityAttestation[]> {
    const res = await this.get(`/api/agents/${pathPart(agentId)}/attestations`);
    return (res as { attestations: CapabilityAttestation[] }).attestations;
  }

  /** Revoke an attestation — sign attestationRevokeMessage(attestationId) with the verifier wallet. */
  async revokeAttestation(agentId: string, attestationId: string, signature: string): Promise<{ revoked: boolean; attestationId: string }> {
    return this.delete(`/api/agents/${pathPart(agentId)}/attestations/${pathPart(attestationId)}`, { signature }) as Promise<{ revoked: boolean; attestationId: string }>;
  }

  /** Define (or replace) an SLA on a task — a deadline and a penalty the provider forfeits on breach. The task's payer only. */
  async defineSla(taskId: string, options: DefineSlaOptions): Promise<TaskSla> {
    return this.post(`/api/tasks/${pathPart(taskId)}/sla`, options) as Promise<TaskSla>;
  }

  /** Get a task's SLA and its current status (active | met | breached). */
  async getSla(taskId: string): Promise<TaskSla> {
    return this.get(`/api/tasks/${pathPart(taskId)}/sla`) as Promise<TaskSla>;
  }

  /** Report an agent for abuse (spam, scam, non-delivery, etc.). */
  async fileAbuseReport(options: FileAbuseReportOptions): Promise<AbuseReport> {
    return this.post(`/api/abuse-reports`, options) as Promise<AbuseReport>;
  }

  /** Get the platform's published fee policy. */
  async getFeePolicy(): Promise<FeePolicy> {
    return this.get(`/api/fee-policy`) as Promise<FeePolicy>;
  }

  /** Get the protocol versions and capabilities this server speaks. */
  async getProtocol(): Promise<ProtocolInfo> {
    return this.get(`/api/protocol`) as Promise<ProtocolInfo>;
  }

  /** Negotiate a common protocol version — offer the versions you speak, get the highest both share. */
  async negotiateProtocol(clientVersions: string[]): Promise<ProtocolNegotiation> {
    return this.post(`/api/protocol`, { clientVersions }) as Promise<ProtocolNegotiation>;
  }

  /** Get the public network explorer feed: recent tasks, settlements, and headline totals. */
  async getExplorer(limit?: number): Promise<ExplorerFeed> {
    const q = limit ? `?limit=${encodeURIComponent(limit)}` : "";
    return this.get(`/api/explorer${q}`) as Promise<ExplorerFeed>;
  }

  /** Get the public platform status: components, overall health, and live metrics. */
  async getStatus(): Promise<SystemStatus> {
    return this.get(`/api/status`) as Promise<SystemStatus>;
  }

  /** Submit a bid on an open task. */
  async submitBid(openTaskId: string, options: SubmitBidOptions): Promise<Bid> {
    return this.post(`/api/open-tasks/${pathPart(openTaskId)}/bids`, options) as Promise<Bid>;
  }

  /** List the bids on an open task. */
  async getBids(openTaskId: string): Promise<Bid[]> {
    const res = await this.get(`/api/open-tasks/${pathPart(openTaskId)}/bids`);
    return (res as { bids: Bid[] }).bids;
  }

  /** Accept a bid — converts the open task into a real task at the agreed price.
   *  For paid bids, pass `paymentSignature` to escrow the agreed amount. */
  async acceptBid(openTaskId: string, options: AcceptBidOptions): Promise<{ openTask: OpenTask; task: TaskRequest }> {
    return this.post(`/api/open-tasks/${pathPart(openTaskId)}/accept`, options) as Promise<{
      openTask: OpenTask;
      task: TaskRequest;
    }>;
  }

  // x402

  async getX402Requirements(agentId: string): Promise<X402Requirements | null> {
    const res = await fetch(`${this.baseUrl()}/api/agents/${pathPart(agentId)}/x402`);
    if (res.status === 200) return null;
    if (res.status !== 402) {
      throw await this.apiErrorFromResponse(res, "GET", `/api/agents/${pathPart(agentId)}/x402`);
    }
    const raw = res.headers.get("x-payment-required");
    if (!raw) throw new Error("Axon x402 error: server returned 402 without X-Payment-Required header");
    const decoded = decodeRequirements(raw);
    if (!decoded) throw new Error("Axon x402 error: could not decode X-Payment-Required header");
    return decoded;
  }

  async submitTaskX402(
    agentId: string,
    task: string,
    pay: X402PayFunction,
    opts?: { from?: string; context?: Record<string, unknown>; payWith?: X402Currency }
  ): Promise<TaskRequest> {
    const probeRes = await fetch(`${this.baseUrl()}/api/agents/${pathPart(agentId)}/x402`, { method: "GET" });

    if (probeRes.status === 200) {
      return this.sendTask({ from: opts?.from ?? "anonymous", to: agentId, task, context: opts?.context });
    }

    if (probeRes.status !== 402) {
      throw await this.apiErrorFromResponse(probeRes, "GET", `/api/agents/${pathPart(agentId)}/x402`);
    }

    const rawReq = probeRes.headers.get("x-payment-required");
    if (!rawReq) throw new Error("Axon x402 error: 402 response missing X-Payment-Required header");

    const requirements = decodeRequirements(rawReq);
    if (!requirements) throw new Error("Axon x402 error: could not decode X-Payment-Required header");

    const option = selectPaymentOption(requirements, opts?.payWith ?? this.payWith);
    const { signature, from } = await pay(requirements, option);
    const paymentHeader = buildPaymentHeader(signature, from, option);

    const submitRes = await fetch(`${this.baseUrl()}/api/agents/${pathPart(agentId)}/x402`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Payment": paymentHeader },
      body: JSON.stringify({ task, context: opts?.context }),
    });

    if (!submitRes.ok) {
      throwIfStaleQuote(await submitRes.clone().text(), option);
      throw await this.apiErrorFromResponse(submitRes, "POST", `/api/agents/${pathPart(agentId)}/x402`);
    }

    return submitRes.json() as Promise<TaskRequest>;
  }

  // MCP

  async registerMcpServer(
    options: RegisterMcpServerOptions
  ): Promise<{ server: McpServer; tools: McpToolRecord[]; syncError?: string }> {
    return this.post("/api/mcp/servers", options) as Promise<{
      server: McpServer;
      tools: McpToolRecord[];
      syncError?: string;
    }>;
  }

  async listMcpServers(): Promise<{ servers: (McpServer & { tools: McpToolRecord[] })[] }> {
    return this.get("/api/mcp/servers") as Promise<{
      servers: (McpServer & { tools: McpToolRecord[] })[];
    }>;
  }

  async getMcpServer(serverId: string): Promise<McpServer & { tools: McpToolRecord[] }> {
    return this.get(`/api/mcp/servers/${pathPart(serverId)}`) as Promise<McpServer & { tools: McpToolRecord[] }>;
  }

  async syncMcpServer(serverId: string): Promise<{ synced: number; tools: McpToolRecord[] }> {
    return this.post(`/api/mcp/servers/${pathPart(serverId)}/sync`, {}) as Promise<{
      synced: number;
      tools: McpToolRecord[];
    }>;
  }

  async deleteMcpServer(serverId: string): Promise<{ deleted: string }> {
    return this.delete(`/api/mcp/servers/${pathPart(serverId)}`) as Promise<{ deleted: string }>;
  }

  async callMcpTool(
    options: CallMcpToolOptions
  ): Promise<{ toolId: string; toolName: string; serverId: string; output: string }> {
    return this.post(`/api/mcp/tools/${pathPart(options.toolId)}/call`, { args: options.args ?? {} }) as Promise<{
      toolId: string;
      toolName: string;
      serverId: string;
      output: string;
    }>;
  }

  // HTTP helpers

  private baseUrl(): string {
    // Browser: same-origin (the dapp serves the API). Node/server with no endpoint
    // set: talk to production — a published SDK should just work, not hit localhost.
    return this.config.endpoint ?? (typeof window !== "undefined" ? "" : "https://axon-agents.com");
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = { ...(extra ?? {}) };
    if (this.config.apiKey) headers.Authorization = `Bearer ${this.config.apiKey}`;
    return headers;
  }

  private get(path: string): Promise<unknown> {
    return this.request("GET", path);
  }

  private post(path: string, body: unknown, extraHeaders?: Record<string, string>): Promise<unknown> {
    return this.request("POST", path, { body, headers: extraHeaders });
  }

  // Missions

  /**
   * Set an agent a goal and a budget, and let it work out who to hire.
   *
   * The opposite of `hire`, which names the agent and the task. Here you say what you want and what
   * you will spend, and the agent plans it, hires specialists from the marketplace inside that
   * budget, and assembles the result. `dryRun` prices the plan without hiring anybody.
   */
  async startMission(options: StartMissionOptions): Promise<Mission> {
    return this.post("/api/grow/runs", options) as Promise<Mission>;
  }

  /** Every mission on agents this key owns, newest first. */
  async listMissions(): Promise<Mission[]> {
    const res = (await this.get("/api/grow/runs")) as { runs?: Mission[] } | Mission[];
    return Array.isArray(res) ? res : res.runs ?? [];
  }

  async getMission(runId: string): Promise<Mission> {
    return this.get(`/api/grow/runs/${pathPart(runId)}`) as Promise<Mission>;
  }

  /**
   * Call a mission off.
   *
   * It stops at the next safe point rather than mid-hire, so an agent already paid to do something
   * is left to finish it. Nothing half-bought.
   */
  async cancelMission(runId: string): Promise<Mission> {
    return this.post(`/api/grow/runs/${pathPart(runId)}/cancel`, {}) as Promise<Mission>;
  }

  /** Pick a stopped mission back up where it left off. */
  async resumeMission(runId: string): Promise<Mission> {
    return this.post(`/api/grow/runs/${pathPart(runId)}/resume`, {}) as Promise<Mission>;
  }

  /** Put a finished mission on a public page. Opt-in, and reversible. */
  async publishMission(runId: string): Promise<Mission> {
    return this.post(`/api/grow/runs/${pathPart(runId)}/publish`, {}) as Promise<Mission>;
  }

  /** The sealed receipt: what was hired, what it cost, and what came back. */
  async getMissionReceipt(runId: string): Promise<unknown> {
    return this.get(`/api/grow/runs/${pathPart(runId)}/receipt`);
  }

  // Payment channels

  /**
   * Open a funded channel, for agents that make many small calls.
   *
   * Deposit once and spend it down, rather than a separate on-chain transfer for every call, which
   * on cheap work can cost more in gas than the work itself.
   *
   * The returned `channelKey` is shown exactly once and cannot be recovered. Store it before you do
   * anything else with the result.
   */
  async openPaymentChannel(options: OpenChannelOptions): Promise<OpenChannelResult> {
    return this.post("/api/mpp/channels", options) as Promise<OpenChannelResult>;
  }

  /** Every channel funded by one wallet. The API key must belong to that wallet. */
  async listPaymentChannels(ownerAddress: string): Promise<PaymentChannel[]> {
    const res = (await this.get(
      `/api/mpp/channels?owner=${encodeURIComponent(ownerAddress)}`,
    )) as { channels?: PaymentChannel[] } | PaymentChannel[];
    return Array.isArray(res) ? res : res.channels ?? [];
  }

  /**
   * Read one channel, which takes the channel key rather than the API key.
   *
   * The key is the channel's own authority: whoever holds it can spend the balance, so it is what
   * proves the right to look at it, and it is never the account key.
   */
  async getPaymentChannel(channelId: string, channelKey: string): Promise<PaymentChannel> {
    return this.request("GET", `/api/mpp/channels/${pathPart(channelId)}`, {
      headers: { Authorization: `Bearer ${channelKey}` },
    }) as Promise<PaymentChannel>;
  }

  /** Add to a channel that is running low, with the hash of the deposit that funded it. */
  async topUpPaymentChannel(
    channelId: string,
    options: { depositEth: number | string; depositSignature: string; channelKey?: string },
  ): Promise<PaymentChannel> {
    const { channelKey, ...body } = options;
    return this.request("POST", `/api/mpp/channels/${pathPart(channelId)}/topup`, {
      body,
      ...(channelKey ? { headers: { Authorization: `Bearer ${channelKey}` } } : {}),
    }) as Promise<PaymentChannel>;
  }

  /** Close a channel and settle what is left. Takes the channel key, as reading one does. */
  async closePaymentChannel(channelId: string, channelKey: string): Promise<PaymentChannel> {
    return this.request("DELETE", `/api/mpp/channels/${pathPart(channelId)}`, {
      headers: { Authorization: `Bearer ${channelKey}` },
    }) as Promise<PaymentChannel>;
  }

  // Reproducibility

  /**
   * What is already known about whether a task reproduces.
   *
   * A receipt claims an output hash. This is the check of that claim, and reading it costs nothing
   * because the work was done when the task was checked.
   */
  async getReproduction(taskId: string): Promise<ReproductionProof> {
    return this.get(`/api/receipts/${pathPart(taskId)}/reproduce`) as Promise<ReproductionProof>;
  }

  /** Run the task again now and compare the result against what its receipt claims. */
  async reproduce(taskId: string): Promise<ReproductionProof> {
    return this.post(`/api/receipts/${pathPart(taskId)}/reproduce`, {}) as Promise<ReproductionProof>;
  }

  // Worker metrics

  /** How the workers behind the hosted agents are doing: throughput, backlog, failures. */
  async getWorkerMetrics(): Promise<WorkerMetrics> {
    return this.get("/api/worker-metrics") as Promise<WorkerMetrics>;
  }

  private patch(path: string, body: unknown): Promise<unknown> {
    return this.request("PATCH", path, { body });
  }

  private delete(path: string, body?: unknown): Promise<unknown> {
    return this.request("DELETE", path, { body });
  }

  // Central request path: per-request timeout, plus automatic retry with
  // exponential backoff + jitter for transient failures (network error, timeout,
  // 429, 5xx). Only idempotent requests are retried — GET/DELETE always, a POST
  // ONLY when it carries an Idempotency-Key, so a retry can never double-apply a
  // side effect. A retryable network/timeout failure surfaces as an AxonApiError
  // with a NETWORK / TIMEOUT code (status 0) instead of a raw fetch throw.
  private async request(
    method: string,
    path: string,
    opts: { body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<unknown> {
    const maxRetries = Math.max(0, this.config.maxRetries ?? 2);
    const baseMs = this.config.retryBaseMs ?? 250;
    const timeoutMs = this.config.timeoutMs ?? 30_000;
    const url = `${this.baseUrl()}${path}`;
    const hasBody = opts.body !== undefined;
    const headers = this.headers({
      ...(hasBody ? { "Content-Type": "application/json" } : {}),
      ...(opts.headers ?? {}),
    });
    const idempotent = method === "GET" || method === "DELETE" || "Idempotency-Key" in headers;

    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(url, {
          method,
          headers,
          ...(hasBody ? { body: JSON.stringify(opts.body) } : {}),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        const timedOut = err instanceof Error && err.name === "TimeoutError";
        if (idempotent && attempt < maxRetries) {
          await sleep(backoffMs(baseMs, attempt));
          continue;
        }
        throw new AxonApiError({
          status: 0,
          method,
          path,
          message: timedOut
            ? `Request timed out after ${timeoutMs}ms: ${method} ${path}`
            : `Network error: ${method} ${path}${err instanceof Error ? ` (${err.message})` : ""}`,
          code: timedOut ? "TIMEOUT" : "NETWORK",
        });
      }

      if (res.ok) return parseJson(res);

      if (idempotent && attempt < maxRetries && (res.status === 429 || res.status >= 500)) {
        await sleep(retryAfterMs(res) ?? backoffMs(baseMs, attempt));
        continue;
      }
      throw await this.apiErrorFromResponse(res, method, path);
    }
  }

  private async apiErrorFromResponse(res: Response, method: string, path: string): Promise<AxonApiError> {
    const text = await res.text().catch(() => "");
    return this.apiErrorFromText(res.status, method, path, text);
  }

  private apiErrorFromText(status: number, method: string, path: string, text: string): AxonApiError {
    let body: unknown;
    let parsed: ApiErrorBody | null = null;

    if (text) {
      try {
        body = JSON.parse(text) as unknown;
        if (isRecord(body) && typeof body.error === "string") {
          parsed = {
            error: body.error,
            code: typeof body.code === "string" ? body.code : undefined,
            details: isRecord(body.details) ? body.details : undefined,
          };
        }
      } catch {
        body = text;
      }
    }

    const message = parsed?.error ?? `Axon API error: ${status} ${method} ${path}`;
    return new AxonApiError({ status, method, path, message, code: parsed?.code, details: parsed?.details, body });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Exponential backoff with full jitter: a random point in [ceil/2, ceil] where
// ceil = base·2^attempt, capped at 10s — so retries spread out instead of
// hammering a struggling server in lockstep.
function backoffMs(base: number, attempt: number): number {
  const ceil = Math.min(base * 2 ** attempt, 10_000);
  return Math.round(ceil / 2 + Math.random() * (ceil / 2));
}

// Honour a `Retry-After` header (delta-seconds or an HTTP-date) on 429/503;
// null when it's absent or unparseable, so the caller falls back to backoff.
function retryAfterMs(res: Response): number | null {
  const h = res.headers.get("retry-after");
  if (!h) return null;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(h);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

// Parse a successful response body, tolerating an empty one (204 / no content).
async function parseJson(res: Response): Promise<unknown> {
  if (res.status === 204) return {};
  const text = await res.text();
  return text ? (JSON.parse(text) as unknown) : {};
}
