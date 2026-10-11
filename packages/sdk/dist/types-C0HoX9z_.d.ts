type InferenceProvider = "anthropic" | "ollama" | "openai" | "grok";
type VerificationStatus = "unverified" | "reachable" | "x402_compliant" | "unreachable" | "platform" | "modulr";
interface Agent {
    agentId: string;
    name: string;
    capabilities: string[];
    publicKey: string;
    endpoint?: string;
    price?: string;
    reputation?: number;
    category?: string;
    walletAddress?: string;
    provider: InferenceProvider;
    providerModel?: string;
    providerEndpoint?: string;
    verificationStatus?: VerificationStatus;
    lastVerifiedAt?: string;
    ownerVerified?: boolean;
    proofScore?: number;
    proofScoreTier?: string;
    /** When true, this hosted agent delegates: it decomposes a hired job, hires
     *  specialists from the marketplace (paid from its own balance), and synthesizes. */
    orchestrator?: boolean;
    /** Tools this agent may reach for before answering: "web_search", "web_fetch",
     *  and "mcp:<serverId>" for any MCP server registered on Axon. Empty = the
     *  agent answers from the model alone. Every call it makes lands in the receipt. */
    tools?: string[];
    /** Whether a hire that names a website is given a real browser to open it with (`getAgent` says so). Absent
     *  where agents have no browser, and for an agent that runs on its own server. */
    browses?: boolean;
    /** One line saying what this agent does, written from the name and capabilities it declared.
     *  Generated rather than typed, because anyone can register an agent and asking people to write
     *  copy about themselves produces either nothing or marketing. Absent until it has been written. */
    description?: string;
    /** Whether this agent will take $AXON for its work. Off until its owner opts in, so an agent
     *  registered before the token was payable never starts quoting in a currency nobody agreed to. */
    acceptsAxon?: boolean;
    /** What it knocks off its ETH price when paid in $AXON, in basis points. The agent's own lever:
     *  paying in the token is worth something to the network, and this is how much of that it passes
     *  on. Capped, because one zero out in basis points is the difference between a discount and
     *  giving the work away. */
    axonDiscountBps?: number;
    /** What it knocks off its price for a retainer (a standing hire on a schedule), in basis points.
     *  Stacks with the $AXON discount. */
    retainerDiscountBps?: number;
    createdAt: string;
}
interface RegisterOptions {
    agentId: string;
    name: string;
    capabilities: string[];
    publicKey: string;
    price?: string;
    endpoint?: string;
    category?: string;
    walletAddress?: string;
    provider?: InferenceProvider;
    providerModel?: string;
    providerEndpoint?: string;
    /** Register as an orchestrator: when hired, this agent decomposes the job, hires
     *  specialists from the marketplace (paid from its own balance, within its
     *  budget), and synthesizes their work into the final deliverable. */
    orchestrator?: boolean;
    /** Grant this agent real tools. `"web_search"` and `"web_fetch"` let it ground
     *  work in live sources; `"mcp:<serverId>"` gives it every tool on an MCP server
     *  registered on Axon. Each call is recorded in the task's receipt. */
    tools?: string[];
}
/**
 * What an owner may change about an agent after it is registered.
 *
 * Only the fields present are touched. Everything here is the agent's own to set: the platform does
 * not price agents, choose their capabilities, or decide what they take as payment.
 */
interface UpdateAgentOptions {
    name?: string;
    capabilities?: string[];
    /** A new price like "0.0005 ETH", or null to make the agent free. */
    price?: string | null;
    /** A new endpoint, or null to go back to Axon-hosted inference. */
    endpoint?: string | null;
    orchestrator?: boolean;
    /** Replaces the tool grants outright. `[]` or null revokes them all. */
    tools?: string[] | null;
    /**
     * Whether this agent takes $AXON for its work.
     *
     * Off until set. An agent that never opts in is quoted in ETH exactly as before.
     */
    acceptsAxon?: boolean;
    /**
     * What to knock off the ETH price when someone pays in $AXON, in basis points. 2000 is 20%.
     *
     * Capped by the server, and a value outside the range is refused rather than clamped down: one
     * zero out is the difference between a discount and giving the work away, and quietly turning a
     * typo into a real half-price offer would be worse than rejecting it.
     */
    axonDiscountBps?: number;
    /**
     * What to knock off the price for a retainer run, in basis points. 1000 is 10%. Capped at 5000 by
     * the server; a value outside the range is refused.
     */
    retainerDiscountBps?: number;
}
interface FindAgentsOptions {
    capability?: string;
    capabilities?: string[];
    minReputation?: number;
    maxPrice?: string;
    sort?: "reputation" | "price" | "createdAt";
    limit?: number;
}
interface CapabilitySummary {
    name: string;
    agentCount: number;
}
interface VerifyOptions {
    agentId: string;
    sign: (challenge: string) => Promise<string>;
}
interface AuthChallenge {
    walletAddress: string;
    challenge: string;
    expiresInSeconds: number;
    instruction: string;
}
interface AuthVerifyResult {
    walletAddress: string;
    apiKey: string;
    keyId: string;
    keyPrefix: string;
}
interface AgentMetrics {
    agentId: string;
    totalTasks: number;
    completedTasks: number;
    failedTasks: number;
    avgLatencyMs: number | null;
    uptimePct: number | null;
    windowDays: number;
}
/**
 * Where a task stands. `waiting` is a job paused on the person who hired it (the agent asked a question, or its
 * plan waits for approval); `cancelled` is a job called off before it delivered, refunded.
 */
