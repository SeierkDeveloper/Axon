// Outside policy checks on Allowances.
//
// A wallet with an allowance can link an outside policy provider (AUREON is the first). Before Axon reserves from
// that allowance for a hire, it asks the provider about it and gets one of three answers:
//
//   allow                    the hire goes on
//   refuse                   the hire stops, and the provider's reason is shown
//   authorization_required   the hire stops, and the user is told it needs their approval first
//
// What this can and cannot do:
//   - It can only make a spend stricter. The allowance's on-chain limits apply to every hire whatever the provider
//     says, and the provider never holds funds, signs anything or sees a key of ours.
//   - It is off for everyone who has not linked a provider.
//   - A provider that does not answer within two seconds does not hold a hire up: the hire goes on under the
//     wallet's own on-chain limits. Only an answer stops a hire.
//   - POLICY_CHECKS=off (the default) switches the whole thing off: no provider is called and nothing is stopped.
//
// A provider is a slot: `PROVIDERS` is the list, and each one knows how to ask its own API.

import { getDb } from "./db";
import { encrypt, decrypt } from "./crypto";
import { logger } from "./logger";

/** How long a provider has to answer before the hire goes on without it. */
export const POLICY_TIMEOUT_MS = 2_000;

export function policyChecksEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.POLICY_CHECKS ?? "off").trim().toLowerCase() === "on";
}

export type PolicyDecision = "allow" | "refuse" | "authorization_required";
/** A decision, or: the provider rejected the link itself, or it gave no usable answer in time. */
export type PolicyOutcome = PolicyDecision | "not_recognised" | "unavailable";

export interface PolicyHire {
  owner: string;
  taskId: string;
  fromAgent: string;
  toAgent: string;
  asset: "ETH" | "AXON";
  /** What the hire costs in that asset, as a decimal. */
  amount: string;
}

interface ProviderAnswer { outcome: PolicyOutcome; reason: string | null; actionId: string | null }

interface PolicyProvider {
  id: string;
  name: string;
  /** Why this key or objective cannot be one of this provider's, or null. */
  keyError(apiKey: string): string | null;
  objectiveError(objectiveId: string): string | null;
  /** Is the key one the provider knows? False only when it says so; anything unclear counts as yes. */
  keyAccepted(apiKey: string, signal: AbortSignal): Promise<boolean>;
  check(link: { apiKey: string; objectiveId: string }, hire: PolicyHire, signal: AbortSignal): Promise<ProviderAnswer>;
}

/** A provider's words end up on our pages and in what an assistant reads: one line, printable, and short. */
export function cleanReason(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
  return text || null;
}

const aureonBase = (): string => (process.env.AUREON_API_URL?.trim() || "https://api.aureonlabs.network").replace(/\/+$/, "");

const aureon: PolicyProvider = {
  id: "aureon",
  name: "AUREON",
  keyError: (k) => (/^aureon_[A-Za-z0-9]{16,128}$/.test(k) ? null : "That does not look like an AUREON API key. It starts with aureon_"),
  objectiveError: (o) => (/^obj_[A-Za-z0-9]{8,64}$/.test(o) ? null : "That does not look like an AUREON objective ID. It starts with obj_"),

  async keyAccepted(apiKey, signal) {
    // There is no call that only checks a key, so read a decision that does not exist: an unknown key is turned
    // away before the lookup, and a known one is told the decision is not there.
    const res = await fetch(`${aureonBase()}/v1/policy/checks/act_axon_link`, { headers: { "X-Aureon-Api-Key": apiKey }, signal, redirect: "error" });
    return res.status !== 401 && res.status !== 403;
  },

  async check(link, hire, signal) {
    const res = await fetch(`${aureonBase()}/v1/policy/check`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Aureon-Api-Key": link.apiKey },
      body: JSON.stringify({
        agentId: hire.fromAgent,
        taskId: hire.taskId,
        objectiveId: link.objectiveId,
        action: { type: "hire", asset: hire.asset, amount: hire.amount, agent: hire.toAgent },
      }),
      signal,
      // The request carries the user's key: it goes to the host we named and nowhere it is sent on to.
      redirect: "error",
    });
    const body = (await res.json().catch(() => null)) as { decision?: unknown; reason?: unknown; actionId?: unknown; message?: unknown } | null;
    if (res.status === 401 || res.status === 403 || res.status === 404) {
      return { outcome: "not_recognised", reason: cleanReason(body?.message) ?? (res.status === 404 ? "Objective not found" : "Invalid API key"), actionId: null };
    }
    const decision = body?.decision;
    if (res.status === 200 && (decision === "allow" || decision === "refuse" || decision === "authorization_required")) {
      return { outcome: decision, reason: cleanReason(body?.reason), actionId: cleanReason(body?.actionId)?.slice(0, 80) ?? null };
    }
    return { outcome: "unavailable", reason: `HTTP ${res.status}`, actionId: null };
  },
};

