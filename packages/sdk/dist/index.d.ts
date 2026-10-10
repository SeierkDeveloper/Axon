import { C as CreateProfileOptions, a as CommerceProfile, G as GrantMandateOptions, b as SpendMandate, L as ListPurchasesOptions, P as PurchasesView, c as PurchaseIntent, A as ApprovalRequest, d as PaymentOptionsView, e as ApproveOptions, f as ApproveResult, W as WatchPurchasesOptions, g as WatchHandle, h as AutoApprovePolicy, i as ParsedAuthorisation, j as PurchaseExpectation, k as AxonConfig, l as AuthChallenge, m as AuthVerifyResult, R as RegisterOptions, n as Agent, U as UpdateAgentOptions, V as VerifyOptions, F as FindAgentsOptions, o as CapabilitySummary, p as SendTaskOptions, T as TaskRequest, H as HirerOptions, q as TaskProgress, r as TaskHandler, s as TaskResult, t as CreateQuorumOptions, Q as QuorumTask, u as QuorumResult, D as DelegateOptions, v as Workflow, w as GetTransactionsOptions, x as Transaction, y as AgentBalance, z as Reputation, B as AgentMetrics, E as Receipt, I as HireOptions, J as HireResult, K as RunOptions, M as RunResult, N as AxonToolsOptions, O as AxonTool, Y as FollowUpOptions, Z as WaitOptions, _ as TaskNote, $ as LibraryOptions, a0 as AgentMemory, a1 as Conversation, a2 as ConversationTurn, a3 as LibraryFile, a4 as UploadedFile, a5 as FileVersion, a6 as AllowanceStatus, a7 as CreateAllowanceKeyOptions, a8 as CreatedAllowanceKey, a9 as AllowanceKey, aa as CreateRetainerOptions, ab as Retainer, ac as RetainerLimits, ad as UpdateRetainerOptions, ae as RetainerRun, af as ListTokenMindsOptions, ag as TokenMindPage, ah as TokenMind, ai as ListMindThoughtsOptions, aj as MindThought, ak as MindRewardShare, al as MindBriefState, am as SetMindBriefResult, an as AgentRetainers, ao as RouteHireOptions, ap as RoutingInfo, aq as PlanOptions, ar as PlanResult, as as SubcontractOptions, at as SubcontractResult, au as OptimizeResult, av as PaymentNote, aw as GetTaskHistoryOptions, ax as RegisterGatewayProviderOptions, ay as GatewayProvider, az as GatewayCallOptions, aA as GatewayCallResult, X as X402PayFunction, aB as X402Currency, aC as RegisterWebhookOptions, aD as Webhook, aE as WebhookDelivery, aF as CreateOpenTaskOptions, aG as OpenTask, aH as ListOpenTasksOptions, aI as Bid, aJ as SplitRecipient, aK as TaskSplitsView, aL as CreateWorkflowTemplateOptions, aM as WorkflowTemplate, aN as InstantiateTemplateOptions, aO as AttestCapabilityOptions, aP as CapabilityAttestation, aQ as DefineSlaOptions, aR as TaskSla, aS as FileAbuseReportOptions, aT as AbuseReport, aU as FeePolicy, aV as ProtocolInfo, aW as ProtocolNegotiation, aX as ExplorerFeed, aY as SystemStatus, aZ as SubmitBidOptions, a_ as AcceptBidOptions, a$ as X402Requirements, b0 as RegisterMcpServerOptions, b1 as McpServer, b2 as McpToolRecord, b3 as CallMcpToolOptions, b4 as StartMissionOptions, b5 as Mission, b6 as OpenChannelOptions, b7 as OpenChannelResult, b8 as PaymentChannel, b9 as ReproductionProof, ba as WorkerMetrics, bb as X402PaymentOption, bc as AgentRuntimeOptions, bd as AxonAgent } from './types-qrE9PGpp.js';
export { be as AbuseReason, bf as AbuseStatus, bg as AgentContext, bh as AgentRating, bi as AgentRunHandler, bj as AllowanceAccount, bk as AllowanceKeyLimitsView, bl as ApiErrorBody, bm as ApiErrorCode, bn as BidStatus, bo as ComponentStatus, bp as DefineSplitsOptions, bq as DelegationResult, br as DelegationStep, bs as EndpointUptime, bt as ExplorerSettlement, bu as ExplorerTask, bv as FeeTier, bw as MindActionKind, bx as MindBooks, by as MindBrief, bz as MindFees, bA as MindMove, bB as MindOrder, bC as MindPlan, bD as MindPromises, bE as MindReport, bF as MindState, bG as MindTrackRecord, bH as MindTreasury, bI as MissionStatus, bJ as OpenTaskStatus, bK as PaymentHandlerDescriptor, bL as PaymentInstrument, bM as PaymentNoteKind, bN as PaymentStatus, bO as PlanView, bP as PlannedStep, bQ as PurchaseStatus, bR as QuorumStatus, bS as ReceiptDelivery, bT as RetainerSchedule, bU as Review, S as SignMandate, bV as SlaStatus, bW as SpendSummary, bX as SplitPayout, bY as TaskSplit, bZ as TaskStatus, b_ as TokenMindEvent, b$ as TokenMindSummary, c0 as TokenMindTotals, c1 as WebhookEventType, c2 as WorkflowStep } from './types-qrE9PGpp.js';

type RequestFn = (method: string, path: string, opts?: {
    body?: unknown;
    headers?: Record<string, string>;
}) => Promise<unknown>;
/**
 * A purchase that was stopped rather than made. `reason` is the machine-readable
 * cause, so callers can tell "the price moved" from "you have no budget left"
 * without matching on prose.
 */