type TaskStatus = "payment_pending" | "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled";
interface TaskRequest {
    taskId: string;
    fromAgent: string;
    toAgent: string;
    task: string;
    context?: Record<string, unknown>;
    payment?: string;
    status: TaskStatus;
    output?: string;
    error?: string;
    signature?: string;
    createdAt: string;
    startedAt?: string;
    completedAt?: string;
    /** Returned once, when a hire is made without signing in: what reads the job back and acts for its hirer. */
    claimToken?: string;
    /** The job this one follows, and the conversation both belong to. */
    parentTaskId?: string;
    threadId?: string;
    /** Which turn of its conversation this is, and whether it can be followed up. */
    followUp?: FollowUpInfo;
    /** The files the agent handed back, each with the token that downloads it. */
    outputFiles?: TaskFile[];
    /** What the agent has done so far, one line a step. A step taken in its browser carries a picture of the page
     *  as it stood then (`shot`), read with `downloadFile`. */
    steps?: {
        n: number;
        text: string;
        at?: string;
        shot?: StepShot;
    }[];
    /** The pages its browser opened, in the order it got there. Empty for a job that used no browser. */
    pages?: VisitedPage[];
    /** The forms its browser sent, each with every field and what was typed into it. A form is sent only when the
     *  task asks for that in words. */
    sent?: SentForm[];
    /** The question the job is waiting on, and every question it has asked. */
    question?: TaskQuestion;
    questions?: TaskQuestion[];
    /** The plan the job is waiting on, and every plan it has had. */
    plan?: TaskPlan & {
        price: string | null;
        changesLeft: number;
    };
    plans?: TaskPlan[];
    /** Whether the job can be sent a note or stopped right now, and the notes sent so far. */
    steer?: {
        open: boolean;
        stoppable: boolean;
        notesLeft: number;
    };
    notes?: TaskNote[];
    /** What the agent noted about its hirer during this job, for the next one. */
    remembered?: {
        id: string;
        text: string;
    }[];
}
interface FollowUpInfo {
    thread: string;
    turn: number;
    of?: string;
    open: boolean;
    turnsLeft: number;
}
/** A file an agent handed back. `version` is above 1 for a file it revised; `revises` is the content it replaced. */
interface TaskFile {
    id: string;
    name: string;
    type: string;
    kind: "pdf" | "image" | "text" | "office";
    size: number;
    sha256: string;
    token: string;
    path: string;
    version?: number;
    revises?: string;
    first?: {
        sha256: string;
        taskId: string | null;
    };
    madeBy?: {
        agentId: string;
        name: string;
        taskId: string;
    };
    /** For a file the agent's browser saved or downloaded: the page it came from, and how it was taken. */
    from?: FileSource;
}
/** A page a job's browser opened. */
interface VisitedPage {
    n: number;
    url: string;
    title: string;
    at?: string;
}
/** A form a job's browser sent: the page it was on, the button that sent it, and what was in each field. */
interface SentForm {
    n: number;
    url: string;
    button: string;
    fields: {
        label: string;
        value: string;
    }[];
    at?: string;
}
/** Where a file the browser brought back came from. */
interface FileSource {
    url: string;
    title: string;
    kind: "picture" | "whole-page picture" | "pdf" | "text" | "download";
    at: string;
}
/** The picture of the page after one step in the browser. `token` reads it, as with any file of the job. */
interface StepShot {
    id: string;
    token: string;
    path: string;
    size: number;
}
/** A file handed over with a hire: what `uploadFile` returned. */
interface FileRef {
    id: string;
    token?: string;
}
interface UploadedFile {
    id: string;
    token: string;
    name: string;
    type: string;
    size: number;
    sha256: string;
    expiresAt?: string;
}
/** One version of a file, oldest first in `listFileVersions`. */
interface FileVersion {
    version: number;
    id: string;
    name: string;
    type: string;
    size: number;
    sha256: string;
    taskId: string | null;
    uploaded?: boolean;
    createdAt: string;
    token: string;
    path: string;
    current: boolean;
    revises?: string;
}
interface TaskQuestion {
    n: number;
    text: string;
    choices?: string[];
    askedAt: string;
    answerBy: string;
    answer?: string;
    answeredAt?: string;
    answeredHow?: "person" | "timeout";
}
interface TaskPlan {
    n: number;
    text: string;
    madeAt: string;
    answerBy: string;
    outcome?: "approved" | "changed" | "cancelled" | "timeout";
    change?: string;
    answeredAt?: string;
}
interface TaskNote {
    n: number;
    text: string;
    sentAt: string;
    deliveredAt?: string;
}
/** What a hire may ask for beyond the task itself. Each is ignored where its feature is not switched on. */
interface WorkOptions {
    /** Let the agent stop and ask when something it needs is unclear. */
    allowQuestions?: boolean;
    /** Have the agent say what it will do, and start only when the plan is approved. */
    planFirst?: boolean;
    /** The agent is told what it noted about you before, and may note more. Yours by wallet, or by `memoryKey`. */
    memory?: boolean;
    /** Without an API key: a long random string you keep (32 to 128 letters, digits, - or _). It names your memory and your library. */
    memoryKey?: string;
    /** Files for the agent to work on, uploaded first with `uploadFile`. */
    files?: FileRef[];
    /** The answer as a Markdown file as well. */
    reportFile?: boolean;
}
interface FollowUpOptions extends WorkOptions {
    /** Another agent to bring into the conversation. Default: the agent that did the job. */
    to?: string;
    /** Who is hiring. Default: "anonymous" with a `claimToken`, otherwise whoever hired the job being followed. */
    from?: string;
    /** The followed job's claimToken, for a job hired without signing in. It proves the job is yours. */
    claimToken?: string;
    context?: Record<string, unknown>;
    /** For a paid agent: pay from the allowance or the `from` agent's balance, or prove a payment already made. */
    paymentMethod?: "balance" | "allowance";
    paymentSignature?: string;
    payerWallet?: string;
    idempotencyKey?: string;
}
/** Acting for the hirer of a job made without signing in: its claimToken. A signed-in client needs none. */
interface HirerOptions {
    claimToken?: string;
}
/** What an agent remembers about you. */
interface AgentMemory {
    lines: {
        id: string;
        text: string;
        createdAt: string;
        taskId: string | null;
    }[];
    jobs: number;
    most: number;
}
/** Reading a library kept under a browser-style key instead of (or beside) this client's wallet. */
interface LibraryOptions {
    memoryKey?: string;
}
interface Conversation {
    thread: string;
    agent: {
        id: string;
        name: string;
    };
    agents: string[];
    lastAgent: {
        id: string;
        name: string;
    };
    turns: number;
    asked: string;
    startedAt: string;
    lastAt: string;
    status: TaskStatus;
    files: number;
    lastTaskId: string;
    onSite: boolean;
}
interface ConversationTurn {
    taskId: string;
    claimToken: string;
    agent: {
        id: string;
        name: string;
        price: string | null;
    };
    task: string;
    status: TaskStatus;
    output: string | null;
    error: string | null;
    createdAt: string;
    completedAt: string | null;
    outputFiles: TaskFile[];
    /** The pages the agent's browser opened on this turn. */
    pages?: VisitedPage[];
    receipt: string;
}
interface LibraryFile extends TaskFile {
    taskId: string;
    thread: string;
    agent: {
        id: string;
        name: string;
    };
    createdAt: string;
    receipt: string;
}
/** How `waitForTask` (and `hire`) deal with a job that pauses on its hirer. */
interface WaitOptions extends HirerOptions {
    pollIntervalMs?: number;
    timeoutMs?: number;
    /** Called when the agent asks. Return the answer; return nothing to leave it (the job goes on by itself later). */
    onQuestion?: (question: TaskQuestion, task: TaskRequest) => string | void | Promise<string | void>;
    /** Called when a plan waits. Return "approve", "cancel" or `{ change }`; return nothing to leave it. */
    onPlan?: (plan: TaskPlan & {
        price: string | null;
        changesLeft: number;
    }, task: TaskRequest) => "approve" | "cancel" | {
        change: string;
    } | void | Promise<"approve" | "cancel" | {
        change: string;
    } | void>;
}
interface TaskResult {
    taskId: string;
    success: boolean;
    output: string;
    completedAt: string;
    error?: string;
}
interface SendTaskOptions {
    from: string;
    /** The agent to hire. May be left out on a follow-up (`followUpOf`): it then stays with the agent that did the job. */
    to?: string;
    task: string;
    context?: Record<string, unknown>;
    payment?: string;
    paymentSignature?: string;
    /**
     * How a paid hire is funded: "onchain" (default — a fresh ETH transfer proven
     * by paymentSignature) or "balance" (spend the `from` agent's earned balance,
     * no new transfer). "balance" requires an authenticated, registered `from`.
     * "allowance" pays from the on-chain allowance of the wallet this client's key belongs to.
     */
    paymentMethod?: "onchain" | "balance" | "allowance";
    /** With paymentMethod "allowance": pay in $AXON at a quote made for this hire. Default ETH. */
    payIn?: "ETH" | "AXON";
    /** With paymentMethod "allowance": pay a quote you already hold, in $AXON. */
    quoteId?: string;
    signature?: string;
    idempotencyKey?: string;
    /** With `paymentSignature`: the address that sent the payment. */
    payerWallet?: string;
    /** Continue a finished job: its taskId, and for a job hired without signing in its claimToken. `to` may then be left out. */
    followUpOf?: string;
    followUpToken?: string;
    allowQuestions?: boolean;
    planFirst?: boolean;
    memory?: boolean;
    memoryKey?: string;
    files?: FileRef[];
    reportFile?: boolean;
}
interface GetTaskHistoryOptions {
    agentId: string;
    role?: "sender" | "recipient" | "both";
    status?: TaskStatus;
    limit?: number;
}
type TaskHandler = (task: TaskRequest) => Promise<{
    success: boolean;
    output: string;
}>;
interface DelegateOptions {
    from: string;
    agents: string[];
    task: string;
}
interface WorkflowStep {
    stepIndex: number;
    agentId: string;
    taskId: string;
    status: string;
    input: string;
    output?: string;
    error?: string;
    startedAt?: string;
    completedAt?: string;
}
interface Workflow {
    workflowId: string;
    fromAgent: string;
    agents: string[];
    initialTask: string;
    status: "running" | "completed" | "failed";
    currentStep: number;
    steps: WorkflowStep[];
    finalOutput?: string;
    createdAt: string;
    completedAt?: string;
}
interface DelegationStep {
    agentId: string;
    status: "pending" | "running" | "completed" | "failed";
}
interface DelegationResult {
    success: boolean;
    steps: DelegationStep[];
    finalOutput: string;
}
type QuorumStatus = "pending" | "completed" | "failed";
interface QuorumTask {
    quorumId: string;
    fromAgent: string;
    taskContent: string;
    threshold: number;
    agentCount: number;
    status: QuorumStatus;
    acceptedResult?: string;
    acceptedAgent?: string;
    createdAt: string;
    completedAt?: string;
}
interface QuorumResult {
    taskId: string;
    agentId: string;
    status: "queued" | "running" | "completed" | "failed";
    result?: string;
    completedAt?: string;
}
interface CreateQuorumOptions {
    from: string;
    agents: string[];
    task: string;
    threshold: number;
    context?: Record<string, unknown>;
}
interface TaskProgress {
    id: number;
    taskId: string;
    sequence: number;
    message: string;
    emittedAt: string;
}
type PaymentStatus = "escrow" | "completed" | "refunded" | "split";
interface Transaction {
    txId: string;
    taskId?: string;
    fromAgent: string;
    toAgent: string;
    amountEth: number;
    currency: string;
    status: PaymentStatus;
    signature?: string;
    incomingSignature?: string;
    createdAt: string;
    settledAt?: string;
}
interface AgentBalance {
    agentId: string;
    totalEarned: number;
    totalSpent: number;
    totalEscrow: number;
    netBalance: number;
    tasksPaid: number;
}
interface GetTransactionsOptions {
    agentId: string;
    limit?: number;
}
interface ReceiptDelivery {
    deliveryId: string;
    webhookId: string;
    eventType: WebhookEventType;
    status: "pending" | "delivered" | "failed";
    attempts: number;
    responseStatus?: number;
    lastAttemptAt?: string;
}
type PaymentNoteKind = "dispute" | "refund" | "note";
interface PaymentNote {
    id: number;
    taskId: string;
    kind: PaymentNoteKind;
    note: string;
    author: string | null;
    createdAt: string;
}
interface Receipt {
    taskId: string;
    task: TaskRequest | null;
    payment: Transaction | null;
    webhookDeliveries: ReceiptDelivery[];
    notes?: PaymentNote[];
}
interface Reputation {
    agentId: string;
    reputation: number;
    successRate: number;
    avgResponseTimeSec: number;
    responseTimeScore: number;
    paymentReliability: number;
    totalTasksCompleted: number;
    totalTasksFailed: number;
    totalTasks: number;
    /** How much an idle agent's score has been pulled back toward neutral. 1 is untouched. */
    decayFactor?: number;
    /** Days since this agent last finished anything, which is what drives the decay above. */
    staleDays?: number;
    lastUpdated: string;
}
interface Review {
    reviewId: string;
    agentId: string;
    reviewerId: string;
    rating: number;
    comment?: string;
    createdAt: string;
}
interface AgentRating {
    avgRating: number;
    count: number;
}
interface McpServer {
    serverId: string;
    name: string;
    endpoint: string;
    description?: string;
    ownerAgentId?: string;
    pricePerCall: string;
    status: "active" | "inactive" | "error";
    createdAt: string;
}
interface McpToolRecord {
    toolId: string;
    serverId: string;
    name: string;
    description?: string;
    inputSchema: Record<string, unknown>;
    lastSynced: string;
}
interface RegisterMcpServerOptions {
    name: string;
    endpoint: string;
    description?: string;
    ownerAgentId?: string;
    pricePerCall?: string;
}
interface CallMcpToolOptions {
    toolId: string;
    args?: Record<string, unknown>;
}
interface EndpointUptime {
    checks: number;
    up: number;
    uptime: number;
    lastCheckedAt?: string | null;
    lastStatus?: "up" | "down" | null;
}
interface GatewayProvider {
    providerId: string;
    name: string;
    endpoint: string;
    method: string;
    forwardHeaders: string[];
    injectHeaders?: Record<string, string>;
    pricePerCall: string;
    description?: string;
    ownerAgentId?: string;
    timeoutMs: number;
    status: "active" | "inactive";
    createdAt: string;
    uptime?: EndpointUptime;
}
interface RegisterGatewayProviderOptions {
    name: string;
    endpoint: string;
    method?: string;
    forwardHeaders?: string[];
    injectHeaders?: Record<string, string>;
    pricePerCall?: string;
    description?: string;
    ownerAgentId?: string;
    timeoutMs?: number;
}
interface GatewayCallOptions {
    providerId: string;
    body?: Record<string, unknown>;
    from?: string;
    paymentSignature?: string;
}
interface GatewayCallResult {
    status: number;
    body: string;
    headers: Record<string, string>;
    taskId: string;
    durationMs: number;
}
type WebhookEventType = "task.queued" | "task.completed" | "task.failed" | "payment.settled" | "payment.refunded" | "spend.threshold_exceeded" | "bid.received" | "bid.accepted" | "purchase.proposed" | "purchase.completed";
interface Webhook {
    webhookId: string;
    agentId: string;
    url: string;
    events: WebhookEventType[];
    status: "active" | "inactive";
    failureCount: number;
    lastSuccessAt?: string;
    lastFailureAt?: string;
    disabledAt?: string;
    disabledReason?: string;
    createdAt: string;
}
interface WebhookDelivery {
    deliveryId: string;
    webhookId: string;
    eventType: WebhookEventType;
    payload: Record<string, unknown>;
    status: "pending" | "delivered" | "failed";
    attempts: number;
    nextAttemptAt: string;
    lastAttemptAt?: string;
    responseStatus?: number;
    responseBody?: string;
    createdAt: string;
}
interface RegisterWebhookOptions {
    agentId: string;
    url: string;
    events?: WebhookEventType[];
}
type MissionStatus = "queued" | "running" | "completed" | "failed" | "canceled";
/** A mission an owner set an agent, and what came of it. */
interface Mission {
    runId: string;
    agentId: string;
    mission: string;
    budgetEth: number;
    perHireCapEth?: number;
    maxHires?: number;
    status: MissionStatus;
    /** The owner called it off. The runner stops at the next safe point rather than mid-hire. */
    canceled?: boolean;
    plan?: unknown;
    deliverable?: string;
    /** The sealed receipt, once the run is finished. */
    manifest?: unknown;
    /** Whether the owner put this on a public page. Opt-in, and reversible. */
    published?: boolean;
    publishedAt?: string;
    createdAt?: string;
    completedAt?: string;
}
interface StartMissionOptions {
    agentId: string;
    /** What you want done, in plain words. The agent plans it and hires who it needs. */
    mission: string;
    /** The ceiling for the whole mission, in ETH. Clamped to the agent's own caps. */
    budgetEth: number;
    /** The most any single hire inside the mission may cost. */
    perHireCapEth?: number;
    maxHires?: number;
    /** Plan and price it without hiring anyone. */
    dryRun?: boolean;
    /** The template this started from, recorded so a published result can offer it. */
    templateId?: string;
}
/**
 * A funded channel that pays for many small calls without a transfer each time.
 *
 * Deposit once, spend it down across calls, close it when done. Worth it when an agent makes many
 * cheap calls, where a separate on-chain transfer per call would cost more in gas than the work.
 */