const PROVIDERS: Record<string, PolicyProvider> = { aureon };

export const policyProviders = (): { id: string; name: string }[] => Object.values(PROVIDERS).map((p) => ({ id: p.id, name: p.name }));

// ── The link ──────────────────────────────────────────────────────────────────

export interface PolicyLink { provider: string; providerName: string; objectiveId: string; keyHint: string; linkedAt: string }

interface LinkRow { owner: string; provider: string; objective_id: string; key_enc: string; key_hint: string; created_at: string; updated_at: string }
const linkRow = (owner: string): LinkRow | undefined =>
  getDb().prepare("SELECT * FROM allowance_policy_links WHERE owner = ?").get(owner.toLowerCase()) as LinkRow | undefined;

/** The provider a wallet has linked, without its key. */
export function policyLinkOf(owner: string): PolicyLink | null {
  const r = linkRow(owner);
  return r ? { provider: r.provider, providerName: PROVIDERS[r.provider]?.name ?? r.provider, objectiveId: r.objective_id, keyHint: r.key_hint, linkedAt: r.updated_at } : null;
}

export class PolicyLinkError extends Error {
  constructor(message: string, readonly status: 400 | 503 = 400) { super(message); this.name = "PolicyLinkError"; }
}

/** Link a wallet's allowance to a provider, replacing any link it had. The key is stored encrypted. */
export async function linkPolicy(owner: string, input: { provider?: unknown; apiKey?: unknown; objectiveId?: unknown }): Promise<PolicyLink> {
  if (!policyChecksEnabled()) throw new PolicyLinkError("Policy checks are not available right now", 503);
  const provider = PROVIDERS[typeof input.provider === "string" ? input.provider.trim().toLowerCase() : ""];
  if (!provider) throw new PolicyLinkError(`provider must be one of: ${Object.keys(PROVIDERS).join(", ")}`);
  const apiKey = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
  const objectiveId = typeof input.objectiveId === "string" ? input.objectiveId.trim() : "";
  const problem = provider.keyError(apiKey) ?? provider.objectiveError(objectiveId);
  if (problem) throw new PolicyLinkError(problem);

  // Turn a wrong key away now, while the person is looking, not at the first hire. If the provider cannot be
  // reached the link is still saved: it is checked on every hire anyway.
  const accepted = await provider.keyAccepted(apiKey, AbortSignal.timeout(POLICY_TIMEOUT_MS * 2)).catch(() => true);
  if (!accepted) throw new PolicyLinkError(`${provider.name} did not accept that API key`);

  const now = new Date().toISOString();
  getDb().prepare(`INSERT INTO allowance_policy_links (owner, provider, objective_id, key_enc, key_hint, created_at, updated_at) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(owner) DO UPDATE SET provider = excluded.provider, objective_id = excluded.objective_id, key_enc = excluded.key_enc, key_hint = excluded.key_hint, updated_at = excluded.updated_at`)
    .run(owner.toLowerCase(), provider.id, objectiveId, encrypt(apiKey), apiKey.slice(-4), now, now);
  logger.info("policy.linked", "A wallet linked a policy provider", { owner: owner.toLowerCase(), provider: provider.id });
  return policyLinkOf(owner)!;
}