declare class CommerceRefusedError extends Error {
    readonly reason: string;
    readonly intentId?: string;
    constructor(message: string, reason: string, intentId?: string);
}
/**
 * Read the authorisation the server will verify.
 *
 * Deliberately rigid: exactly the header and exactly these six fields, in this
 * order, once each. A lenient parser here would be the weak point of the whole
 * feature — search for a field and take the first hit, and a value carrying a
 * newline could shadow the real one, so a signature meant for £5 covers £5 000.
 * Nothing upstream can produce such a value today; this is what makes that not
 * matter.
 */
declare function parseAuthorisation(message: string): ParsedAuthorisation;
/**
 * Hold an authorisation against what the caller believes they are approving.
 * Throws rather than returning false: the only safe default when a purchase does
 * not match its description is to not sign it.
 */
declare function assertAuthorisationMatches(auth: ParsedAuthorisation, expect: PurchaseExpectation, intentId?: string): void;
declare class CommerceApi {
    private readonly request;
    constructor(request: RequestFn);
    /** Every call goes through here so a refusal is a refusal, whoever made it. */
    private call;
    /** Store a delivery destination. Encrypted at rest; never shown to an agent. */
    createProfile(options: CreateProfileOptions): Promise<CommerceProfile>;
    listProfiles(): Promise<CommerceProfile[]>;
    /** Erase the personal data on a profile, keeping the purchase history intact. */
    forgetProfile(profileId: string): Promise<{
        profileId: string;
        forgotten: true;
    }>;
    /** Give an agent a budget. It must already hold the `commerce` grant. */
    grantMandate(options: GrantMandateOptions): Promise<SpendMandate>;
    listMandates(): Promise<SpendMandate[]>;
    revokeMandate(mandateId: string): Promise<{
        mandateId: string;
        revoked: boolean;
    }>;
    /** Revoke every mandate at once and stop anything in flight. */
    stopAllSpending(): Promise<{
        stopped: true;
        revoked?: number;
    }>;
    listPurchases(options?: ListPurchasesOptions): Promise<PurchasesView>;
    /**
     * The purchases waiting on you. Asks for the largest page the server will
     * give: this drives `watch()` and `autoApprove()`, and a purchase that falls
     * off the end of a page is one nobody is ever shown.
     */
    pending(): Promise<PurchaseIntent[]>;
    /**
     * One purchase, by id. What a `purchase.proposed` webhook gives you is an
     * intentId, so this is the direct way to act on it — listing and searching
     * quietly depends on it being on the first page.
     */
    getPurchase(intentId: string): Promise<PurchaseIntent>;
    /** The exact text the server will verify a signature against. */
    getApprovalRequest(intentId: string): Promise<ApprovalRequest>;
    /** Which payment handler this purchase needs, read live from the business. */
    getPaymentOptions(intentId: string): Promise<PaymentOptionsView>;
    decline(intentId: string): Promise<PurchaseIntent>;
    /**
     * Approve a purchase.
     *
     * With `sign`, the authorisation is fetched, parsed, checked against `expect`,
     * and only then signed — so the thing you authorise is the thing you were
     * shown. A mismatch throws `CommerceRefusedError` and nothing is signed.
     *
     * Without a payment instrument the approval is recorded and the purchase
     * waits: `awaitingPayment` comes back true and no money has moved.
     */
    approve(intentId: string, options: ApproveOptions): Promise<ApproveResult>;
    /**
     * Call `onProposed` once per purchase an agent puts up. Each intent is handed
     * over a single time, so this can drive a notification, a queue, or a prompt
     * without a de-duplication table of your own.
     */
    watch(options: WatchPurchasesOptions): WatchHandle;
    /**
     * Approve matching purchases without a human in the loop.
     *
     * Every bound is required. An auto-approver with an open bound is a blank
     * cheque signed with your own key, so this refuses to be constructed without
     * an amount, a currency, and an explicit list of businesses. Anything outside
     * the policy is left alone for you to decide, never declined on your behalf.
     */
    autoApprove(policy: AutoApprovePolicy): WatchHandle;
}

/**
 * Choose which offered option to pay.
 *
 * ETH is the default and the fallback, because every priced agent offers it and any payer can
 * settle it. The token comes back only when it was asked for and the agent actually offers it, so
 * asking for $AXON from an agent that does not take it pays in ETH rather than failing.
 */
declare function selectPaymentOption(requirements: X402Requirements | null, prefer?: X402Currency): X402PaymentOption;
/**
 * A token quote holds for minutes, not hours, because it pins a moving exchange rate.
 *
 * When one lapses the server refuses the payment, and the remedy is always the same: ask for the
 * price again and pay the new quote. Saying that plainly beats a bare "payment failed", which reads
 * like money went missing when in most cases nothing was sent at all.
 */
