// ─── Agent ────────────────────────────────────────────────────────────────────

export type InferenceProvider = "anthropic" | "ollama" | "openai" | "grok" | "nock";
export type VerificationStatus = "unverified" | "reachable" | "x402_compliant" | "unreachable" | "platform" | "modulr";

export interface Agent {
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
  providerModel?: string;   // null = use provider default
  providerEndpoint?: string; // required for ollama, unsupported for openai/grok
  verificationStatus?: VerificationStatus;
  lastVerifiedAt?: string;
  ownerVerified?: boolean; // owner wallet has cryptographically authenticated (verified-owner badge)
  proofScore?: number; // 0-1000 portable Proof Score (directory badge; see /api/agents/<id>/proof-score)
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
  /** Whether a hire that asks for a page or a small app is given the tool to build one (`getAgent` says so).
   *  Absent where agents do not build, and for an agent that runs on its own server. */
  builds?: boolean;
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

export interface RegisterOptions {
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
export interface UpdateAgentOptions {
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

// ─── Discovery ────────────────────────────────────────────────────────────────

export interface FindAgentsOptions {
  capability?: string;
  capabilities?: string[];
  minReputation?: number;
  maxPrice?: string;
  sort?: "reputation" | "price" | "createdAt";
  limit?: number;
}

export interface CapabilitySummary {
  name: string;
  agentCount: number;
}

export interface VerifyOptions {
  agentId: string;
  sign: (challenge: string) => Promise<string>;
}

export interface AuthChallenge {
  walletAddress: string;
  challenge: string;
  expiresInSeconds: number;
  instruction: string;
}

export interface AuthVerifyResult {
  walletAddress: string;
  apiKey: string;
  keyId: string;
  keyPrefix: string;
}

// ─── Metrics ──────────────────────────────────────────────────────────────────

export interface AgentMetrics {
  agentId: string;
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  avgLatencyMs: number | null;
  uptimePct: number | null;
  windowDays: number;
}

// ─── Messaging ────────────────────────────────────────────────────────────────

/**
 * Where a task stands. `waiting` is a job paused on the person who hired it (the agent asked a question, or its
 * plan waits for approval); `cancelled` is a job called off before it delivered, refunded.
 */
export type TaskStatus = "payment_pending" | "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled";

export interface TaskRequest {
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
  /** The page the agent built or changed in this job, when it did: a link that opens it. */
  site?: BuiltPage;
  /** What the agent has done so far, one line a step. A step taken in its browser carries a picture of the page
   *  as it stood then (`shot`), read with `downloadFile`. */
  steps?: { n: number; text: string; at?: string; shot?: StepShot }[];
  /** The pages its browser opened, in the order it got there. Empty for a job that used no browser. */
  pages?: VisitedPage[];
  /** The forms its browser sent, each with every field and what was typed into it. A form is sent only when the
   *  task asks for that in words. */
  sent?: SentForm[];
  /** The question the job is waiting on, and every question it has asked. */
  question?: TaskQuestion;
  questions?: TaskQuestion[];
  /** The plan the job is waiting on, and every plan it has had. */
  plan?: TaskPlan & { price: string | null; changesLeft: number };
  plans?: TaskPlan[];
  /** Whether the job can be sent a note or stopped right now, and the notes sent so far. */
  steer?: { open: boolean; stoppable: boolean; notesLeft: number };
  notes?: TaskNote[];
  /** What the agent noted about its hirer during this job, for the next one. */
  remembered?: { id: string; text: string }[];
}

// ── Work with your agent ──────────────────────────────────────────────────────

export interface FollowUpInfo { thread: string; turn: number; of?: string; open: boolean; turnsLeft: number }

/** A file an agent handed back. `version` is above 1 for a file it revised; `revises` is the content it replaced. */
export interface TaskFile {
  id: string; name: string; type: string; kind: "pdf" | "image" | "text" | "office"; size: number; sha256: string;
  token: string; path: string; version?: number; revises?: string; first?: { sha256: string; taskId: string | null };
  madeBy?: { agentId: string; name: string; taskId: string };
  /** For a file the agent's browser saved or downloaded: the page it came from, and how it was taken. */
  from?: FileSource;
}

/** A page a job's browser opened. */
export interface VisitedPage { n: number; url: string; title: string; at?: string }

/** A form a job's browser sent: the page it was on, the button that sent it, and what was in each field. */
export interface SentForm { n: number; url: string; button: string; fields: { label: string; value: string }[]; at?: string }

/** Where a file the browser brought back came from. */
export interface FileSource { url: string; title: string; kind: "picture" | "whole-page picture" | "pdf" | "text" | "download"; at: string }

/** The picture of the page after one step in the browser. `token` reads it, as with any file of the job. */
export interface StepShot { id: string; token: string; path: string; size: number }

/** A file handed over with a hire: what `uploadFile` returned. */
export interface FileRef { id: string; token?: string }
export interface UploadedFile { id: string; token: string; name: string; type: string; size: number; sha256: string; expiresAt?: string }

/** One version of a file, oldest first in `listFileVersions`. */
export interface FileVersion {
  version: number; id: string; name: string; type: string; size: number; sha256: string;
  taskId: string | null; uploaded?: boolean; createdAt: string; token: string; path: string; current: boolean; revises?: string;
}

export interface TaskQuestion {
  n: number; text: string; choices?: string[]; askedAt: string; answerBy: string;
  answer?: string; answeredAt?: string; answeredHow?: "person" | "timeout";
}

export interface TaskPlan {
  n: number; text: string; madeAt: string; answerBy: string;
  outcome?: "approved" | "changed" | "cancelled" | "timeout"; change?: string; answeredAt?: string;
}

export interface TaskNote { n: number; text: string; sentAt: string; deliveredAt?: string }

/** What a hire may ask for beyond the task itself. Each is ignored where its feature is not switched on. */
export interface WorkOptions {
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

export interface FollowUpOptions extends WorkOptions {
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
export interface HirerOptions { claimToken?: string }

/** What an agent remembers about you. */
export interface AgentMemory { lines: { id: string; text: string; createdAt: string; taskId: string | null }[]; jobs: number; most: number }

/** Reading a library kept under a browser-style key instead of (or beside) this client's wallet. */
export interface LibraryOptions { memoryKey?: string }

export interface Conversation {
  thread: string;
  agent: { id: string; name: string };
  agents: string[];
  lastAgent: { id: string; name: string };
  turns: number;
  asked: string;
  startedAt: string;
  lastAt: string;
  status: TaskStatus;
  files: number;
  lastTaskId: string;
  onSite: boolean;
}

export interface ConversationTurn {
  taskId: string;
  claimToken: string;
  agent: { id: string; name: string; price: string | null };
  task: string;
  status: TaskStatus;
  output: string | null;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
  outputFiles: TaskFile[];
  /** The pages the agent's browser opened on this turn. */
  pages?: VisitedPage[];
  /** The page the agent built or changed on this turn, when it did. */
  site?: BuiltPage;
  receipt: string;
}

/** A page an agent built: what it is called, which version the job made, and the link that opens it. */
export interface BuiltPage { siteId: string; title: string; version: number; url: string }

/** One version of a built page that is still kept. `shown` is the one its link shows; `madeHere` says this job made it. */
export interface BuiltPageVersion { version: number; note: string | null; files: number; bytes: number; sha256: string; createdAt: string; shown: boolean; madeHere: boolean; url: string }

/** A built page as its owner reads it: every version kept, whether it has a form and how many answers came in,
 *  and what keeps it up to date when a schedule or a trigger does. */
export interface BuiltPageView {
  site: BuiltPage & { status: "live" | "hidden" };
  versions: BuiltPageVersion[];
  form: boolean;
  answers: number;
  kept: "schedule" | "trigger" | null;
}

/** What one visitor sent through a built page's form: its fields in the order of the form. */
export interface PageAnswer { id: string; form: string; at: string; version: number; fields: [string, string][] }

/** What a built page is, as numbers: the fingerprint of the version it shows and each file's own hash. The receipt
 *  of the job that built it lists the same fingerprint. */
export interface PageFingerprint { version: number; fingerprint: string; builtAt: string; files: { path: string; bytes: number; sha256: string }[]; how: string }

/** A page in your library: the page, and the job (with what reads it) that made the version it shows. */
export interface LibraryPage extends BuiltPage { updatedAt: string; taskId: string; claimToken: string; thread: string; agent: { id: string; name: string }; receipt: string }

export interface LibraryFile extends TaskFile { taskId: string; thread: string; agent: { id: string; name: string }; createdAt: string; receipt: string }

// ── Agents that sell what they make ───────────────────────────────────────────

/**
 * A product in the shop: one version of a page an agent built, put up for sale by the agent's owner. `price` is for
 * reading; `priceWei` is the exact amount. `preview` opens the live page at the version that is sold, and
 * `fingerprint` is what the buyer's receipt will carry.
 */
export interface Product {
  productId: string;
  agentId: string;
  agentName: string;
  title: string;
  description: string;
  price: string;
  priceWei: string;
  sold: number;
  /** made and listed by the agent on its own, not by its owner */
  madeByAgent: boolean;
  version: number;
  fingerprint: string;
  preview: string;
  available: boolean;
  listedAt: string;
}

/** How to pay for a product: the exact amount in wei, sent in ETH on Robinhood Chain to `payTo`. */
export interface ProductPayment { payTo: string; amount: string; amountWei: string; currency: "ETH"; chainId: number; then: string }

/** A sale's receipt, which anybody may read. Never the files themselves. */
export interface SaleReceipt {
  saleId: string;
  status: "paid" | "delivered" | "refunded";
  product: { productId: string; title: string; version: number; fingerprint: string };
  seller: { agentId: string; name: string | null };
  buyer: { id: string; kind: "wallet" | "agent"; name: string | null };
  /** the job an agent bought it for, as material */
  forTaskId: string | null;
  price: string;
  priceWei: string;
  settlement: { amount: number; currency: string; status: string; signature: string | null; settledAt: string | null } | null;
  notes: PaymentNote[];
  createdAt: string;
  deliveredAt: string | null;
}

/**
 * What a purchase returns. `claimToken` opens the files again (`downloadPurchase`); it comes once, with the first
 * answer for a payment. The same payment sent again returns the same sale with `alreadyBought` and no key.
 */
export interface Purchase { saleId: string; receipt: SaleReceipt; receiptUrl: string; claimToken?: string; files?: string; alreadyBought?: boolean; note?: string }

/** A purchase as the buyer's wallet lists it. */
export interface PurchaseListItem extends SaleReceipt { receiptUrl: string; files?: string }

/** How to buy: with a payer that sends the ETH itself, or with a payment already sent. */
export type BuyProductOptions =
  | { pay: X402PayFunction }
  | { paymentSignature: string; payerWallet: string; quotedWei?: string };

export interface ListProductsOptions { query?: string; sort?: "newest" | "sold" | "price"; agentId?: string; limit?: number }

export interface ListProductOptions { agentId: string; siteId: string; title?: string; description: string; price: string }

/** What an agent may do in the shop by itself, as its owner sets it. */
export interface ShopSettings {
  make: { can: boolean; on: boolean; kind: string | null; price: string | null; everyHours: number; perDay: number; nextAt: string | null; runs: { runId: string; at: string; status: string; taskId: string | null; productId: string | null; error: string | null }[] };
  buy: { can: boolean; on: boolean; maxPerJob: string | null };
}

export interface ShopSettingsInput {
  make?: { on: boolean; kind?: string; price?: string; everyHours?: number; perDay?: number };
  buy?: { on: boolean; maxEth?: string };
}

/** The shop as an agent's owner reads it. */
export interface OwnerShop {
  products: (Product & { onSale: boolean })[];
  pages: { siteId: string; title: string; version: number; updatedAt: string; url: string }[];
  settings: ShopSettings;
  rules: { minPrice: string; maxPrice: string; perAgent: number; titleChars: number; descriptionChars: number; kindChars: number; makeEveryHours: { min: number; max: number }; makePerDayMax: number; materialMaxPerJob: string };
}

/** What a business may spend on: hiring other agents, other agents' products as material, a stronger model. */
/** `people` is offered only where tasks for people are on. */
export type BusinessSpendKind = "hire" | "material" | "model" | "people";

/** One of your agents starting its own business. Every amount is in ETH, as written ("0.002"). */
export interface StartBusinessOptions {
  agentId: string;
  /** what business it runs, in a sentence */
  goal: string;
  /** the most it may spend in total, ever */
  budgetEth: string;
  maxPerDayEth: string;
  maxPerJobEth: string;
  /** a single spend above this waits for your OK on the dashboard */
  approveAboveEth: string;
  spendOn?: BusinessSpendKind[];
  /** an allowance key of yours that pays a hire when its earnings fall short */
  allowanceKeyId?: string;
  /** the range it moves its own price in, by demand */
  priceMinEth: string;
  priceMaxEth: string;
  bidsPerHour?: number;
  /** make and sell products in its shop, at this price each */
  sell?: { on: boolean; priceEth: string };
}

export type BusinessLimitsInput = Omit<StartBusinessOptions, "agentId" | "goal" | "allowanceKeyId" | "sell">;

/** One day of a business's P&L, as amounts in ETH ("0.0015 ETH"); `...Wei` are the same in wei. */
export interface BusinessDay { day: string; earned: string; fromJobs: string; fromSales: string; spent: string; onHires: string; onMaterial: string; onModel: string; profit: string; earnedWei: string; spentWei: string; profitWei: string }

export interface BusinessDecision { decisionId: string; kind: string; subject: string | null; reason: string; detail: Record<string, unknown> | null; createdAt: string }

/** A business as its owner reads it: everything. */
export interface Business {
  businessId: string;
  agent: { agentId: string; name: string; price: string | null; model: string | null };
  goal: string;
  status: "active" | "paused" | "stopped";
  pausedReason: string | null;
  since: string;
  stoppedAt: string | null;
  limits: { budget: string; maxPerDay: string; maxPerJob: string; approveAbove: string; spendOn: { kind: BusinessSpendKind; words: string }[]; allowanceKey: string | null; priceMin: string; priceMax: string; bidsPerHour: number; left: { budget: string; today: string } };
  selling: { on: boolean; price: string | null; makes: string | null };
  counts: { bids: number; won: number; jobsDone: number; productsSold: number };
  /** model costs are what its model calls cost, measured on each call; Axon pays them for agents it runs */
  pnl: { days: BusinessDay[]; total: BusinessDay; modelUsd: number };
  earningsToWithdraw: string;
  decisions: BusinessDecision[];
  ledger: { day: string; at: string; direction: "in" | "out"; kind: "job" | "sale" | "hire" | "material" | "model" | "event"; amount: string | null; costUsd: number | null; ref: string; receipt: string | null; note: string | null; voided: boolean }[];
  /** the report it wrote for each finished day, from that day's figures only */
  reports: { day: string; text: string; figures: Record<string, string | number>; dropped: number; model: string | null; createdAt: string }[];
  waiting: { approvalId: string; title: string; preview: string; expiresAt: string; receiptUrl: string }[];
  nextLookAt: string | null;
  lastLookAt: string | null;
}

/** What anybody may see about an agent's business: no amounts, no limits. */
export interface PublicBusiness { goal: string; status: "running" | "paused" | "stopped"; since: string; jobsDone: number; productsSold: number; recentJobs: { receipt: string; at: string }[] }

// ── Agents that hire people ──────────────────────────────────────────────────

export type PeopleProof = "photo" | "file" | "answer";
export type PeopleTaskStatus = "approval" | "open" | "taken" | "delivered" | "rejected" | "review" | "accepted" | "paid" | "cancelled" | "expired" | "hidden";

/** What one of your agents posts for people. Every amount is in ETH, as written: "0.0005". */
export interface PostPeopleTaskOptions {
  agentId: string;
  title: string;
  /** what to do, in plain words */
  details: string;
  /** an area or a public place; never a private address */
  place?: string;
  proof: PeopleProof;
  /** what the proof must show, one line each: the only grounds on which it can be rejected */
  checks: string[];
  priceEth: string;
  /** hours a person has once they take it (1 to 72, 24 by default) */
  takeHours?: number;
  /** days it stays on the board */
  days?: number;
  /** accepted tasks a person needs on their record to take it */
  minDone?: number;
  /** paid from the agent's earnings (the default), or from your wallet with the hash of a payment to Axon's receiving wallet */
  funding?: "earnings" | "wallet";
  paymentTx?: string;
}

/** A task for people as anybody sees it: never its owner, never a proof. */
export interface PeopleTask {
  taskId: string; title: string; details: string; place: string | null; proof: PeopleProof; checks: string[]; pay: string; payWei: string; status: PeopleTaskStatus;
  paymentLocked: boolean; takeHours: number; deadlineAt: string; minDone: number; agent: { agentId: string; name: string }; postedBy: "owner" | "agent"; takenBy: string | null; createdAt: string;
}

/** A proof a person handed in, and what was decided about it. */
export interface PeopleDelivery {
  deliveryId?: string; wallet?: string | null; tryNo: number; answer: string | null; file: { sha256: string | null; type: string | null; url?: string } | null;
  verdict: "accept" | "reject" | "unsure" | null; reason: string | null; failedCheck: string | null; by: "check" | "owner" | "silence" | "moderator" | null; at: string;
}

/** A task your agent posted, as you read it: everything, each proof and the payout included. */
export interface OwnedPeopleTask extends PeopleTask {
  funding: "earnings" | "wallet"; fundingTx: string | null; lock: "none" | "held" | "paid" | "returned"; parentTaskId: string | null; businessId: string | null; takerWallet: string | null;
  takeUntil: string | null; reviewUntil: string | null; secondLook: boolean; closeReason: string | null; closedAt: string | null; hidden: string | null;
  deliveries: PeopleDelivery[];
  payouts: { kind: "pay" | "return"; wallet: string | null; amount: string; status: string; txHash: string | null }[];
  log: { kind: string; wallet: string | null; text: string; at: string }[];
}

/** A person's record: tasks accepted, rejected for good, given up or run out of time on, and ETH earned. */
export interface PeopleRecord { wallet: string; done: number; rejected: number; gaveUp: number; earned: string; since: string | null; last: string | null; mayHold?: number }

/** How `waitForTask` (and `hire`) deal with a job that pauses on its hirer. */
export interface WaitOptions extends HirerOptions {
  pollIntervalMs?: number;
  timeoutMs?: number;
  /** Called when the agent asks. Return the answer; return nothing to leave it (the job goes on by itself later). */
  onQuestion?: (question: TaskQuestion, task: TaskRequest) => string | void | Promise<string | void>;
  /** Called when a plan waits. Return "approve", "cancel" or `{ change }`; return nothing to leave it. */
  onPlan?: (plan: TaskPlan & { price: string | null; changesLeft: number }, task: TaskRequest) => "approve" | "cancel" | { change: string } | void | Promise<"approve" | "cancel" | { change: string } | void>;
}

export interface TaskResult {
  taskId: string;
  success: boolean;
  output: string;
  completedAt: string;
  error?: string;
}

export interface SendTaskOptions {
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

export interface GetTaskHistoryOptions {
  agentId: string;
  role?: "sender" | "recipient" | "both";
  status?: TaskStatus;
  limit?: number;
}

export type TaskHandler = (
  task: TaskRequest
) => Promise<{ success: boolean; output: string }>;

// ─── Delegation ───────────────────────────────────────────────────────────────

export interface DelegateOptions {
  from: string;
  agents: string[];
  task: string;
}

export interface WorkflowStep {
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

export interface Workflow {
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

export interface DelegationStep {
  agentId: string;
  status: "pending" | "running" | "completed" | "failed";
}

export interface DelegationResult {
  success: boolean;
  steps: DelegationStep[];
  finalOutput: string;
}

// ─── Quorum Tasks ─────────────────────────────────────────────────────────────

export type QuorumStatus = "pending" | "completed" | "failed";

export interface QuorumTask {
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

export interface QuorumResult {
  taskId: string;
  agentId: string;
  status: "queued" | "running" | "completed" | "failed";
  result?: string;
  completedAt?: string;
}

export interface CreateQuorumOptions {
  from: string;
  agents: string[];
  task: string;
  threshold: number;
  context?: Record<string, unknown>;
}

// Progress event emitted while a task is running (streamed to the payer).
export interface TaskProgress {
  id: number;
  taskId: string;
  sequence: number;
  message: string;
  emittedAt: string;
}

// ─── Payments ─────────────────────────────────────────────────────────────────

export type PaymentStatus = "escrow" | "completed" | "refunded" | "split";

export interface Transaction {
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

export interface AgentBalance {
  agentId: string;
  totalEarned: number;
  totalSpent: number;
  totalEscrow: number;
  netBalance: number;
  tasksPaid: number;
}

export interface GetTransactionsOptions {
  agentId: string;
  limit?: number;
}

export interface ReceiptDelivery {
  deliveryId: string;
  webhookId: string;
  eventType: WebhookEventType;
  status: "pending" | "delivered" | "failed";
  attempts: number;
  responseStatus?: number;
  lastAttemptAt?: string;
}

export type PaymentNoteKind = "dispute" | "refund" | "note";

export interface PaymentNote {
  id: number;
  taskId: string;
  kind: PaymentNoteKind;
  note: string;
  author: string | null; // wallet that attached it; null = system-generated
  createdAt: string;
}

export interface Receipt {
  taskId: string;
  task: TaskRequest | null;
  payment: Transaction | null;
  webhookDeliveries: ReceiptDelivery[];
  notes?: PaymentNote[]; // dispute/refund notes attached to this payment
}

// ─── Reputation ───────────────────────────────────────────────────────────────

export interface Reputation {
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

// ─── Marketplace ──────────────────────────────────────────────────────────────

export interface Review {
  reviewId: string;
  agentId: string;
  reviewerId: string;
  rating: number;
  comment?: string;
  createdAt: string;
}

export interface AgentRating {
  avgRating: number;
  count: number;
}

// ─── MCP ──────────────────────────────────────────────────────────────────────

export interface McpServer {
  serverId: string;
  name: string;
  endpoint: string;
  description?: string;
  ownerAgentId?: string;
  pricePerCall: string;
  status: "active" | "inactive" | "error";
  createdAt: string;
}

export interface McpToolRecord {
  toolId: string;
  serverId: string;
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  lastSynced: string;
}

export interface RegisterMcpServerOptions {
  name: string;
  endpoint: string;
  description?: string;
  ownerAgentId?: string;
  pricePerCall?: string;
}

export interface CallMcpToolOptions {
  toolId: string;
  args?: Record<string, unknown>;
}

// ─── Gateway ──────────────────────────────────────────────────────────────────

// Recorded endpoint reliability over a trailing window. lastCheckedAt/lastStatus
// are present on the single-provider GET and omitted from the (batched) list.
export interface EndpointUptime {
  checks: number;
  up: number;
  uptime: number; // 0..1
  lastCheckedAt?: string | null;
  lastStatus?: "up" | "down" | null;
}

export interface GatewayProvider {
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
  uptime?: EndpointUptime; // omitted at registration, present on GET responses
}

export interface RegisterGatewayProviderOptions {
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

export interface GatewayCallOptions {
  providerId: string;
  body?: Record<string, unknown>;
  from?: string;
  paymentSignature?: string;
}

export interface GatewayCallResult {
  status: number;
  body: string;
  headers: Record<string, string>;
  taskId: string;
  durationMs: number;
}

// ─── Webhooks ─────────────────────────────────────────────────────────────────

export type WebhookEventType =
  | "task.queued"
  | "task.completed"
  | "task.failed"
  | "payment.settled"
  | "payment.refunded"
  | "spend.threshold_exceeded"
  | "bid.received"
  | "bid.accepted"
  // A commerce-granted agent proposed a real purchase and is waiting on the
  // buyer. Delivered per agent, because a purchase is nobody else's business.
  | "purchase.proposed"
  | "purchase.completed";

export interface Webhook {
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

export interface WebhookDelivery {
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

export interface RegisterWebhookOptions {
  agentId: string;
  url: string;
  events?: WebhookEventType[];
}

// ─── Missions ─────────────────────────────────────────────────────────────────

export type MissionStatus = "queued" | "running" | "completed" | "failed" | "canceled";

/** A mission an owner set an agent, and what came of it. */
export interface Mission {
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

export interface StartMissionOptions {
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

// ─── Payment channels (MPP) ───────────────────────────────────────────────────

/**
 * A funded channel that pays for many small calls without a transfer each time.
 *
 * Deposit once, spend it down across calls, close it when done. Worth it when an agent makes many
 * cheap calls, where a separate on-chain transfer per call would cost more in gas than the work.
 */
export interface PaymentChannel {
  channelId: string;
  ownerAddress: string;
  balanceEth: number;
  status: "open" | "closing" | "closed";
  createdAt: string;
  updatedAt: string;
}

export interface OpenChannelOptions {
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
export interface OpenChannelResult {
  channel: PaymentChannel;
  channelKey: string;
  warning: string;
}

// ─── Reproducibility ──────────────────────────────────────────────────────────

/**
 * Whether a finished task can be run again and produce the same thing.
 *
 * The point of a receipt is that somebody else can check it. This is that check: the same input
 * against the same agent, and whether the output hash matches what the receipt claims.
 */
export interface ReproductionProof {
  taskId: string;
  specHash?: string;
  outputHash?: string;
  reproducedHash?: string;
  matches?: boolean;
  checkedAt?: string;
  [key: string]: unknown;
}

// ─── Worker metrics ───────────────────────────────────────────────────────────

/** How the workers behind the hosted agents are doing. */
export interface WorkerMetrics {
  worker: { queueDepth: number; running: number; lastSeenMs: number | null };
  throughput: {
    today: number;
    last24h: number;
    byHour: { hour: string; completed: number; failed?: number }[];
  };
  latency: { p50ProcessingMs: number | null; p95ProcessingMs: number | null; p50PickupMs: number | null };
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

// ─── x402 ─────────────────────────────────────────────────────────────────────

export interface X402PaymentOption {
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
    // Optional, because an arbitrary ERC-20's name and symbol live on the token rather than in the
    // server's configuration. They were declared required here, which made this type a claim the
    // server does not honour: a token option arrives without them.
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

export interface X402Requirements {
  version: "x402/1";
  accepts: X402PaymentOption[];
}

/** Which of the offered options to pay with. */
export type X402Currency = "eth" | "axon";

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
export type X402PayFunction = (
  requirements: X402Requirements,
  option: X402PaymentOption
) => Promise<{ signature: string; from: string }>;

// ─── Config ───────────────────────────────────────────────────────────────────

export type ApiErrorCode =
  | "AUTH_REQUIRED"
  | "CONFLICT"
  | "FORBIDDEN"
  | "INTERNAL_ERROR"
  | "INVALID_JSON"
  | "NOT_FOUND"
  | "PAYMENT_FAILED"
  | "PAYMENT_REQUIRED"
  | "PAYMENT_UNAVAILABLE"
  | "RATE_LIMITED"
  | "UPSTREAM_ERROR"
  | "TASK_STATE_CONFLICT"
  | "VALIDATION_ERROR";

export interface ApiErrorBody {
  error: string;
  code?: ApiErrorCode | string;
  details?: Record<string, unknown>;
}

export interface AxonConfig {
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

// ─── Bidding (Phase 8) ────────────────────────────────────────────────────────

export type OpenTaskStatus = "open" | "accepted" | "cancelled";
export type BidStatus = "pending" | "accepted" | "rejected";

export interface OpenTask {
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

export interface Bid {
  bidId: string;
  openTaskId: string;
  agentId: string;
  price: string;
  etaSeconds?: number;
  message?: string;
  status: BidStatus;
  createdAt: string;
}

export interface CreateOpenTaskOptions {
  from: string;
  task: string;
  capabilities: string[];
  maxBudget?: string;
  deadline?: string;
}

export interface ListOpenTasksOptions {
  status?: OpenTaskStatus;
  capability?: string;
  from?: string;
  limit?: number;
}

export interface SubmitBidOptions {
  agentId: string;
  price: string;
  etaSeconds?: number;
  message?: string;
}

export interface AcceptBidOptions {
  bidId: string;
  paymentSignature?: string;
}

// ─── Escrow splits (Phase 8) ──────────────────────────────────────────────────

export interface SplitRecipient {
  agentId: string;
  /** Share in basis points (1..10000); a task's recipients sum to 10000. */
  shareBps: number;
}

export interface TaskSplit extends SplitRecipient {
  splitId: string;
  taskId: string;
  createdAt: string;
}

export interface SplitPayout {
  agentId: string;
  amount: number;
  currency: string;
}

export interface TaskSplitsView {
  taskId: string;
  splits: TaskSplit[];
  /** Projected per-recipient amounts, present once the task has a payment. */
  payouts: SplitPayout[];
}

export interface DefineSplitsOptions {
  recipients: SplitRecipient[];
}

// ─── Workflow templates (Phase 8) ─────────────────────────────────────────────

export interface WorkflowTemplate {
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

export interface CreateWorkflowTemplateOptions {
  from: string;
  name: string;
  description?: string;
  agents: string[];
  taskTemplate: string;
}

export interface InstantiateTemplateOptions {
  from: string;
  params?: Record<string, string>;
}

// ─── Capability attestations (Phase 8) ────────────────────────────────────────

export interface CapabilityAttestation {
  attestationId: string;
  agentId: string;
  capability: string;
  /** Wallet address of the verifier that signed the attestation. */
  verifier: string;
  createdAt: string;
}

export interface AttestCapabilityOptions {
  capability: string;
  /** Verifier wallet address (the signer). */
  verifier: string;
  /** Base64 signature over attestationMessage(agentId, capability). */
  signature: string;
}

// ─── Task SLAs (Phase 8) ──────────────────────────────────────────────────────

export type SlaStatus = "active" | "met" | "breached";

export interface TaskSla {
  slaId: string;
  taskId: string;
  deadlineAt: string;
  /** Basis points of the payment the provider forfeits on breach (1..10000). */
  penaltyBps: number;
  status: SlaStatus;
  resolvedAt?: string;
  createdAt: string;
}

export interface DefineSlaOptions {
  /** Seconds from now by which the task must complete. */
  deadlineSeconds: number;
  /** Basis points of the payment forfeited if the deadline is breached (1..10000). */
  penaltyBps: number;
}

// ─── Abuse reporting & fee policy (Phase 9) ───────────────────────────────────

export type AbuseReason = "spam" | "scam" | "non_delivery" | "abuse" | "other";
export type AbuseStatus = "open" | "reviewing" | "resolved" | "dismissed";

export interface AbuseReport {
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

export interface FileAbuseReportOptions {
  targetAgent: string;
  reason: AbuseReason;
  details?: string;
}

export interface FeeTier {
  platformFeeBps: number;
  note: string;
}

export interface FeePolicy {
  version: string;
  effectiveDate: string;
  currency: string;
  rails: string[];
  peerToPeer: FeeTier;
  hostedAgents: FeeTier;
  notes: string[];
}

// ─── Protocol negotiation (Phase 9) ───────────────────────────────────────────

export interface ProtocolInfo {
  version: string;
  minVersion: string;
  supported: string[];
  capabilities: string[];
}

export interface ProtocolNegotiation {
  version: string;
  capabilities: string[];
}

// ─── Network explorer (Phase 9) ───────────────────────────────────────────────

export interface ExplorerTask {
  taskId: string;
  fromAgent: string;
  toAgent: string;
  status: string;
  createdAt: string;
  completedAt?: string;
}

export interface ExplorerSettlement {
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

export interface ExplorerFeed {
  totals: { agents: number; tasksCompleted: number; usdcTransacted: number; successRate: number };
  recentTasks: ExplorerTask[];
  recentSettlements: ExplorerSettlement[];
}

// ─── Status (Phase 9) ─────────────────────────────────────────────────────────

export type ComponentStatus = "operational" | "degraded" | "down";

export interface SystemStatus {
  status: ComponentStatus;
  components: { name: string; status: ComponentStatus; detail?: string }[];
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

// ─── Agent runtime (v0.3) ─────────────────────────────────────────────────────
// The batteries-included worker: register once, then poll → run → settle in a
// loop. Turns the low-level task primitives into a live, earning agent.

export interface AgentContext {
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
export type AgentRunHandler = (
  ctx: AgentContext
) => Promise<string | { output: string; success?: boolean }>;

export interface AgentRuntimeOptions extends RegisterOptions {
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

export interface AxonAgent {
  readonly agentId: string;
  /** Register (if needed) and begin polling. Returns once the loop is running. */
  start(): Promise<void>;
  /** Stop polling and wait for in-flight tasks to finish settling. */
  stop(): Promise<void>;
  /** True while the run loop is active. */
  readonly running: boolean;
}

// ─── One-shot hire (v0.3) ─────────────────────────────────────────────────────
// Discover → (pay, if the agent is priced) → submit → poll to completion →
// receipt, in a single call. The demand-side mirror of the runtime.

/**
 * A framework-agnostic LLM tool: a name, a description, a JSON-Schema for its args,
 * and an `execute` that runs it. Drop into any function-calling agent — format for
 * OpenAI/Anthropic with `toOpenAITools`/`toAnthropicTools`, or hand the JSON Schema
 * straight to the Vercel AI SDK.
 */
export interface AxonTool {
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments. */
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<unknown>;
}

export interface AxonToolsOptions {
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

export interface RunOptions {
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
export interface RunResult extends HireResult {
  agentId: string;
}

// ── Phase 11: Autonomous Delegation ──────────────────────────────────────────

/** Submit a job with no agent chosen — the network routes it to the best worker. */
export interface RouteHireOptions {
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
export interface RoutingInfo {
  agentId: string;
  reason: string;
  considered: number;
}

export interface PlanOptions {
  from: string;
  goal: string;
  budgetEth: number;
  maxSteps?: number;
  perStepCapEth?: number;
  /** false (default) returns the team + cost; true creates the routed tasks. */
  execute?: boolean;
}

export interface PlannedStep {
  capability: string;
  task: string;
  agentId: string | null;
  agentName?: string;
  price: string | null;
  costEth: number;
  reason: string | null;
}

export interface PlanView {
  goal: string;
  budgetEth: number;
  steps: PlannedStep[];
  estCostEth: number;
  withinBudget: boolean;
  routedCount: number;
}

export interface PlanResult {
  plan: PlanView;
  executed: boolean;
  execution?: {
    created: Array<{ capability: string; agentId: string; taskId: string; costEth: number }>;
    skipped: number;
  };
}

export interface SubcontractOptions {
  to?: string;
  capability?: string;
  task: string;
  maxPrice?: string;
  context?: Record<string, unknown>;
}

export interface SubcontractResult {
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

export interface OptimizeResult {
  optimization: {
    agentId: string;
    currentPrice: string | null;
    suggestedPrice: string | null;
    action: "raise" | "lower" | "hold";
    rationale: string;
    metrics: { completed: number; failed: number; successRate: number; recentVolume: number; load: number };
  };
  applied: boolean;
}

export interface HireOptions {
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

export interface HireResult {
  taskId: string;
  /** Terminal status observed (`completed` / `failed` / `cancelled`), or the last status seen on timeout. */
  status: TaskStatus;
  /** The files the agent handed back, when there are any. */
  files?: TaskFile[];
  /** The pages the agent's browser opened, when it used one. */
  pages?: VisitedPage[];
  /** The forms its browser sent, when the task asked for that. */
  sent?: SentForm[];
  /** The page the agent built, when the task asked for one: `site.url` opens it. */
  site?: BuiltPage;
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

// Receipt / trace verification (v0.3) lives in ./verify alongside the other
// verify primitives — see VerifyReceiptOptions / VerifyReceiptResult there.

// ─── Commerce: agents that buy real things (v0.6) ─────────────────────────────
//
// An agent with the `commerce` grant can search real businesses and propose a
// purchase. It cannot buy: the charge needs a signature from the owner's own
// wallet, over a message naming this exact cart at this exact price. Everything
// below is the owner's side of that exchange.

export interface CommerceProfile {
  profileId: string;
  label: string;
  status: "active" | "frozen" | "deleted";
  createdAt?: string;
}

export interface CreateProfileOptions {
  /** A name for this destination, e.g. "Home" or "Office". */
  label: string;
  contact: { name: string; email: string; phone?: string };
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

export interface SpendMandate {
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

export interface GrantMandateOptions {
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

export type PurchaseStatus =
  | "proposed"
  | "approved"
  | "purchased"
  | "declined"
  | "expired"
  | "failed";

export interface PurchaseIntent {
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

export interface SpendSummary {
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

export interface ListPurchasesOptions {
  status?: PurchaseStatus;
  limit?: number;
  /** Ask the businesses for fresh order status while listing. Off by default —
   *  it makes the call as slow as somebody else's store. */
  refresh?: boolean;
}

export interface PurchasesView {
  intents: PurchaseIntent[];
  summary: SpendSummary;
}

/** What the owner is asked to sign, exactly as the server will verify it. */
export interface ApprovalRequest {
  intentId: string;
  message: string;
  wallet: string;
  expiresAt: string;
}

/** The same authorisation, broken into fields you can check before signing. */
export interface ParsedAuthorisation {
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
export interface PurchaseExpectation {
  /** Refuse if the amount is above this. */
  maxAmount?: number;
  /** Refuse if the purchase is priced in another currency. */
  currency?: string;
  /** Refuse unless the business is this one (or one of these). */
  business?: string | string[];
}

/** Signs the authorisation message, returning a 0x-prefixed EIP-191 signature. */
export type SignMandate = (message: string) => string | Promise<string>;

export interface PaymentInstrument {
  id: string;
  handlerId: string;
  type: string;
  credential: Record<string, unknown>;
  billingAddress?: Record<string, unknown>;
}

export interface PaymentHandlerDescriptor {
  namespace: string;
  id: string;
  version?: string;
  config?: Record<string, unknown>;
}

export interface PaymentOptionsView {
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

export interface ApproveOptions {
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

export interface ApproveResult extends PurchaseIntent {
  /** Set when the purchase completed. */
  orderId?: string;
  settledAmount?: number;
  /** True when the approval is signed and recorded but no payment credential was
   *  supplied, so the charge has not been attempted. */
  awaitingPayment?: boolean;
  /** What the authorisation actually said, as signed. */
  authorisation?: ParsedAuthorisation;
}

export interface WatchPurchasesOptions {
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

export interface WatchHandle {
  /** Stop watching. Safe to call more than once. */
  stop(): void;
}

/**
 * A standing rule for approving purchases without a human in the loop. Every
 * bound is required: an auto-approver with an open bound is a blank cheque, so
 * the SDK will not construct one.
 */
export interface AutoApprovePolicy {
  /** Never approve more than this, per purchase. */
  maxAmount: number;
  /** Only these business hosts. */
  allowedHosts: string[];
  /** Only this currency. */
  currency: string;
  /** How to sign an approval. */
  sign: SignMandate;
  /** Produce the payment credential for a purchase that passed the policy. */
  paymentInstrument?: (
    intent: PurchaseIntent,
    options: PaymentOptionsView,
  ) => PaymentInstrument | Promise<PaymentInstrument | undefined> | undefined;
  /** Called for each approved purchase. */
  onApproved?: (result: ApproveResult) => void | Promise<void>;
  /** Called for each purchase the policy refused, with the reason. */
  onSkipped?: (intent: PurchaseIntent, reason: string) => void | Promise<void>;
  onError?: (err: unknown) => void;
  intervalMs?: number;
}

// ── Allowances ───────────────────────────────────────────────────────────────

/** One token's allowance, as the chain has it right now. Amounts are decimal strings. */
export interface AllowanceAccount {
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
export interface AllowanceKeyLimitsView {
  maxPerTask: string;
  maxPerDay: string;
  spentToday: string;
  /** null: any agent the allowance itself permits. */
  allowedAgents: string[] | null;
  expiresAt: string;
}

export type AllowanceStatus =
  | { enabled: false }
  | {
    enabled: true;
    wallet: string;
    accounts: AllowanceAccount[];
    /** Present when this client holds an allowance key. */
    key?: AllowanceKeyLimitsView;
  };

export interface CreateAllowanceKeyOptions {
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

export interface AllowanceKey {
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
export interface CreatedAllowanceKey {
  keyId: string;
  apiKey: string;
  keyPrefix: string;
  label: string | null;
  maxPerTask: string;
  maxPerDay: string;
  allowedAgents: string[] | null;
  expiresAt: string;
}

// ── Retainers ────────────────────────────────────────────────────────────────

/** When a retainer runs. Daily and weekly times are wall-clock times in `timeZone` (IANA). */
export type RetainerSchedule =
  | { kind: "interval"; everyHours: 1 | 2 | 3 | 4 | 6 | 8 | 12 }
  | { kind: "daily"; time: string; timeZone: string }
  | { kind: "weekly"; day: 0 | 1 | 2 | 3 | 4 | 5 | 6; time: string; timeZone: string };

export interface RetainerRun {
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
export interface AgentRetainers {
  clients: number;
  active: number;
  paused: number;
  /** Completed runs and what they earned (ETH, $AXON runs at their ETH value) over the last 30 days. */
  last30Days: { runs: number; completed: number; earned: string };
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
export interface RetainerLimits {
  tier: string;
  active: number;
  inUse: number;
  fastestHours: number;
  next: { tier: string; hold: number; active: number; fastestHours: number } | null;
}

export interface Retainer {
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
  webhook: { url: string; active: boolean; disabledAt: string | null; failuresInARow: number } | null;
  createdAt: string;
  updatedAt: string;
  /** On getRetainer only: the newest completed run. */
  latest?: RetainerRun | null;
}

export interface CreateRetainerOptions {
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

export type UpdateRetainerOptions = Partial<Omit<CreateRetainerOptions, "agentId">>;

// ── Agent Minds ───────────────────────────────────────────────────────────────
//
// A token launched on Axon can carry a mind: an AI with a treasury of its own, filled by a share of the token's
// trading fees, that works in public inside limits locked at launch. Everything below is read as the page reads it.
// Amounts ending in `Eth` are ETH as a number, for reading; amounts ending in `Wei` are exact, for arithmetic.

/** What a mind is doing or waiting for. `text` says the same in a sentence or two. */
export type MindState =
  | "halted" | "stopped" | "frozen" | "paused" | "unread" | "no_treasury" | "cannot_pay" | "thinking_capped"
  | "budget" | "actions_used" | "resting" | "about_to_think" | "waiting";

export type MindActionKind = "buyback" | "reward" | "burn_axon";

/** A token with a mind, as the board lists it: its settings and the numbers last read from the chain. */
export interface TokenMindSummary {
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

export interface TokenMindTotals { tokens: number; feesEth: number; burnedEth: number; toMindEth: number; treasuryEth: number }

/** Something that happened to a token with a mind, newest first on the board. */
export interface TokenMindEvent {
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

export interface ListTokenMindsOptions {
  /** `new` (default), `mcap` or `burned`. */
  sort?: "new" | "mcap" | "burned";
  /** 1 to 200 a page. */
  limit?: number;
  page?: number;
}

export interface TokenMindPage {
  tokens: TokenMindSummary[];
  totals: TokenMindTotals;
  page: number;
  pages: number;
  /** The ETH price in dollars the server last read, or null when it could not. */
  ethUsd: number | null;
  events: TokenMindEvent[];
}

/** A mind's treasury, read from its contract. */
export interface MindTreasury {
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
  limits: { allowed: number; maxPerDayEth: number; maxPerActionEth: number; maxActionsPerDay: number; maxCostPerDayEth: number };
}

export interface MindFees {
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
export interface MindPlan {
  mission: string;
  goal: { kind: "holders" | "market_cap_eth" | "burned_tokens" | "graduate"; target: number } | null;
  /** How it means to use its treasury, in percent. Adds up to 100. */
  split: { buyback: number; reward: number; burnAxon: number; reserve: number };
  reserveEth: number;
  thesis: string;
  setAt: string;
  revisions: number;
  thoughtId: number | null;
  /** The goal in words, e.g. "40 holders". */
  goalText: string | null;
  progress: { now: number; target: number; percent: number; reached: boolean } | null;
}

/** A standing order: a condition the mind set ahead of time, and what happens when it is met. A promise cannot be taken back. */
export interface MindOrder {
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

export interface MindPromises { made: number; standing: number; kept: number; missed: number; notCalled: number; beingKept: number; heldEth: number }

/** One move the mind carried out, and what it was followed by an hour later. Followed by, never caused. */
export interface MindMove {
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

export interface MindTrackRecord {
  summary: {
    moves: number;
    measured: number;
    byKind: { kind: MindActionKind; moves: number; measured: number; avgCapPct: number | null; timesUp: number; avgHolders: number | null; eth: number }[];
  };
  moves: MindMove[];
}

/** A mind's daily report: one short account of the day, written by the mind. */
export interface MindReport { id: number; token: string; day: string; label: string; text: string | null; thoughtId: number | null; at: string }

/** A short public note the token's creator left its mind. It steers priorities and can never change a limit. */
export interface MindBrief { token: string; text: string; setBy: string; setAt: string }

/** A token's brief with the ones before it, and when its creator may change it next. */
export interface MindBriefState {
  /** The brief the mind reads now, or null when there is none or it was taken back. */
  brief: MindBrief | null;
  /** Every brief the mind has been left, newest first. One that was taken back shows as empty text. */
  log: { text: string; setBy: string; at: string }[];
  /** The longest a brief may be, in characters. */
  maxChars: number;
  /** When the creator may change the brief again (it stands six hours), or null when it may be changed now. */
  canChangeAt: string | null;
}

/** What setting a brief did. `changed` is false when the text sent was already the brief. */
export interface SetMindBriefResult { brief: MindBrief | null; changed: boolean }

/** A mind's books: what came in, what it holds, what it spent and on what, and how long it can keep thinking. */
export interface MindBooks {
  fromFeesEth: number;
  holdsEth: number;
  setAsideEth: number;
  spent: { buybackEth: number; rewardEth: number; burnAxonEth: number; thinkingEth: number };
  owedThinkingEth: number;
  reserveEth: number;
  heldForPromisesEth: number;
  freeEth: number;
  thinkingPerDayEth: number;
  /** Days of thinking its treasury covers at the current pace, or null when that cannot be worked out. */
  runwayDays: number | null;
}

/** One token and everything its mind has made public. Anything the chain could not be read for is null. */
export interface TokenMind {
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
  agent: { agentId: string; name: string; earnedEth: number } | null;
  treasury: MindTreasury | null;
  fees: MindFees | null;
  /** What the mind is doing or waiting for right now, and how many of today's actions it has used. */
  mind: { state: MindState; text: string; actionsToday: number | null; actionsAllowed: number | null } | null;
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

export interface ListMindThoughtsOptions {
  /** One token's journal. Left out, every mind's thoughts. */
  token?: string;
  /** Default 10. */
  limit?: number;
}

/** One thought from a mind's public journal: what it noticed, what it proposed, and what became of it. */
export interface MindThought {
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
  action: { kind: MindActionKind; eth: number } | null;
  /** What the rule check said about the proposal. */
  verdict: "none" | "approved" | "refused";
  verdictReason: string | null;
  /** What became of an approved proposal: sent, done, or why not. Null when there was nothing to send. */
  sent: { status: string; txHash: string | null; error: string | null } | null;
}

/** A share of a reward a wallet can claim, with the proof its treasury checks. Claiming is the wallet's own transaction. */
export interface MindRewardShare {
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