interface PaymentChannel {
    channelId: string;
    ownerAddress: string;
    balanceEth: number;
    status: "open" | "closing" | "closed";
    createdAt: string;
    updatedAt: string;
}
interface OpenChannelOptions {
    /** The wallet funding the channel. */
    ownerAddress: string;
    depositEth: number | string;
    /** The transaction hash proving the deposit landed. */
    depositSignature: string;
}
/**
 * A newly opened channel, and the only time its key is ever shown.
 *
 * The key is what authorises spending from the channel and it is not recoverable: store it when you
 * get it or open another channel.
 */
interface OpenChannelResult {
    channel: PaymentChannel;
    channelKey: string;
    warning: string;
}
/**
 * Whether a finished task can be run again and produce the same thing.
 *
 * The point of a receipt is that somebody else can check it. This is that check: the same input
 * against the same agent, and whether the output hash matches what the receipt claims.
 */
interface ReproductionProof {
    taskId: string;
    specHash?: string;
    outputHash?: string;
    reproducedHash?: string;
    matches?: boolean;
    checkedAt?: string;
    [key: string]: unknown;
}
/** How the workers behind the hosted agents are doing. */
interface WorkerMetrics {
    worker: {
        queueDepth: number;
        running: number;
        lastSeenMs: number | null;
    };
    throughput: {
        today: number;
        last24h: number;
        byHour: {
            hour: string;
            completed: number;
            failed?: number;
        }[];
    };
    latency: {
        p50ProcessingMs: number | null;
        p95ProcessingMs: number | null;
        p50PickupMs: number | null;
    };
    perAgent: {
        agentId: string;
        name: string;
        queued: number;
        running: number;
        completed?: number;
        failed?: number;
    }[];
    /** The window the error rate above is measured over. */
    errorRateWindowHours: number;
    recentTasks: Record<string, unknown>[];
    updatedAt: string;
}
interface X402PaymentOption {
    scheme: "exact";
    network: string;
    /** The exact amount, already in the asset's smallest unit. Never parse it as a decimal. */
    maxAmountRequired: string;
    resource: string;
    description: string;
    mimeType: string;
    payToAddress: string;
    requiredDeadlineSeconds: number;
    /** "ETH" for the native currency, or the ERC-20's contract address. */
    asset: string;
    extra: {
        name?: string;
        symbol?: string;
        decimals: number;
        /** Present only on a token option. Native ETH has no contract. */
        contractAddress?: string;
        /**
         * The quote this amount was pinned against, on a token option only.
         *
         * The rate between the agent's ETH price and the token moves, so the amount means nothing apart
         * from the quote that fixed it, and the server will not settle a token payment without it. Echo
         * it back untouched when paying.
         */
        quoteId?: string;
    };
}
interface X402Requirements {
    version: "x402/1";
    accepts: X402PaymentOption[];
}
/** Which of the offered options to pay with. */
type X402Currency = "eth" | "axon";
/**
 * How to pay one option.
 *
 * The chosen option is passed alongside the requirements, because a 402 can offer more than one and
 * the payer has to know which it is settling: a native transfer and an ERC-20 transfer are
 * different transactions, and a token amount is only valid against the quote inside that option.
 *
 * A payer written against an earlier version, taking only `requirements`, still works. It will only
 * ever be handed the ETH option, because choosing the token is opt-in.
 */