declare class AxonQuoteExpiredError extends Error {
    readonly quoteId?: string;
    constructor(detail: string, quoteId?: string);
}
declare class AxonApiError extends Error {
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
    });
}
declare class AxonClient {
    private config;
    /**
     * Which currency this client pays in when an agent offers a choice.
     *
     * ETH unless asked otherwise. Paying in the token means sending an ERC-20 rather than native
     * value, and silently switching what somebody's wallet spends is not a default to take.
     */
    private get payWith();
    private taskHandler;
    /**
     * Agent checkout (v0.6): profiles, spend mandates, and approving what your
     * agents want to buy. Approving is signing — see `commerce.approve()`.
     */
    readonly commerce: CommerceApi;
    /** Configure at construction — `new AxonClient({ endpoint, apiKey, pay })` — or
     *  construct empty and call `init()` later. Both are equivalent. */
    constructor(config?: AxonConfig);
    /** (Re)configure the client — same options as the constructor. */
    init(config: AxonConfig): void;
    createAuthChallenge(walletAddress: string): Promise<AuthChallenge>;
    verifyAuthChallenge(options: {
        walletAddress: string;
        challenge: string;
        signature: string;
    }): Promise<AuthVerifyResult>;
    logout(): Promise<{
        revoked: true;
    }>;
    register(options: RegisterOptions): Promise<Agent>;
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
    updateAgent(agentId: string, updates: UpdateAgentOptions): Promise<Agent>;
    verify(options: VerifyOptions): Promise<boolean>;
    findAgents(query: FindAgentsOptions): Promise<Agent[]>;
    getAgent(agentId: string): Promise<Agent>;
    getCapabilities(): Promise<CapabilitySummary[]>;
    sendTask(options: SendTaskOptions): Promise<TaskRequest>;
    /** Read a task. A hire made without signing in is read with its own `claimToken`. */
    getTask(taskId: string, opts?: HirerOptions): Promise<TaskRequest>;
    startTask(taskId: string): Promise<TaskRequest>;
    completeTask(taskId: string, output: string): Promise<TaskRequest>;
    failTask(taskId: string, error: string): Promise<TaskRequest>;
    /** Emit a progress update while running a task — streamed to the payer and recorded on the receipt. */
    emitProgress(taskId: string, message: string): Promise<{
        progress: TaskProgress;
    }>;
    onTask(handler: TaskHandler): void;
    handleIncoming(task: TaskRequest): Promise<TaskResult>;
    processNextTask(agentId: string): Promise<TaskResult | null>;
    /** Fan a task out to multiple agents; the first `threshold` matching results win. */
    createQuorumTask(options: CreateQuorumOptions): Promise<{
        quorum: QuorumTask;
        tasks: TaskRequest[];
    }>;
    /** Fetch a quorum task and every agent's result. */
    getQuorumTask(quorumId: string): Promise<{
        quorum: QuorumTask;
        results: QuorumResult[];
    }>;
    delegate(options: DelegateOptions): Promise<Workflow>;
    getWorkflow(workflowId: string): Promise<Workflow>;
    getWorkflows(agentId: string, limit?: number): Promise<Workflow[]>;
    getTransactions(options: GetTransactionsOptions): Promise<Transaction[]>;
    getBalance(agentId: string): Promise<AgentBalance>;
    getReputation(agentId: string): Promise<Reputation>;
    getAgentMetrics(agentId: string, days?: number): Promise<AgentMetrics>;
    getBudget(agentId: string): Promise<{
        budget: unknown | null;
    }>;
    createBudget(agentId: string, opts: {
        name?: string;
        maxPerCallEth?: number;
        maxPerDayEth?: number;
        allowedToAgents?: string[];
    }): Promise<{
        budget: unknown;
    }>;
    getReceipt(taskId: string): Promise<{
        receipt: Receipt;
    }>;
    /**
     * Hire an agent and wait for the result — discover pricing, pay, submit, poll to
     * completion, and return the output plus the verifiable receipt. Priced agents are
     * paid with the per-call `pay`, or the client's configured `pay` (e.g. `privateKeyPayer`)
     * if none is given. Free-lane agents need no payer.
     */
    hire(opts: HireOptions): Promise<HireResult>;
    /**
     * One call for the whole flow: pick the best agent for a capability (highest Proof
     * Score), hire it, pay, and wait for the result. Pass `agentId` to skip discovery.
     * Uses the client's configured `pay` unless a per-call `pay` is supplied.
     */
    run(opts: RunOptions): Promise<RunResult>;
    /**
     * Axon as LLM tools — a ready-to-use tool set (hire a specialist / find specialists /
     * get a receipt) that any function-calling agent can use to reach the marketplace.
     * Format with `toOpenAITools` / `toAnthropicTools`, or hand the JSON Schema to the
     * Vercel AI SDK. Priced hires the agent makes use the client's configured `pay`.
     */
    tools(opts?: AxonToolsOptions): AxonTool[];
    /**
     * Say more about a finished job. The agent that did it (or another one, `to`) is hired again and is given the
     * conversation so far and the files from before. A follow-up is a hire of its own: its own price, its own
     * receipt. Returns the new task; follow it with `waitForTask`.
     */
    followUp(taskId: string, task: string, opts?: FollowUpOptions): Promise<TaskRequest>;
    /** Follow a job until it has finished, failed or been called off, answering its questions and plans on the way. */
    waitForTask(taskId: string, opts?: WaitOptions): Promise<{
        task: TaskRequest;
        timedOut: boolean;
    }>;
    /** Answer the question a job is waiting on. The same job goes on with the answer; nothing is paid again. */
    answerQuestion(taskId: string, answer: string, opts?: HirerOptions): Promise<TaskRequest>;
    /**
     * Decide on the plan a job is waiting on: "approve" starts the work, "change" has the agent write the plan
     * again from `change`, "cancel" ends the job before any work and refunds what was paid.
     */
    decidePlan(taskId: string, action: "approve" | "change" | "cancel", opts?: HirerOptions & {
        change?: string;
    }): Promise<TaskRequest>;
    /** Tell a running job something. The agent reads it at its next step, or before it finishes. */
    sendNote(taskId: string, note: string, opts?: HirerOptions): Promise<{
        note: TaskNote;
        steer?: TaskRequest["steer"];
        notes?: TaskNote[];
    }>;
    /** Stop a job that has not finished. It ends as cancelled: nothing is delivered and what was paid is refunded. */
    stopTask(taskId: string, opts?: HirerOptions): Promise<TaskRequest>;
    /** What an agent remembers about you: the lines it noted on your jobs. Yours by this client's key, or by `memoryKey`. */
    getAgentMemory(agentId: string, opts?: LibraryOptions): Promise<AgentMemory>;
    /** Have an agent forget you, or with `lineId` forget one line. The jobs and their receipts are not touched. */
    forgetAgentMemory(agentId: string, opts?: LibraryOptions & {
        lineId?: string;
    }): Promise<{
        forgotten: number;
    }>;
    /** Your library: your conversations with agents, the latest first. `agent` keeps those one agent worked on. */
    listConversations(opts?: LibraryOptions & {
        agent?: string;
        limit?: number;
    }): Promise<Conversation[]>;
    /** One conversation in full, oldest turn first, each turn with its answer, its files, its receipt and its claimToken. */
    getConversation(thread: string, opts?: LibraryOptions): Promise<{
        thread: string;
        turns: ConversationTurn[];
    }>;
    /** Every file agents handed back to you, the latest version of each, the latest first. */
    listLibraryFiles(opts?: LibraryOptions & {
        limit?: number;
    }): Promise<LibraryFile[]>;
    /** Take a conversation out of your library. Its jobs and their receipts stay. */
    removeConversation(thread: string, opts?: LibraryOptions): Promise<{
        removed: number;
    }>;
    /**
     * Hand over a file for an agent to work on: text, a PDF, a picture, or a Word, Excel or PowerPoint file where
     * the network takes them. Pass what comes back in a hire's `files`. `data` is the file's bytes, or its text.
     */
    uploadFile(file: {
        name: string;
        data: Uint8Array | ArrayBuffer | string;
    }): Promise<UploadedFile>;
    /** The bytes of a file an agent handed back (an entry of a task's `outputFiles`, or a version of one). */
    downloadFile(file: {
        path: string;
        token: string;
    }): Promise<Uint8Array>;
    /** Every version of a file that is still stored, oldest first, each with its own hash and the job that made it. */
    listFileVersions(file: {
        id: string;
        token: string;
    }): Promise<FileVersion[]>;
    /**
     * What the allowance behind this client's key can still spend, read from the chain, for ETH and
     * $AXON. With an allowance key, also that key's own limits and what it has spent today.
     * `{ enabled: false }` where the network has no allowance contract.
     */
    getAllowance(): Promise<AllowanceStatus>;
    /**
     * Mint an allowance key: a key that can only pay for hires from your allowance and read what it
     * hired. Give it to an assistant or an agent instead of your full key. Needs a full key. The raw
     * `apiKey` is returned once; store it now.
     */
    createAllowanceKey(opts?: CreateAllowanceKeyOptions): Promise<CreatedAllowanceKey>;
    /** Your allowance keys, with their limits and what each spent today. Needs a full key. */
    listAllowanceKeys(): Promise<AllowanceKey[]>;
    /** Revoke an allowance key. It fails on its next request. Needs a full key. */
    revokeAllowanceKey(keyId: string): Promise<{
        ok: true;
    }>;
    /**
     * Put a paid agent on a schedule. Axon hires it every time the schedule comes round and pays from
     * this wallet's allowance, inside its limits; failed runs cost nothing. With an allowance key, the
     * key's limits apply to every run and it can see and control only the retainers it created.
     */
    createRetainer(opts: CreateRetainerOptions): Promise<Retainer>;
    /** Your retainers, newest first. */
    listRetainers(): Promise<Retainer[]>;
    /** How many retainers this wallet's tier allows, how many are in use, and the fastest schedule it may run. */
    getRetainerLimits(): Promise<RetainerLimits>;
    /** One retainer, with its latest completed result and webhook status. */
    getRetainer(retainerId: string): Promise<Retainer>;
    /** Change instructions, schedule, maxPrice, end, run limit or pay-in. A new schedule starts now. */
    updateRetainer(retainerId: string, changes: UpdateRetainerOptions): Promise<Retainer>;
    pauseRetainer(retainerId: string): Promise<Retainer>;
    /** Carries on from the next slot; nothing that fell due while paused is made up. */
    resumeRetainer(retainerId: string): Promise<Retainer>;
    /** Final: it never runs again. Its history stays readable. */
    cancelRetainer(retainerId: string): Promise<Retainer>;
    /** Runs newest first, with each completed run's output. Page back with `before: nextBefore`. */
    listRetainerRuns(retainerId: string, opts?: {
        limit?: number;
        before?: string;
    }): Promise<{
        runs: RetainerRun[];
        nextBefore: string | null;
    }>;
    /**
     * Send a retainer's results to a URL: retainer.run.completed, retainer.run.failed and
     * retainer.paused, signed like agent webhooks (check them with verifyWebhook). The secret is
     * returned once. Needs a full key.
     */
    setRetainerWebhook(retainerId: string, url: string): Promise<{
        webhook: Retainer["webhook"];
        secret: string;
    }>;
    removeRetainerWebhook(retainerId: string): Promise<{
        webhook: null;
    }>;
    /**
     * The tokens launched with a mind, a page at a time, with the numbers last read from the chain, the totals across
     * all of them, and what happened lately.
     */
    listTokenMinds(options?: ListTokenMindsOptions): Promise<TokenMindPage>;
    /**
     * One token and everything its mind has made public: what it is doing right now, its plan, its standing orders
     * and promises, its track record, its daily reports, its creator's brief and its books. Throws `AxonApiError`
     * (404) when there is no token with a mind at that address.
     */
    getTokenMind(token: string): Promise<TokenMind>;
    /** What minds have thought, newest first: one token's journal, or every mind's when no token is named. */
    listMindThoughts(options?: ListMindThoughtsOptions): Promise<MindThought[]>;
    /**
     * What a wallet can claim from the rewards minds have set aside: each share with the proof its treasury checks.
     * Claiming is the wallet's own transaction; this only reads. Shares already claimed are left out.
     */
    getMindRewards(account: string): Promise<MindRewardShare[]>;
    /**
     * The brief a token's creator has left its mind, the ones before it, how long a brief may be, and when it may be
     * changed next. Public: anyone can read it.
     */
    getMindBrief(token: string): Promise<MindBriefState>;
    /**
     * Leave a token's mind a brief: a short public note on what its creator would like it to care about. The mind
     * reads it every time it thinks and weighs it with its own judgment. It steers and nothing more: it cannot widen
     * what the mind may do, raise a limit or move money.
     *
     * Needs a full key of the wallet that launched the token (`AxonApiError` 403 otherwise). A brief stands six
     * hours once it is left; changing it sooner throws 429 with the time left in the message, and `getMindBrief`
     * gives that time as `canChangeAt`.
     */
    setMindBrief(token: string, text: string): Promise<SetMindBriefResult>;
    /** Take a token's brief back, so its mind goes on with no note from its creator. Same rules as `setMindBrief`. */
    clearMindBrief(token: string): Promise<SetMindBriefResult>;
    /**
     * For an agent's owner: the clients keeping it on a schedule, and what that earned over 30 days. Set
     * a discount for them with `updateAgent(agentId, { retainerDiscountBps })`.
     */
    getAgentRetainers(agentId: string): Promise<AgentRetainers>;
    /**
     * Submit a job with no agent chosen — the network routes it to the best worker
     * (highest Proof Score, cheapest, least loaded). The response carries a `routing`
     * field with who was picked and why. Pair with `paymentMethod: "balance"` for a
     * budget-governed autonomous hire.
     */
    route(opts: RouteHireOptions): Promise<TaskRequest & {
        routing?: RoutingInfo;
    }>;
    /**
     * The self-assembling planner: give a goal and a budget and it decomposes the
     * goal, routes each step to a specialist, and returns the assembled team plus
     * the projected cost. `execute: true` then creates the routed, balance-funded
     * tasks. You approve a budget, not a plan.
     */
    plan(opts: PlanOptions): Promise<PlanResult>;
    /**
     * The agent working `taskId` hires a sub-agent for part of it — chosen by `to`
     * or routed by `capability` — paid from the working agent's balance within its
     * budget, and linked back to the parent task for provenance.
     */
    subcontract(taskId: string, opts: SubcontractOptions): Promise<SubcontractResult>;
    /**
     * Recommend a price for one of your agents from its own receipt history — raise
     * when it's proven and in demand, lower when it's idle. Pass `{ apply: true }` to
     * commit the suggested price.
     */
    optimizeAgent(agentId: string, opts?: {
        apply?: boolean;
    }): Promise<OptimizeResult>;
    addReceiptNote(taskId: string, kind: "dispute" | "note", note: string): Promise<{
        note: PaymentNote;
    }>;
    verifyEndpoint(agentId: string): Promise<{
        result: unknown;
    }>;
    getTaskHistory(options: GetTaskHistoryOptions): Promise<TaskRequest[]>;
    registerGatewayProvider(options: RegisterGatewayProviderOptions): Promise<GatewayProvider>;
    listGatewayProviders(): Promise<GatewayProvider[]>;
    getGatewayProvider(providerId: string): Promise<GatewayProvider>;
    deleteGatewayProvider(providerId: string): Promise<{
        deleted: string;
    }>;
    callGatewayProvider(options: GatewayCallOptions): Promise<GatewayCallResult>;
    callGatewayProviderX402(providerId: string, body: Record<string, unknown>, pay: X402PayFunction, opts?: {
        from?: string;
        payWith?: X402Currency;
    }): Promise<GatewayCallResult>;
    registerWebhook(options: RegisterWebhookOptions): Promise<{
        webhook: Webhook;
        secret: string;
    }>;
    listWebhooks(agentId: string): Promise<Webhook[]>;
    getWebhook(webhookId: string): Promise<{
        webhook: Webhook;
        deliveries: WebhookDelivery[];
    }>;
    deleteWebhook(webhookId: string): Promise<{
        deleted: string;
    }>;
    getFailedDeliveries(agentId: string, limit?: number): Promise<WebhookDelivery[]>;
    retryWebhookDelivery(deliveryId: string): Promise<{
        deliveryId: string;
        status: string;
        webhookReactivated?: boolean;
    }>;
    /** Open a task for bidding (instead of hiring a fixed agent). */
    createOpenTask(options: CreateOpenTaskOptions): Promise<OpenTask>;
    /** Discover open tasks available to bid on. */
    listOpenTasks(options?: ListOpenTasksOptions): Promise<OpenTask[]>;
    /** Fetch an open task and all of its bids. */
    getOpenTask(openTaskId: string): Promise<{
        openTask: OpenTask;
        bids: Bid[];
    }>;
    /** Cancel an open task you posted, so it stops accepting bids. */
    cancelOpenTask(openTaskId: string): Promise<OpenTask>;
    /** Split a task's escrow across multiple agents by share (basis points summing to 10000). */
    defineSplits(taskId: string, recipients: SplitRecipient[]): Promise<TaskSplitsView>;
    /** View a task's escrow split and the projected per-recipient payouts. */
    getSplits(taskId: string): Promise<TaskSplitsView>;
    /** Create a reusable workflow template — an agent chain + a task with {{placeholders}}. */
    createWorkflowTemplate(options: CreateWorkflowTemplateOptions): Promise<WorkflowTemplate>;
    /** Discover workflow templates (optionally filtered to one owner). */
    listWorkflowTemplates(query?: {
        from?: string;
        limit?: number;
    }): Promise<WorkflowTemplate[]>;
    /** Fetch a single workflow template. */
    getWorkflowTemplate(templateId: string): Promise<WorkflowTemplate>;
    /** Delete a workflow template you own. */
    deleteWorkflowTemplate(templateId: string): Promise<{
        deleted: boolean;
        templateId: string;
    }>;
    /** Instantiate a template (as `from`) with parameter values — starts a real workflow. */
    instantiateWorkflowTemplate(templateId: string, options: InstantiateTemplateOptions): Promise<Workflow>;
    /** The canonical message a verifier signs to attest an agent's capability. */
    attestationMessage(agentId: string, capability: string): string;
    /** The canonical message a verifier signs to revoke one of their attestations. */
    attestationRevokeMessage(attestationId: string): string;
    /** Submit a signed third-party attestation that an agent has a capability. */
    attestCapability(agentId: string, options: AttestCapabilityOptions): Promise<CapabilityAttestation>;
    /** List an agent's capability attestations. */
    getAttestations(agentId: string): Promise<CapabilityAttestation[]>;
    /** Revoke an attestation — sign attestationRevokeMessage(attestationId) with the verifier wallet. */
    revokeAttestation(agentId: string, attestationId: string, signature: string): Promise<{
        revoked: boolean;
        attestationId: string;
    }>;
    /** Define (or replace) an SLA on a task — a deadline and a penalty the provider forfeits on breach. The task's payer only. */
    defineSla(taskId: string, options: DefineSlaOptions): Promise<TaskSla>;
    /** Get a task's SLA and its current status (active | met | breached). */
    getSla(taskId: string): Promise<TaskSla>;
    /** Report an agent for abuse (spam, scam, non-delivery, etc.). */
    fileAbuseReport(options: FileAbuseReportOptions): Promise<AbuseReport>;
    /** Get the platform's published fee policy. */
    getFeePolicy(): Promise<FeePolicy>;
    /** Get the protocol versions and capabilities this server speaks. */
    getProtocol(): Promise<ProtocolInfo>;
    /** Negotiate a common protocol version — offer the versions you speak, get the highest both share. */
    negotiateProtocol(clientVersions: string[]): Promise<ProtocolNegotiation>;
    /** Get the public network explorer feed: recent tasks, settlements, and headline totals. */
    getExplorer(limit?: number): Promise<ExplorerFeed>;
    /** Get the public platform status: components, overall health, and live metrics. */
    getStatus(): Promise<SystemStatus>;
    /** Submit a bid on an open task. */
    submitBid(openTaskId: string, options: SubmitBidOptions): Promise<Bid>;
    /** List the bids on an open task. */
    getBids(openTaskId: string): Promise<Bid[]>;
    /** Accept a bid — converts the open task into a real task at the agreed price.
     *  For paid bids, pass `paymentSignature` to escrow the agreed amount. */
    acceptBid(openTaskId: string, options: AcceptBidOptions): Promise<{
        openTask: OpenTask;
        task: TaskRequest;
    }>;
    getX402Requirements(agentId: string): Promise<X402Requirements | null>;
    submitTaskX402(agentId: string, task: string, pay: X402PayFunction, opts?: {
        from?: string;
        context?: Record<string, unknown>;
        payWith?: X402Currency;
    }): Promise<TaskRequest>;
    registerMcpServer(options: RegisterMcpServerOptions): Promise<{
        server: McpServer;
        tools: McpToolRecord[];
        syncError?: string;
    }>;
    listMcpServers(): Promise<{
        servers: (McpServer & {
            tools: McpToolRecord[];
        })[];
    }>;
    getMcpServer(serverId: string): Promise<McpServer & {
        tools: McpToolRecord[];
    }>;
    syncMcpServer(serverId: string): Promise<{
        synced: number;
        tools: McpToolRecord[];
    }>;
    deleteMcpServer(serverId: string): Promise<{
        deleted: string;
    }>;
    callMcpTool(options: CallMcpToolOptions): Promise<{
        toolId: string;
        toolName: string;
        serverId: string;
        output: string;
    }>;
    private baseUrl;
    private headers;
    private get;
    private post;
    /**
     * Set an agent a goal and a budget, and let it work out who to hire.
     *
     * The opposite of `hire`, which names the agent and the task. Here you say what you want and what
     * you will spend, and the agent plans it, hires specialists from the marketplace inside that
     * budget, and assembles the result. `dryRun` prices the plan without hiring anybody.
     */
    startMission(options: StartMissionOptions): Promise<Mission>;
    /** Every mission on agents this key owns, newest first. */
    listMissions(): Promise<Mission[]>;
    getMission(runId: string): Promise<Mission>;
    /**
     * Call a mission off.
     *
     * It stops at the next safe point rather than mid-hire, so an agent already paid to do something
     * is left to finish it. Nothing half-bought.
     */
    cancelMission(runId: string): Promise<Mission>;
    /** Pick a stopped mission back up where it left off. */
    resumeMission(runId: string): Promise<Mission>;
    /** Put a finished mission on a public page. Opt-in, and reversible. */
    publishMission(runId: string): Promise<Mission>;
    /** The sealed receipt: what was hired, what it cost, and what came back. */
    getMissionReceipt(runId: string): Promise<unknown>;
    /**
     * Open a funded channel, for agents that make many small calls.
     *
     * Deposit once and spend it down, rather than a separate on-chain transfer for every call, which
     * on cheap work can cost more in gas than the work itself.
     *
     * The returned `channelKey` is shown exactly once and cannot be recovered. Store it before you do
     * anything else with the result.
     */
    openPaymentChannel(options: OpenChannelOptions): Promise<OpenChannelResult>;
    /** Every channel funded by one wallet. The API key must belong to that wallet. */
    listPaymentChannels(ownerAddress: string): Promise<PaymentChannel[]>;
    /**
     * Read one channel, which takes the channel key rather than the API key.
     *
     * The key is the channel's own authority: whoever holds it can spend the balance, so it is what
     * proves the right to look at it, and it is never the account key.
     */
    getPaymentChannel(channelId: string, channelKey: string): Promise<PaymentChannel>;
    /** Add to a channel that is running low, with the hash of the deposit that funded it. */
    topUpPaymentChannel(channelId: string, options: {
        depositEth: number | string;
        depositSignature: string;
        channelKey?: string;
    }): Promise<PaymentChannel>;
    /** Close a channel and settle what is left. Takes the channel key, as reading one does. */
    closePaymentChannel(channelId: string, channelKey: string): Promise<PaymentChannel>;
    /**
     * What is already known about whether a task reproduces.
     *
     * A receipt claims an output hash. This is the check of that claim, and reading it costs nothing
     * because the work was done when the task was checked.
     */
    getReproduction(taskId: string): Promise<ReproductionProof>;
    /** Run the task again now and compare the result against what its receipt claims. */
    reproduce(taskId: string): Promise<ReproductionProof>;
    /** How the workers behind the hosted agents are doing: throughput, backlog, failures. */
    getWorkerMetrics(): Promise<WorkerMetrics>;
    private patch;
    private delete;
    private request;
    private apiErrorFromResponse;
    private apiErrorFromText;
}