/** Remove a wallet's link. Its hires go back to the allowance's own limits alone. */
export function unlinkPolicy(owner: string): boolean {
  const removed = getDb().prepare("DELETE FROM allowance_policy_links WHERE owner = ?").run(owner.toLowerCase()).changes > 0;
  if (removed) logger.info("policy.unlinked", "A wallet removed its policy provider", { owner: owner.toLowerCase() });
  return removed;
}

// ── The check ─────────────────────────────────────────────────────────────────

export interface PolicyCheckRecord {
  id: number; provider: string; objectiveId: string; taskId: string; toAgent: string; asset: string; amount: string;
  outcome: PolicyOutcome; reason: string | null; actionId: string | null; ms: number; at: string;
}

/** A wallet's latest policy answers, newest first. */
export function recentPolicyChecks(owner: string, limit = 10): PolicyCheckRecord[] {
  return (getDb().prepare("SELECT id, provider, objective_id, task_id, to_agent, asset, amount, outcome, reason, action_id, ms, at FROM allowance_policy_checks WHERE owner = ? ORDER BY id DESC LIMIT ?")
    .all(owner.toLowerCase(), Math.min(50, Math.max(1, limit))) as Record<string, unknown>[]).map((r) => ({
    id: Number(r.id), provider: String(r.provider), objectiveId: String(r.objective_id), taskId: String(r.task_id), toAgent: String(r.to_agent), asset: String(r.asset), amount: String(r.amount),
    outcome: r.outcome as PolicyOutcome, reason: (r.reason as string | null) ?? null, actionId: (r.action_id as string | null) ?? null, ms: Number(r.ms), at: String(r.at),
  }));
}

/**
 * Ask the wallet's policy provider about a hire, if it has linked one. Returns the words to stop the hire with, or
 * null when it goes on. Never throws: whatever goes wrong in here, the hire carries on under the allowance's own
 * limits, which were checked before this and are enforced by the contract after it.
 */
export async function policyGate(hire: PolicyHire): Promise<string | null> {
  try {
    if (!policyChecksEnabled()) return null;
    const row = linkRow(hire.owner);
    if (!row) return null;
    const provider = PROVIDERS[row.provider];
    if (!provider) return null;

    const started = Date.now();
    let answer: ProviderAnswer;
    try {
      answer = await provider.check({ apiKey: decrypt(row.key_enc), objectiveId: row.objective_id }, hire, AbortSignal.timeout(POLICY_TIMEOUT_MS));
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      answer = { outcome: "unavailable", reason: timedOut ? `No answer within ${POLICY_TIMEOUT_MS / 1000} seconds` : "Could not be reached", actionId: null };
    }
    const ms = Date.now() - started;

    getDb().prepare("INSERT INTO allowance_policy_checks (owner, provider, objective_id, task_id, to_agent, asset, amount, outcome, reason, action_id, ms, at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(hire.owner.toLowerCase(), provider.id, row.objective_id, hire.taskId, hire.toAgent, hire.asset, hire.amount, answer.outcome, answer.reason, answer.actionId, ms, new Date().toISOString());
    logger.info("policy.checked", "Policy provider asked about a hire", { taskId: hire.taskId, provider: provider.id, outcome: answer.outcome, ms });

    const why = answer.reason ? ` ${/[.!?]$/.test(answer.reason) ? answer.reason : `${answer.reason}.`}` : "";
    if (answer.outcome === "refuse") return `${provider.name} refused this hire:${why || " no reason given."} Nothing was charged.`;
    if (answer.outcome === "authorization_required") return `${provider.name} says this hire needs your approval first:${why || " no reason given."} Nothing was charged.`;
    if (answer.outcome === "not_recognised") return `${provider.name} does not recognise this policy link:${why || " no reason given."} Fix it or remove it under Allowance on your dashboard. Nothing was charged.`;
    return null;
  } catch (err) {
    logger.error("policy.gate_failed", "The policy check failed on our side; the hire goes on under its own limits", { taskId: hire.taskId, err: err instanceof Error ? err.message : String(err) });
    return null;
  }
}