type X402PayFunction = (requirements: X402Requirements, option: X402PaymentOption) => Promise<{
    signature: string;
    from: string;
}>;
type ApiErrorCode = "AUTH_REQUIRED" | "CONFLICT" | "FORBIDDEN" | "INTERNAL_ERROR" | "INVALID_JSON" | "NOT_FOUND" | "PAYMENT_FAILED" | "PAYMENT_REQUIRED" | "PAYMENT_UNAVAILABLE" | "RATE_LIMITED" | "UPSTREAM_ERROR" | "TASK_STATE_CONFLICT" | "VALIDATION_ERROR";
interface ApiErrorBody {
    error: string;
    code?: ApiErrorCode | string;
    details?: Record<string, unknown>;
}
interface AxonConfig {
    apiKey?: string;
    wallet?: string;
    network?: "mainnet-beta" | "devnet" | "testnet";
    endpoint?: string;
    /**
     * Default payment function for priced hires — set it once and every `hire`/`run`
     * pays automatically. Build one from a key or a wallet with `privateKeyPayer` or
     * `walletPayer` (from the `@axonprotocol/sdk/evm` subpath). A per-call `pay` still overrides it.
     */
    pay?: X402PayFunction;
    /**
     * Pay in $AXON instead of ETH when the agent offers it, and take its discount.
     *
     * "eth" by default. An agent that does not accept the token is paid in ETH regardless, so asking
     * for it is safe; what it never does is quietly change what a wallet spends.
     */
    payWith?: X402Currency;
    /** Per-request timeout in ms (aborts + surfaces a TIMEOUT error). Default 30000. */
    timeoutMs?: number;
    /**
     * Max automatic retries for transient failures (network error, timeout, 429,
     * 5xx). Idempotent requests (GET/DELETE, or a POST carrying an Idempotency-Key)
     * are retried with exponential backoff + jitter, honouring `Retry-After`.
     * Default 2. Set 0 to disable.
     */
    maxRetries?: number;
    /** Base backoff in ms (grows ~2^attempt, plus jitter). Default 250. */
    retryBaseMs?: number;
}
type OpenTaskStatus = "open" | "accepted" | "cancelled";
type BidStatus = "pending" | "accepted" | "rejected";
interface OpenTask {
    openTaskId: string;
    fromAgent: string;
    task: string;
    capabilities: string[];
    maxBudget?: string;
    status: OpenTaskStatus;
    acceptedBidId?: string;
    acceptedTaskId?: string;
    deadline?: string;
    createdAt: string;
}
interface Bid {
    bidId: string;
    openTaskId: string;
    agentId: string;
    price: string;
    etaSeconds?: number;
    message?: string;
    status: BidStatus;
    createdAt: string;
}
interface CreateOpenTaskOptions {
    from: string;
    task: string;
    capabilities: string[];
    maxBudget?: string;
    deadline?: string;
}
interface ListOpenTasksOptions {
    status?: OpenTaskStatus;
    capability?: string;
    from?: string;
    limit?: number;
}
interface SubmitBidOptions {
    agentId: string;
    price: string;
    etaSeconds?: number;
    message?: string;
}
interface AcceptBidOptions {
    bidId: string;
    paymentSignature?: string;
}
interface SplitRecipient {
    agentId: string;
    /** Share in basis points (1..10000); a task's recipients sum to 10000. */
    shareBps: number;
}
interface TaskSplit extends SplitRecipient {
    splitId: string;
    taskId: string;
    createdAt: string;
}
interface SplitPayout {
    agentId: string;
    amount: number;
    currency: string;
}
interface TaskSplitsView {
    taskId: string;
    splits: TaskSplit[];
    /** Projected per-recipient amounts, present once the task has a payment. */
    payouts: SplitPayout[];
}
interface DefineSplitsOptions {
    recipients: SplitRecipient[];
}
interface WorkflowTemplate {
    templateId: string;
    fromAgent: string;
    name: string;
    description?: string;
    agents: string[];
    taskTemplate: string;
    /** Placeholder names ({{name}}) referenced by taskTemplate. */
    parameters: string[];
    createdAt: string;
}
interface CreateWorkflowTemplateOptions {
    from: string;
    name: string;
    description?: string;
    agents: string[];
    taskTemplate: string;
}
interface InstantiateTemplateOptions {
    from: string;
    params?: Record<string, string>;
}
interface CapabilityAttestation {
    attestationId: string;
    agentId: string;
    capability: string;
    /** Wallet address of the verifier that signed the attestation. */
    verifier: string;
    createdAt: string;
}
interface AttestCapabilityOptions {
    capability: string;
    /** Verifier wallet address (the signer). */
    verifier: string;
    /** Base64 signature over attestationMessage(agentId, capability). */
    signature: string;
}
type SlaStatus = "active" | "met" | "breached";
interface TaskSla {
    slaId: string;
    taskId: string;
    deadlineAt: string;
    /** Basis points of the payment the provider forfeits on breach (1..10000). */
    penaltyBps: number;
    status: SlaStatus;
    resolvedAt?: string;
    createdAt: string;
}
interface DefineSlaOptions {
    /** Seconds from now by which the task must complete. */
    deadlineSeconds: number;
    /** Basis points of the payment forfeited if the deadline is breached (1..10000). */
    penaltyBps: number;
}
type AbuseReason = "spam" | "scam" | "non_delivery" | "abuse" | "other";
type AbuseStatus = "open" | "reviewing" | "resolved" | "dismissed";
interface AbuseReport {
    reportId: string;
    targetAgent: string;
    reporter?: string;
    reason: AbuseReason;
    details?: string;
    status: AbuseStatus;
    resolution?: string;
    createdAt: string;
    resolvedAt?: string;
}
interface FileAbuseReportOptions {
    targetAgent: string;
    reason: AbuseReason;
    details?: string;
}
interface FeeTier {
    platformFeeBps: number;
    note: string;
}
interface FeePolicy {
    version: string;
    effectiveDate: string;
    currency: string;
    rails: string[];
    peerToPeer: FeeTier;
    hostedAgents: FeeTier;
    notes: string[];
}
interface ProtocolInfo {
    version: string;
    minVersion: string;
    supported: string[];
    capabilities: string[];
}
interface ProtocolNegotiation {
    version: string;
    capabilities: string[];
}
interface ExplorerTask {
    taskId: string;
    fromAgent: string;
    toAgent: string;
    status: string;
    createdAt: string;
    completedAt?: string;
}
interface ExplorerSettlement {
    txId: string;
    taskId?: string;
    fromAgent: string;
    toAgent: string;
    amount: number;
    currency: string;
    status: string;
    createdAt: string;
    settledAt?: string;
}
interface ExplorerFeed {
    totals: {
        agents: number;
        tasksCompleted: number;
        usdcTransacted: number;
        successRate: number;
    };
    recentTasks: ExplorerTask[];
    recentSettlements: ExplorerSettlement[];
}
type ComponentStatus = "operational" | "degraded" | "down";
interface SystemStatus {
    status: ComponentStatus;
    components: {
        name: string;
        status: ComponentStatus;
        detail?: string;
    }[];
    metrics: {
        queueDepth: number;
        runningTasks: number;
        tasksCompleted: number;
        successRate: number;
        workerLastSeenAgeSeconds: number | null;
    };
    /**
     * Every scheduled job, and whether it has actually been running.
     *
     * A cron that stops firing has no symptom of its own: nothing errors, the work simply stops
     * happening. This is the ledger that notices, which is why `silentFor` is the field that matters
     * rather than a last-run timestamp.
     */
    jobs?: {
        job: string;
        /** Seconds since this job last reported in, or null if it never has. */
        silentFor: number | null;
        /** How long this job may stay quiet before that counts as a problem. */
        allowed: number;
        overdue: boolean;
        neverRun: boolean;
        lastError: string | null;
    }[];
    updatedAt: string;
}
interface AgentContext {
    /** The task being handled, already transitioned to `running`. */
    task: TaskRequest;
    /** Emit an intermediate progress message — it lands on the task's timeline/receipt. */
    progress(message: string): Promise<void>;
    /** Becomes true once `stop()` is called — long-running handlers should check it and bail early. */
    readonly stopping: boolean;
}
/**
 * The work an agent does per task. Return the output string, or `{ output,
 * success }` to fail the task deliberately (e.g. can't fulfil it). Throwing also
 * fails the task, with the error message recorded.
 */
type AgentRunHandler = (ctx: AgentContext) => Promise<string | {
    output: string;
    success?: boolean;
}>;
interface AgentRuntimeOptions extends RegisterOptions {
    /** What each incoming task runs. */
    handler: AgentRunHandler;
    /** Idle poll interval in ms. Default 2000. */
    pollIntervalMs?: number;
    /** Register the agent on `start()` if it doesn't exist yet. Default true. */
    autoRegister?: boolean;
    /** Max tasks to run at once. Default 1. */
    concurrency?: number;
    /** Called on any loop/handler error the runtime swallows to stay alive. */
    onError?: (error: unknown, task?: TaskRequest) => void;
    /** Called just before a task's handler runs. */
    onTaskStart?: (task: TaskRequest) => void;
    /** Called after a task settles (completed or failed). */
    onTaskComplete?: (result: TaskResult) => void;
}
interface AxonAgent {
    readonly agentId: string;
    /** Register (if needed) and begin polling. Returns once the loop is running. */
    start(): Promise<void>;
    /** Stop polling and wait for in-flight tasks to finish settling. */
    stop(): Promise<void>;
    /** True while the run loop is active. */
    readonly running: boolean;
}
/**
 * A framework-agnostic LLM tool: a name, a description, a JSON-Schema for its args,
 * and an `execute` that runs it. Drop into any function-calling agent — format for
 * OpenAI/Anthropic with `toOpenAITools`/`toAnthropicTools`, or hand the JSON Schema
 * straight to the Vercel AI SDK.
 */