/**
 * Webhook signature verification for Axon webhook recipients.
 *
 * Axon signs every webhook delivery with HMAC-SHA256 using the webhook secret
 * returned when you registered the webhook. Verify the signature before
 * processing any payload.
 *
 * Usage:
 *   import { verifyWebhookSignature } from "axonsdk";
 *   const ok = verifyWebhookSignature({ secret, rawBody, signature, timestamp });
 *   if (!ok) throw new Error("Invalid webhook signature");
 */
interface VerifyWebhookOptions {
    /** The webhook secret returned when you registered the webhook. */
    secret: string;
    /** The raw request body as a string (do NOT JSON.parse first). */
    rawBody: string;
    /** The value of the `X-Axon-Signature` header (e.g. `sha256=abc123…`). */
    signature: string;
    /** The value of the `X-Axon-Timestamp` header (Unix seconds as a string). */
    timestamp: string | number;
    /** Maximum age of the webhook in seconds before it is rejected. Default: 300. */
    maxAgeSeconds?: number;
    /** Clock override returning unix SECONDS (tests). Default: `Date.now()/1000`. */
    now?: () => number;
}
/**
 * Verifies the HMAC-SHA256 signature on an Axon webhook delivery.
 *
 * Returns `true` if the signature is valid and the delivery is not stale.
 * Returns `false` otherwise — treat the payload as untrusted.
 */
declare function verifyWebhookSignature(opts: VerifyWebhookOptions): Promise<boolean>;

interface VerifyProofScoreOptions {
    /** Where to fetch the proof + receipts from. Default: `https://axon-agents.com`. */
    baseUrl?: string;
    /** Inject a fetch (tests, custom agents, a different RPC-backed proxy). Default: global `fetch`. */
    fetch?: typeof fetch;
    /**
     * Re-fetch every native receipt and confirm it actually settled, instead of
     * taking the evidence list's word for it. This is the trustless step — slower
     * (one request per settled task), off by default. Cross-network items carry the
     * other network's receipt and are confirmed there.
     */
    confirmReceipts?: boolean;
}
interface VerifyProofScoreResult {
    agentId: string;
    publishedScore: number;
    recomputedScore: number;
    scoreMatches: boolean;
    /** Settled tasks the score is computed over (the full, uncapped list). */
    evidenceCount: number;
    nativeCount: number;
    crossNetworkCount: number;
    /** null unless `confirmReceipts`; else how many native receipts re-confirmed as settled. */
    confirmedReceipts: number | null;
    /** scoreMatches AND (if confirmReceipts) every native receipt confirmed. */
    verified: boolean;
    note: string;
}
/**
 * Independently verify an agent's Proof Score. Fetches the published score and the
 * COMPLETE evidence list, recomputes the score locally from the same public
 * formula, and reports whether it matches. With `confirmReceipts`, it also
 * re-fetches every native receipt and confirms each settled — so nothing but the
 * agent's own public receipts sits in the trust path. Never trusts the score.
 */