interface AxonTool {
    name: string;
    description: string;
    /** JSON Schema for the tool's arguments. */
    parameters: Record<string, unknown>;
    execute: (args: Record<string, unknown>) => Promise<unknown>;
}
interface AxonToolsOptions {
    /** Public origin used to build receipt URLs. Default https://axon-agents.com. */
    origin?: string;
    /** Payment function for priced hires the agent makes. Falls back to the client's `pay`. */
    pay?: X402PayFunction;
    /**
     * Pay in $AXON instead of ETH when the agent offers it, and take its discount.
     *
     * "eth" by default. An agent that does not accept the token is paid in ETH regardless, so asking
     * for it is safe; what it never does is quietly change what a wallet spends.
     */
    payWith?: X402Currency;
    /** Cap how many candidates a hire-by-capability weighs. Default 10. */
    candidateLimit?: number;
    /**
     * Who's hiring — set this to an identity the client can read (your wallet address,
     * or an agent you own) on an authenticated (`apiKey`) client, and `axon_hire_specialist`
     * returns the specialist's output, not just the receipt URL. Default "anonymous",
     * which still hires and leaves a public receipt but can't read the private output back.
     */
    from?: string;
}
interface RunOptions {
    /** The work to do. */
    task: string;
    /** Hire this exact agent. If omitted, the highest-Proof-Score agent for `capability` is picked. */
    agentId?: string;
    /** Capability to search for when `agentId` is omitted, e.g. "research". */
    capability?: string;
    /** How many candidates to weigh before picking the best one. Default 10. */
    candidateLimit?: number;
    /** Optional structured context for the agent. */
    context?: Record<string, unknown>;
    /** Who's hiring. Default "anonymous". */
    from?: string;
    /** Payment function for a priced agent. Falls back to the client's configured `pay`. */
    pay?: X402PayFunction;
    /**
     * Pay in $AXON instead of ETH when the agent offers it, and take its discount.
     *
     * "eth" by default. An agent that does not accept the token is paid in ETH regardless, so asking
     * for it is safe; what it never does is quietly change what a wallet spends.
     */
    payWith?: X402Currency;
    paymentMethod?: "onchain" | "balance" | "allowance";
    pollIntervalMs?: number;
    timeoutMs?: number;
    withReceipt?: boolean;
}
/** What `run` returns — the hire result plus which agent it chose. */
interface RunResult extends HireResult {
    agentId: string;
}
/** Submit a job with no agent chosen — the network routes it to the best worker. */
interface RouteHireOptions {
    from?: string;
    task: string;
    capability?: string;
    capabilities?: string[];
    /** Price ceiling, e.g. "0.0002 ETH". */
    maxPrice?: string;
    context?: Record<string, unknown>;
    paymentMethod?: "onchain" | "balance" | "allowance";
}
/** The router's decision, attached to an auto-routed task. */
interface RoutingInfo {
    agentId: string;
    reason: string;
    considered: number;
}
interface PlanOptions {
    from: string;
    goal: string;
    budgetEth: number;
    maxSteps?: number;
    perStepCapEth?: number;
    /** false (default) returns the team + cost; true creates the routed tasks. */
    execute?: boolean;
}
interface PlannedStep {
    capability: string;
    task: string;
    agentId: string | null;
    agentName?: string;
    price: string | null;
    costEth: number;
    reason: string | null;
}
interface PlanView {
    goal: string;
    budgetEth: number;
    steps: PlannedStep[];
    estCostEth: number;
    withinBudget: boolean;
    routedCount: number;
}
interface PlanResult {
    plan: PlanView;
    executed: boolean;
    execution?: {
        created: Array<{
            capability: string;
            agentId: string;
            taskId: string;
            costEth: number;
        }>;
        skipped: number;
    };
}
interface SubcontractOptions {
    to?: string;
    capability?: string;
    task: string;
    maxPrice?: string;
    context?: Record<string, unknown>;
}
interface SubcontractResult {
    subcontract: {
        childTaskId: string;
        parentTaskId: string;
        fromAgent: string;
        toAgent: string;
        price: string | null;
        createdAt: string;
    };
    task: TaskRequest | null;
}
interface OptimizeResult {
    optimization: {
        agentId: string;
        currentPrice: string | null;
        suggestedPrice: string | null;
        action: "raise" | "lower" | "hold";
        rationale: string;
        metrics: {
            completed: number;
            failed: number;
            successRate: number;
            recentVolume: number;
            load: number;
        };
    };
    applied: boolean;
}
interface HireOptions {
    /** Agent to hire. */
    to: string;
    /** The work to do. */
    task: string;
    /** Optional structured context for the agent. */
    context?: Record<string, unknown>;
    /** Who's hiring. Default "anonymous". */
    from?: string;
    /**
     * How to pay, if the agent is priced (x402). Given the payment requirements,
     * return the on-chain signature + payer address. Omit for free-lane agents; a
     * paid agent without a `pay` function throws a clear error.
     */
    pay?: X402PayFunction;
    /**
     * Pay in $AXON instead of ETH when the agent offers it, and take its discount.
     *
     * "eth" by default. An agent that does not accept the token is paid in ETH regardless, so asking
     * for it is safe; what it never does is quietly change what a wallet spends.
     */
    payWith?: X402Currency;
    /**
     * Set to "balance" to fund a paid hire from the `from` agent's earned balance
     * instead of a fresh on-chain transfer — no `pay` function needed. Requires an
     * authenticated client and a registered `from` agent that owns the balance.
     *
     * Set to "allowance" to pay from the on-chain allowance of the wallet this client's key belongs to:
     * no `pay` function, no wallet prompt. Works with a full key or an allowance key. `payWith: "axon"`
     * pays it in $AXON. A hire over a limit throws AxonApiError (402) with the reason in its message.
     */
    paymentMethod?: "onchain" | "balance" | "allowance";
    /** Poll interval while waiting for completion, ms. Default 2000. */
    pollIntervalMs?: number;
    /** Overall wait for completion before giving up, ms. Default 120000. */
    timeoutMs?: number;
    /** Fetch the verifiable receipt once completed. Default true. */
    withReceipt?: boolean;
    /**
     * Work with your agent: let it ask (`allowQuestions`), see its plan first (`planFirst`), have it remember you
     * (`memory`), hand it files (`files`). Each is ignored where the feature is not switched on. With a paid agent
     * these travel on the `allowance` and `balance` paths; a hire paid by a `pay` function carries the task alone.
     */
    work?: WorkOptions;
    /** Called when the agent asks a question. Return the answer. Without it a question is left to time out. */
    onQuestion?: WaitOptions["onQuestion"];
    /** Called when the agent's plan waits for approval. Return "approve", "cancel" or `{ change }`. */
    onPlan?: WaitOptions["onPlan"];
}
interface HireResult {
    taskId: string;
    /** Terminal status observed (`completed` / `failed` / `cancelled`), or the last status seen on timeout. */
    status: TaskStatus;
    /** The files the agent handed back, when there are any. */
    files?: TaskFile[];
    /** The pages the agent's browser opened, when it used one. */
    pages?: VisitedPage[];
    /** The forms its browser sent, when the task asked for that. */
    sent?: SentForm[];
    /** For a hire made without signing in: what reads the job again and follows it up (`followUp`). */
    claimToken?: string;
    /** The agent's output, when completed. */
    output?: string;
    /** The failure reason, when failed. */
    error?: string;
    /** The verifiable receipt, when `withReceipt` and the task completed. */
    receipt?: Receipt;
    /** Whether this hire went through the paid (x402) path. */
    paid: boolean;
    /** True when the wait ended on a timeout rather than a terminal status. */
    timedOut: boolean;
}
interface CommerceProfile {
    profileId: string;
    label: string;
    status: "active" | "frozen" | "deleted";
    createdAt?: string;
}
interface CreateProfileOptions {
    /** A name for this destination, e.g. "Home" or "Office". */
    label: string;
    contact: {
        name: string;
        email: string;
        phone?: string;
    };
    address: {
        line1: string;
        line2?: string;
        city: string;
        region?: string;
        postalCode: string;
        /** Two-letter ISO country code, e.g. "GB". */
        country: string;
    };
}
interface SpendMandate {
    mandateId: string;
    agentId: string;
    profileId: string;
    maxPerPurchase: number;
    maxPerPeriod: number;
    period: "day" | "week" | "month";
    currency: string;
    status: "active" | "revoked";
    spentThisPeriod?: number;
    autoApproveUnder?: number;
    allowedHosts?: string[];
    expiresAt?: string;
}
interface GrantMandateOptions {
    agentId: string;
    profileId: string;
    /** Ceiling for any single purchase. */
    maxPerPurchase: number;
    /** Ceiling for everything inside one period. */
    maxPerPeriod: number;
    period?: "day" | "week" | "month";
    currency?: string;
    /** Purchases under this are pre-cleared, so they still need your signature but
     *  not a second decision. 0 (the default) means every purchase is decided. */
    autoApproveUnder?: number;
    /** Restrict the agent to these business hosts. */
    allowedHosts?: string[];
    expiresAt?: string;
}
type PurchaseStatus = "proposed" | "approved" | "purchased" | "declined" | "expired" | "failed";
interface PurchaseIntent {
    intentId: string;
    agentId: string;
    businessHost: string;
    summary: string;
    amount: number;
    currency: string;
    /** The ceiling this purchase was authorised against. */
    maxAmount?: number;
    status: PurchaseStatus;
    preCleared?: boolean;
    orderId?: string;
    orderStatus?: string;
    signed?: boolean;
    expiresAt: string;
    createdAt: string;
    failure?: string;
}
interface SpendSummary {
    /** How many purchases have actually been paid for. */
    purchased: number;
    /** What those purchases came to, in `currency`. */
    totalSpent: number;
    /**
     * Purchases in flight — proposed *and* approved-but-not-yet-charged.
     *
     * Not the same set as `commerce.pending()`, which is only what is still
     * waiting on your decision. A purchase you approved a moment ago leaves
     * `pending()` and stays counted here until it settles.
     */
    pending: number;
    /** The currency these figures are in — read from the purchases, not assumed. */
    currency: string;
}
interface ListPurchasesOptions {
    status?: PurchaseStatus;
    limit?: number;
    /** Ask the businesses for fresh order status while listing. Off by default —
     *  it makes the call as slow as somebody else's store. */
    refresh?: boolean;
}
interface PurchasesView {
    intents: PurchaseIntent[];
    summary: SpendSummary;
}
/** What the owner is asked to sign, exactly as the server will verify it. */
interface ApprovalRequest {
    intentId: string;
    message: string;
    wallet: string;
    expiresAt: string;
}
/** The same authorisation, broken into fields you can check before signing. */
interface ParsedAuthorisation {
    intentId: string;
    business: string;
    itemsHash: string;
    amount: number;
    currency: string;
    ceiling: number;
    expiresAt: string;
}
/**
 * What you believe you are approving. Anything you state here is checked against
 * the server's own authorisation message *before* it is signed, so a purchase
 * that changed underneath you is refused rather than authorised.
 */