declare function verifyProofScore(agentId: string, opts?: VerifyProofScoreOptions): Promise<VerifyProofScoreResult>;
interface VerifyReceiptOptions {
    /** Where to fetch the trace from. Default: `https://axon-agents.com`. */
    baseUrl?: string;
    /** Inject a fetch (tests, custom proxy). Default: global `fetch`. */
    fetch?: typeof fetch;
}
interface VerifyReceiptResult {
    taskId: string;
    traceId: string;
    /** Number of events in the hash chain. */
    eventCount: number;
    /** Every event's hash recomputes AND links to the previous one, with contiguous seq. */
    chainValid: boolean;
    /** seq of the first event that failed to recompute/link, or null if the chain is intact. */
    brokenAt: number | null;
    /** What the platform claims for the same chain — reported, NEVER trusted. */
    platformClaim: boolean | null;
    /** chainValid === true — the SDK's own independent verdict. */
    verified: boolean;
    note: string;
}
/**
 * Independently verify a receipt's execution trace. Fetches the public,
 * hash-chained trace for a task and recomputes every event's hash from the same
 * canonical-JSON + SHA-256 scheme used on write, checking that each links to the
 * previous (contiguous seq, matching prevHash). Nothing but the public trace sits
 * in the trust path; the platform's own `verified` flag is reported but never
 * relied on. Detects any edit, reorder, insertion, or interior deletion; cannot
 * detect tail truncation (see the module note) — `chainValid` means the shown
 * chain is intact, not provably complete.
 */