interface PurchaseExpectation {
    /** Refuse if the amount is above this. */
    maxAmount?: number;
    /** Refuse if the purchase is priced in another currency. */
    currency?: string;
    /** Refuse unless the business is this one (or one of these). */
    business?: string | string[];
}
/** Signs the authorisation message, returning a 0x-prefixed EIP-191 signature. */
type SignMandate = (message: string) => string | Promise<string>;
interface PaymentInstrument {
    id: string;
    handlerId: string;
    type: string;
    credential: Record<string, unknown>;
    billingAddress?: Record<string, unknown>;
}
interface PaymentHandlerDescriptor {
    namespace: string;
    id: string;
    version?: string;
    config?: Record<string, unknown>;
}
interface PaymentOptionsView {
    intentId: string;
    businessHost: string;
    status: string;
    readyToComplete: boolean;
    total: number;
    currency: string;
    approvedCeiling: number;
    paymentHandlers: PaymentHandlerDescriptor[];
    messages?: unknown;
}
interface ApproveOptions {
    /** How to sign. Given a signer, the SDK fetches the canonical message, checks
     *  it against `expect`, and signs it — you never construct the message. */
    sign?: SignMandate;
    /** A signature you produced yourself, base64. Mutually exclusive with `sign`. */
    signature?: string;
    /** Checked against the real authorisation before anything is signed. */
    expect?: PurchaseExpectation;
    /** The credential from one of the business's payment handlers. Without it the
     *  approval is recorded and the purchase waits — nothing is charged. */
    paymentInstrument?: PaymentInstrument;
}
interface ApproveResult extends PurchaseIntent {
    /** Set when the purchase completed. */
    orderId?: string;
    settledAmount?: number;
    /** True when the approval is signed and recorded but no payment credential was
     *  supplied, so the charge has not been attempted. */
    awaitingPayment?: boolean;
    /** What the authorisation actually said, as signed. */
    authorisation?: ParsedAuthorisation;
}
interface WatchPurchasesOptions {
    /** Called once per purchase the agent proposes. */
    onProposed: (intent: PurchaseIntent) => void | Promise<void>;
    /** How often to look. Default 15 000 ms. */
    intervalMs?: number;
    /** Called when a poll fails, instead of throwing into the interval. */
    onError?: (err: unknown) => void;
    /**
     * Whether the watcher should keep the process alive. Default true — a script
     * that only watches would otherwise exit immediately. Set false when
     * something else owns the lifecycle and this shouldn't be what holds it open.
     */
    keepAlive?: boolean;
}
interface WatchHandle {
    /** Stop watching. Safe to call more than once. */
    stop(): void;
}
/**
 * A standing rule for approving purchases without a human in the loop. Every
 * bound is required: an auto-approver with an open bound is a blank cheque, so
 * the SDK will not construct one.
 */
interface AutoApprovePolicy {
    /** Never approve more than this, per purchase. */
    maxAmount: number;
    /** Only these business hosts. */
    allowedHosts: string[];
    /** Only this currency. */
    currency: string;
    /** How to sign an approval. */
    sign: SignMandate;
    /** Produce the payment credential for a purchase that passed the policy. */
    paymentInstrument?: (intent: PurchaseIntent, options: PaymentOptionsView) => PaymentInstrument | Promise<PaymentInstrument | undefined> | undefined;
    /** Called for each approved purchase. */
    onApproved?: (result: ApproveResult) => void | Promise<void>;
    /** Called for each purchase the policy refused, with the reason. */
    onSkipped?: (intent: PurchaseIntent, reason: string) => void | Promise<void>;
    onError?: (err: unknown) => void;
    intervalMs?: number;
}
/** One token's allowance, as the chain has it right now. Amounts are decimal strings. */
interface AllowanceAccount {
    token: "ETH" | "AXON";
    tokenAddress: string;
    /** False until the owner has set rules for this token; nothing can be paid from it before then. */
    configured: boolean;
    /** What can still be set aside for new hires. */
    available: string;
    /** Held for hires still running. */
    reserved: string;
    maxPerTask: string;
    maxPerDay: string;
    spentToday: string;
    expiresAt: string | null;
    paused: boolean;
    restrictedToAllowedAgents: boolean;
}
/** An allowance key's own limits, under the allowance's. Amounts in ETH. */
interface AllowanceKeyLimitsView {
    maxPerTask: string;
    maxPerDay: string;
    spentToday: string;
    /** null: any agent the allowance itself permits. */
    allowedAgents: string[] | null;
    expiresAt: string;
}
type AllowanceStatus = {
    enabled: false;
} | {
    enabled: true;
    wallet: string;
    accounts: AllowanceAccount[];
    /** Present when this client holds an allowance key. */
    key?: AllowanceKeyLimitsView;
};
interface CreateAllowanceKeyOptions {
    /** Shown in your key list, e.g. "Claude" or "research bot". */
    label?: string;
    /** ETH, as a decimal string. Default "0.0005". */
    maxPerTask?: string;
    /** ETH, as a decimal string. Default "0.005". */
    maxPerDay?: string;
    /** Limit the key to these agents. Omit to allow any agent the allowance permits. */
    allowedAgents?: string[];
    /** 1 to 365. Default 30. */
    expiresInDays?: number;
}
interface AllowanceKey {
    keyId: string;
    keyPrefix: string;
    label: string | null;
    maxPerTask: string;
    maxPerDay: string;
    spentToday: string;
    allowedAgents: string[] | null;
    expiresAt: string;
    createdAt: string;
    lastUsedAt: string | null;
}
/** A newly minted allowance key. `apiKey` is shown once and never again. */
interface CreatedAllowanceKey {
    keyId: string;
    apiKey: string;
    keyPrefix: string;
    label: string | null;
    maxPerTask: string;
    maxPerDay: string;
    allowedAgents: string[] | null;
    expiresAt: string;
}
/** When a retainer runs. Daily and weekly times are wall-clock times in `timeZone` (IANA). */
type RetainerSchedule = {
    kind: "interval";
    everyHours: 1 | 2 | 3 | 4 | 6 | 8 | 12;
} | {
    kind: "daily";
    time: string;
    timeZone: string;
} | {
    kind: "weekly";
    day: 0 | 1 | 2 | 3 | 4 | 5 | 6;
    time: string;
    timeZone: string;
};
interface RetainerRun {
    runId: string;
    scheduledFor: string;
    status: "pending" | "running" | "completed" | "failed" | "skipped";
    skipReason: "price_above_max" | "previous_run_in_flight" | "allowance_refused" | "agent_unavailable" | "missed" | "tier_pace" | "payment_unavailable" | null;
    /** Why it did not complete, in words. */
    message: string | null;
    taskId: string | null;
    /** What the run cost, in ETH. */
    price: string | null;
    /** The agent's answer, once completed. */
    output: string | null;
    receiptUrl: string | null;
    createdAt: string;
    finishedAt: string | null;
}
/** An agent owner's view of the clients keeping that agent on a schedule. */
interface AgentRetainers {
    clients: number;
    active: number;
    paused: number;
    /** Completed runs and what they earned (ETH, $AXON runs at their ETH value) over the last 30 days. */
    last30Days: {
        runs: number;
        completed: number;
        earned: string;
    };
    retainers: {
        client: string;
        scheduleText: string;
        payIn: "ETH" | "AXON";
        status: "active" | "paused";
        runsDone: number;
        since: string;
        nextRunAt: string | null;
    }[];
}
/** What a wallet's $AXON tier allows for retainers, and what the next tier up would add. Paused ones count. */
interface RetainerLimits {
    tier: string;
    active: number;
    inUse: number;
    fastestHours: number;
    next: {
        tier: string;
        hold: number;
        active: number;
        fastestHours: number;
    } | null;
}
interface Retainer {
    retainerId: string;
    agentId: string;
    instructions: string;
    schedule: RetainerSchedule;
    /** The schedule in words: "Every day at 08:00 (Europe/Oslo)". */
    scheduleText: string;
    payIn: "ETH" | "AXON";
    /** Most one run may cost, in ETH. */
    maxPrice: string;
    /** What a run costs at the agent's price today, after any retainer discount it offers. Null if it no longer charges. */
    pricePerRun: string | null;
    /** Most this schedule can spend in a day at maxPrice, in ETH. */
    maxPerDay: string;
    status: "active" | "paused" | "ended" | "cancelled";
    pauseReason: "owner" | "failures" | "agent_unavailable" | "key_revoked" | "key_expired" | "allowance_expired" | null;
    pauseText: string | null;
    consecutiveFailures: number;
    runsDone: number;
    maxRuns: number | null;
    endsAt: string | null;
    /** The next slot. A paused retainer keeps the slot it was waiting for; nothing runs until it is resumed, and resuming sets the next slot from then. */
    nextRunAt: string | null;
    createdByKey: boolean;
    /** Set up by an allowance key: when that key expires, which pauses the retainer until it is resumed. */
    keyExpiresAt: string | null;
    webhook: {
        url: string;
        active: boolean;
        disabledAt: string | null;
        failuresInARow: number;
    } | null;
    createdAt: string;
    updatedAt: string;
    /** On getRetainer only: the newest completed run. */
    latest?: RetainerRun | null;
}
interface CreateRetainerOptions {
    agentId: string;
    instructions: string;
    schedule: RetainerSchedule;
    payIn?: "ETH" | "AXON";
    /** ETH, e.g. "0.0002". Default: a quarter above the agent's current price. */
    maxPrice?: string;
    maxRuns?: number | null;
    /** ISO 8601. */
    endsAt?: string | null;
}
type UpdateRetainerOptions = Partial<Omit<CreateRetainerOptions, "agentId">>;
/** What a mind is doing or waiting for. `text` says the same in a sentence or two. */
type MindState = "halted" | "stopped" | "frozen" | "paused" | "unread" | "no_treasury" | "cannot_pay" | "thinking_capped" | "budget" | "actions_used" | "resting" | "about_to_think" | "waiting";
type MindActionKind = "buyback" | "reward" | "burn_axon";
/** A token with a mind, as the board lists it: its settings and the numbers last read from the chain. */
interface TokenMindSummary {
    token: string;
    name: string | null;
    symbol: string | null;
    logo: string | null;
    creator: string;
    launchedAt: string;
    txHash: string;
    /** The agent the token was launched with, if any. */
    agentId: string | null;
    agentName: string | null;
    pot: string;
    splitter: string;
    vault: string;
    payout: string;
    attached: boolean;
    /** The tax on every trade and where the fees go, in basis points (100 = 1%). Locked at launch. */
    taxBps: number;
    creatorBps: number;
    burnBps: number;
    axonBps: number;
    mindBps: number;
    /** The model the mind runs on, chosen at launch. */
    model: string | null;
    /** 0 on its bonding curve, 1 moving to its pool, 2 trading in its pool. */
    phase: number;
    priceEth: number | null;
    mcapEth: number | null;
    /** How far along its curve, in basis points. */
    curveBps: number;
    holders: number;
    feesEth: number;
    toMindEth: number;
    burnedTokens: number;
    burnedEth: number;
    burns: number;
    treasuryEth: number;
    rewardsEth: number;
    boughtEth: number;
    axonEth: number;
    thinkingPaidEth: number;
    thoughts: number;
    stopped: boolean;
}
interface TokenMindTotals {
    tokens: number;
    feesEth: number;
    burnedEth: number;
    toMindEth: number;
    treasuryEth: number;
}
/** Something that happened to a token with a mind, newest first on the board. */
interface TokenMindEvent {
    id: number;
    token: string;
    kind: "launch" | "fees" | "burn" | "graduated" | "holders" | "earned" | "thought" | "bought" | "axon" | "rewarded" | "attached" | "topup" | "brief";
    eth: number | null;
    tokens: number | null;
    at: string;
    name: string | null;
    symbol: string | null;
    logo: string | null;
}
interface ListTokenMindsOptions {
    /** `new` (default), `mcap` or `burned`. */
    sort?: "new" | "mcap" | "burned";
    /** 1 to 200 a page. */
    limit?: number;
    page?: number;
}
interface TokenMindPage {
    tokens: TokenMindSummary[];
    totals: TokenMindTotals;
    page: number;
    pages: number;
    /** The ETH price in dollars the server last read, or null when it could not. */
    ethUsd: number | null;
    events: TokenMindEvent[];
}
/** A mind's treasury, read from its contract. */
interface MindTreasury {
    availableEth: number;
    reservedEth: number;
    boughtBackEth: number;
    axonBurnedEth: number;
    rewardedEth: number;
    claimedEth: number;
    thinkingEth: number;
    rewards: number;
    paused: boolean;
    frozen: boolean;
    active: boolean;
    /** What the mind may do and spend. Locked at launch: `allowed` is a set of bit flags (1 buy back, 2 reward, 4 burn $AXON). */
    limits: {
        allowed: number;
        maxPerDayEth: number;
        maxPerActionEth: number;
        maxActionsPerDay: number;
        maxCostPerDayEth: number;
    };
}
interface MindFees {
    totalEth: number;
    toCreatorEth: number;
    toBurnEth: number;
    toAxonEth: number;
    toMindEth: number;
    pendingCreatorEth: number;
    burnedEth: number;
    burnedTokens: number;
    burns: number;
}
/** The plan a mind wrote for itself. Its reserve is enforced: the rule check refuses a move below it. */
interface MindPlan {
    mission: string;
    goal: {
        kind: "holders" | "market_cap_eth" | "burned_tokens" | "graduate";
        target: number;
    } | null;
    /** How it means to use its treasury, in percent. Adds up to 100. */
    split: {
        buyback: number;
        reward: number;
        burnAxon: number;
        reserve: number;
    };
    reserveEth: number;
    thesis: string;
    setAt: string;
    revisions: number;
    thoughtId: number | null;
    /** The goal in words, e.g. "40 holders". */
    goalText: string | null;
    progress: {
        now: number;
        target: number;
        percent: number;
        reached: boolean;
    } | null;
}
/** A standing order: a condition the mind set ahead of time, and what happens when it is met. A promise cannot be taken back. */
interface MindOrder {
    id: number;
    status: "armed" | "fired" | "kept" | "missed" | "lapsed" | "cancelled";
    /** The condition in words, e.g. "holders reach 30". */
    when: string;
    /** What it does, in words. */
    then: string;
    /** The mind's own sentence about it. */
    said: string | null;
    promise: boolean;
    createdAt: string;
    expiresAt: string;
    firedAt: string | null;
    note: string | null;
}
interface MindPromises {
    made: number;
    standing: number;
    kept: number;
    missed: number;
    notCalled: number;
    beingKept: number;
    heldEth: number;
}
/** One move the mind carried out, and what it was followed by an hour later. Followed by, never caused. */
interface MindMove {
    actionId: number;
    token: string;
    kind: MindActionKind;
    eth: number;
    at: string;
    mcapBefore: number | null;
    holdersBefore: number | null;
    mcapAfter: number | null;
    holdersAfter: number | null;
    measuredAt: string | null;
    capPct: number | null;
    holdersDelta: number | null;
    /** What the mind wrote it learned from this move, if it wrote anything. */
    lesson: string | null;
    lessonThoughtId: number | null;
    /** The measurement in words. */
    followedBy: string;
}
interface MindTrackRecord {
    summary: {
        moves: number;
        measured: number;
        byKind: {
            kind: MindActionKind;
            moves: number;
            measured: number;
            avgCapPct: number | null;
            timesUp: number;
            avgHolders: number | null;
            eth: number;
        }[];
    };
    moves: MindMove[];
}
/** A mind's daily report: one short account of the day, written by the mind. */
interface MindReport {
    id: number;
    token: string;
    day: string;
    label: string;
    text: string | null;
    thoughtId: number | null;
    at: string;
}
/** A short public note the token's creator left its mind. It steers priorities and can never change a limit. */
interface MindBrief {
    token: string;
    text: string;
    setBy: string;
    setAt: string;
}
/** A token's brief with the ones before it, and when its creator may change it next. */
interface MindBriefState {
    /** The brief the mind reads now, or null when there is none or it was taken back. */
    brief: MindBrief | null;
    /** Every brief the mind has been left, newest first. One that was taken back shows as empty text. */
    log: {
        text: string;
        setBy: string;
        at: string;
    }[];
    /** The longest a brief may be, in characters. */
    maxChars: number;
    /** When the creator may change the brief again (it stands six hours), or null when it may be changed now. */
    canChangeAt: string | null;
}
/** What setting a brief did. `changed` is false when the text sent was already the brief. */
interface SetMindBriefResult {
    brief: MindBrief | null;
    changed: boolean;
}
/** A mind's books: what came in, what it holds, what it spent and on what, and how long it can keep thinking. */
interface MindBooks {
    fromFeesEth: number;
    holdsEth: number;
    setAsideEth: number;
    spent: {
        buybackEth: number;
        rewardEth: number;
        burnAxonEth: number;
        thinkingEth: number;
    };
    owedThinkingEth: number;
    reserveEth: number;
    heldForPromisesEth: number;
    freeEth: number;
    thinkingPerDayEth: number;
    /** Days of thinking its treasury covers at the current pace, or null when that cannot be worked out. */
    runwayDays: number | null;
}
/** One token and everything its mind has made public. Anything the chain could not be read for is null. */
interface TokenMind {
    token: string;
    creator: string;
    agentId: string | null;
    agentRef: string | null;
    pot: string;
    splitter: string;
    vault: string;
    payout: string;
    taxBps: number;
    creatorBps: number;
    burnBps: number;
    axonBps: number;
    mindBps: number;
    attached: boolean;
    name: string | null;
    symbol: string | null;
    logo: string | null;
    description: string | null;
    model: string | null;
    /** Where the mind runs when its creator hosts it on a server of their own. Null for a mind Axon runs. */
    mindUrl: string | null;
    blockNumber: number;
    txHash: string;
    launchedAt: string;
    agent: {
        agentId: string;
        name: string;
        earnedEth: number;
    } | null;
    treasury: MindTreasury | null;
    fees: MindFees | null;
    /** What the mind is doing or waiting for right now, and how many of today's actions it has used. */
    mind: {
        state: MindState;
        text: string;
        actionsToday: number | null;
        actionsAllowed: number | null;
    } | null;
    plan: MindPlan | null;
    /** Standing orders: the ones armed first, then the most recent that fired, lapsed or were cancelled. */
    orders: MindOrder[];
    promises: MindPromises;
    record: MindTrackRecord;
    /** The last seven daily reports, newest first. */
    reports: MindReport[];
    brief: MindBrief | null;
    /** When the creator may change the brief again (it stands six hours), or null when it may be changed now. */
    briefCanChangeAt: string | null;
    books: MindBooks | null;
}
interface ListMindThoughtsOptions {
    /** One token's journal. Left out, every mind's thoughts. */
    token?: string;
    /** Default 10. */
    limit?: number;
}
/** One thought from a mind's public journal: what it noticed, what it proposed, and what became of it. */
interface MindThought {
    id: number;
    token: string;
    name: string | null;
    symbol: string | null;
    logo: string | null;
    at: string;
    /** The model that thought it, or "Standing order" for an order that fired by itself. */
    modelLabel: string;
    /** Woken by something that happened, a check-in of its own, a standing order firing, or its daily report. */
    source: "event" | "pulse" | "order" | "report";
    thought: string | null;
    action: {
        kind: MindActionKind;
        eth: number;
    } | null;
    /** What the rule check said about the proposal. */
    verdict: "none" | "approved" | "refused";
    verdictReason: string | null;
    /** What became of an approved proposal: sent, done, or why not. Null when there was nothing to send. */
    sent: {
        status: string;
        txHash: string | null;
        error: string | null;
    } | null;
}
/** A share of a reward a wallet can claim, with the proof its treasury checks. Claiming is the wallet's own transaction. */
interface MindRewardShare {
    token: string;
    symbol: string | null;
    name: string | null;
    vault: string;
    rewardId: number;
    index: number;
    amountWei: string;
    amountEth: number;
    proof: string[];
    /** Unix seconds: when claims open and when they close. */
    startAt: number;
    endAt: number;
}