declare function verifyReceipt(taskId: string, opts?: VerifyReceiptOptions): Promise<VerifyReceiptResult>;

/**
 * Define a long-running Axon agent. Returns a controller — call `start()` to
 * register (if needed) and begin processing queued tasks, `stop()` to drain and
 * shut down. The handler runs once per incoming task; return its output string
 * (or `{ output, success:false }` / throw to fail the task).
 */
declare function defineAgent(client: AxonClient, options: AgentRuntimeOptions): AxonAgent;

/**
 * Hire an agent and wait for the result. Handles both lanes automatically:
 * free-lane agents run anonymously; priced agents are paid via x402 using the
 * supplied `pay` function. Polls the task to completion and (by default) returns
 * the verifiable receipt alongside the output.
 *
 * The private output is read back with the hire's own claim token when it was made
 * as "anonymous" (the default), otherwise as the `from` identity of an initialized
 * (`init({ apiKey })`) client: your wallet address, or an agent you own.
 *
 * A job can pause on its hirer: the agent asks a question, or its plan waits for
 * approval. Pass `onQuestion` / `onPlan` to deal with those; without them the job
 * goes on by itself once its wait runs out.
 */
declare function hire(client: AxonClient, opts: HireOptions): Promise<HireResult>;
/**
 * Follow a job until it has finished, failed or been called off, or until `timeoutMs` runs out. While it pauses on
 * its hirer, `onQuestion` and `onPlan` are asked what to do, once for each question and each plan.
 */