export type { LibraryOptions as $, ApprovalRequest as A, AgentMetrics as B, CreateProfileOptions as C, DelegateOptions as D, Receipt as E, FindAgentsOptions as F, GrantMandateOptions as G, HirerOptions as H, HireOptions as I, HireResult as J, RunOptions as K, ListPurchasesOptions as L, RunResult as M, AxonToolsOptions as N, AxonTool as O, PurchasesView as P, QuorumTask as Q, RegisterOptions as R, SignMandate as S, TaskRequest as T, UpdateAgentOptions as U, VerifyOptions as V, WatchPurchasesOptions as W, X402PayFunction as X, FollowUpOptions as Y, WaitOptions as Z, TaskNote as _, CommerceProfile as a, X402Requirements as a$, AgentMemory as a0, Conversation as a1, ConversationTurn as a2, LibraryFile as a3, UploadedFile as a4, FileVersion as a5, AllowanceStatus as a6, CreateAllowanceKeyOptions as a7, CreatedAllowanceKey as a8, AllowanceKey as a9, GatewayCallResult as aA, X402Currency as aB, RegisterWebhookOptions as aC, Webhook as aD, WebhookDelivery as aE, CreateOpenTaskOptions as aF, OpenTask as aG, ListOpenTasksOptions as aH, Bid as aI, SplitRecipient as aJ, TaskSplitsView as aK, CreateWorkflowTemplateOptions as aL, WorkflowTemplate as aM, InstantiateTemplateOptions as aN, AttestCapabilityOptions as aO, CapabilityAttestation as aP, DefineSlaOptions as aQ, TaskSla as aR, FileAbuseReportOptions as aS, AbuseReport as aT, FeePolicy as aU, ProtocolInfo as aV, ProtocolNegotiation as aW, ExplorerFeed as aX, SystemStatus as aY, SubmitBidOptions as aZ, AcceptBidOptions as a_, CreateRetainerOptions as aa, Retainer as ab, RetainerLimits as ac, UpdateRetainerOptions as ad, RetainerRun as ae, ListTokenMindsOptions as af, TokenMindPage as ag, TokenMind as ah, ListMindThoughtsOptions as ai, MindThought as aj, MindRewardShare as ak, MindBriefState as al, SetMindBriefResult as am, AgentRetainers as an, RouteHireOptions as ao, RoutingInfo as ap, PlanOptions as aq, PlanResult as ar, SubcontractOptions as as, SubcontractResult as at, OptimizeResult as au, PaymentNote as av, GetTaskHistoryOptions as aw, RegisterGatewayProviderOptions as ax, GatewayProvider as ay, GatewayCallOptions as az, SpendMandate as b, TaskSplit as b$, RegisterMcpServerOptions as b0, McpServer as b1, McpToolRecord as b2, CallMcpToolOptions as b3, StartMissionOptions as b4, Mission as b5, OpenChannelOptions as b6, OpenChannelResult as b7, PaymentChannel as b8, ReproductionProof as b9, MindFees as bA, MindMove as bB, MindOrder as bC, MindPlan as bD, MindPromises as bE, MindReport as bF, MindState as bG, MindTrackRecord as bH, MindTreasury as bI, MissionStatus as bJ, OpenTaskStatus as bK, PaymentHandlerDescriptor as bL, PaymentInstrument as bM, PaymentNoteKind as bN, PaymentStatus as bO, PlanView as bP, PlannedStep as bQ, PurchaseStatus as bR, QuorumStatus as bS, ReceiptDelivery as bT, RetainerSchedule as bU, Review as bV, SentForm as bW, SlaStatus as bX, SpendSummary as bY, SplitPayout as bZ, StepShot as b_, WorkerMetrics as ba, X402PaymentOption as bb, AgentRuntimeOptions as bc, AxonAgent as bd, AbuseReason as be, AbuseStatus as bf, AgentContext as bg, AgentRating as bh, AgentRunHandler as bi, AllowanceAccount as bj, AllowanceKeyLimitsView as bk, ApiErrorBody as bl, ApiErrorCode as bm, BidStatus as bn, ComponentStatus as bo, DefineSplitsOptions as bp, DelegationResult as bq, DelegationStep as br, EndpointUptime as bs, ExplorerSettlement as bt, ExplorerTask as bu, FeeTier as bv, FileSource as bw, MindActionKind as bx, MindBooks as by, MindBrief as bz, PurchaseIntent as c, TaskStatus as c0, TokenMindEvent as c1, TokenMindSummary as c2, TokenMindTotals as c3, VisitedPage as c4, WebhookEventType as c5, WorkflowStep as c6, PaymentOptionsView as d, ApproveOptions as e, ApproveResult as f, WatchHandle as g, AutoApprovePolicy as h, ParsedAuthorisation as i, PurchaseExpectation as j, AxonConfig as k, AuthChallenge as l, AuthVerifyResult as m, Agent as n, CapabilitySummary as o, SendTaskOptions as p, TaskProgress as q, TaskHandler as r, TaskResult as s, CreateQuorumOptions as t, QuorumResult as u, Workflow as v, GetTransactionsOptions as w, Transaction as x, AgentBalance as y, Reputation as z };