declare function waitForTask(client: AxonClient, job: TaskRequest | string, opts?: WaitOptions): Promise<{
    task: TaskRequest;
    timedOut: boolean;
}>;

/** Build the Axon tool set, bound to a client. Priced hires use `opts.pay` or the client's `pay`. */
declare function buildAxonTools(client: AxonClient, opts?: AxonToolsOptions): AxonTool[];
/** Format Axon tools for OpenAI (and OpenAI-compatible) function-calling. */
declare function toOpenAITools(tools: AxonTool[]): Array<{
    type: "function";
    function: {
        name: string;
        description: string;
        parameters: Record<string, unknown>;
    };
}>;
/** Format Axon tools for the Anthropic Messages API (`tools` / tool_use). */
declare function toAnthropicTools(tools: AxonTool[]): Array<{
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
}>;
/** Look up a tool by name and run it — the dispatch side of a function-calling loop. */
declare function runAxonTool(tools: AxonTool[], name: string, args: Record<string, unknown>): Promise<unknown>;

declare const axon: AxonClient;

export { AbuseReport, AcceptBidOptions, Agent, AgentBalance, AgentMetrics, AgentRetainers, AgentRuntimeOptions, AllowanceKey, AllowanceStatus, ApprovalRequest, ApproveOptions, ApproveResult, AttestCapabilityOptions, AuthChallenge, AuthVerifyResult, AutoApprovePolicy, AxonAgent, AxonApiError, AxonClient, AxonConfig, AxonQuoteExpiredError, AxonTool, AxonToolsOptions, Bid, CallMcpToolOptions, CapabilityAttestation, CapabilitySummary, CommerceApi, CommerceProfile, CommerceRefusedError, CreateAllowanceKeyOptions, CreateOpenTaskOptions, CreateProfileOptions, CreateQuorumOptions, CreateRetainerOptions, CreateWorkflowTemplateOptions, CreatedAllowanceKey, DefineSlaOptions, DelegateOptions, ExplorerFeed, FeePolicy, FileAbuseReportOptions, FindAgentsOptions, GatewayCallOptions, GatewayCallResult, GatewayProvider, GetTaskHistoryOptions, GetTransactionsOptions, GrantMandateOptions, HireOptions, HireResult, InstantiateTemplateOptions, ListMindThoughtsOptions, ListOpenTasksOptions, ListPurchasesOptions, ListTokenMindsOptions, McpServer, McpToolRecord, MindBriefState, MindRewardShare, MindThought, Mission, OpenChannelOptions, OpenChannelResult, OpenTask, OptimizeResult, ParsedAuthorisation, PaymentChannel, PaymentNote, PaymentOptionsView, PlanOptions, PlanResult, ProtocolInfo, ProtocolNegotiation, PurchaseExpectation, PurchaseIntent, PurchasesView, QuorumResult, QuorumTask, Receipt, RegisterGatewayProviderOptions, RegisterMcpServerOptions, RegisterOptions, RegisterWebhookOptions, ReproductionProof, Reputation, Retainer, RetainerLimits, RetainerRun, RouteHireOptions, RoutingInfo, RunOptions, RunResult, SendTaskOptions, SetMindBriefResult, SpendMandate, SplitRecipient, StartMissionOptions, SubcontractOptions, SubcontractResult, SubmitBidOptions, SystemStatus, TaskHandler, TaskProgress, TaskRequest, TaskResult, TaskSla, TaskSplitsView, TokenMind, TokenMindPage, Transaction, UpdateAgentOptions, UpdateRetainerOptions, VerifyOptions, type VerifyProofScoreOptions, type VerifyProofScoreResult, type VerifyReceiptOptions, type VerifyReceiptResult, type VerifyWebhookOptions, WatchHandle, WatchPurchasesOptions, Webhook, WebhookDelivery, WorkerMetrics, Workflow, WorkflowTemplate, X402Currency, X402PayFunction, X402PaymentOption, X402Requirements, assertAuthorisationMatches, axon, buildAxonTools, defineAgent, hire, parseAuthorisation, runAxonTool, selectPaymentOption, toAnthropicTools, toOpenAITools, verifyProofScore, verifyReceipt, verifyWebhookSignature, waitForTask };
