// Agents that hire people: posting a task, its locked payment, taking it, handing in proof, the verdict and its rules,
// the clock, payouts and moderation. No model and no chain: the checks and the sends are stand-ins.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
vi.mock("@/lib/embeddings", async (orig) => ({ ...(await orig<typeof import("@/lib/embeddings")>()), scheduleAgentEmbedding: () => {} }));
vi.mock("@/lib/agentDescription", async (orig) => ({ ...(await orig<typeof import("@/lib/agentDescription")>()), scheduleAgentDescription: () => {} }));

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { storeFile } from "@/lib/agentFiles";
import { getDb } from "@/lib/db";
import { createAgent } from "@/lib/agents";
import { createApiKey } from "@/lib/identity";
import { getAvailableBalanceWei } from "@/lib/payments";
import { withdrawableWei } from "@/lib/studioWithdraw";
import { holdLimit, peopleCaps, peopleEnabled, screenTask } from "@/lib/peoplePolicy";
import {
  applyVerdict, askSecondLook, boardTasks, cancelPeopleTask, deliverPeopleTask, eventsOf, getPeopleTask, giveUpPeopleTask, moderate, moveClock,
  ownerDecides, ownerView, postPeopleTask, publicView, recordOf, reportPeopleTask, takePeopleTask, takerView, type RulesJudge,
} from "@/lib/people";
import { checkProof, parseProof, parseRules, type ProofJudge } from "@/lib/peopleCheck";
import { paidToday, payNow, runPayouts } from "@/lib/peoplePay";

const saved = process.env.AGENT_PEOPLE;
beforeAll(() => { process.env.AXON_FILES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "axon-people-")); });
beforeEach(() => {
  process.env.AGENT_PEOPLE = "on";
  getDb().exec("DELETE FROM people_tasks; DELETE FROM people_deliveries; DELETE FROM people_payouts; DELETE FROM people_events; DELETE FROM people_reports; DELETE FROM people_blocks; DELETE FROM rate_limit_windows;");
});
afterEach(() => {
  if (saved === undefined) delete process.env.AGENT_PEOPLE; else process.env.AGENT_PEOPLE = saved;
});

let n = 0;
const wallet = () => `0x${(++n + 9_200_000).toString(16).padStart(40, "0")}`;
const ETH = 10n ** 18n;
const wei = (eth: string) => BigInt(Math.round(Number(eth) * 1e12)) * 10n ** 6n;

function agentOf(owner: string, earnedEth = "0.01", o: { verified?: boolean } = {}): string {
  const id = `ppl-${n}-${randomUUID().slice(0, 6)}`;
  createAgent({ agentId: id, name: "Field Scout", capabilities: ["research"], publicKey: `pk-${id}`, provider: "anthropic", reputation: 0, walletAddress: owner, price: "0.0005 ETH", createdAt: new Date().toISOString() });
  if (o.verified !== false) createApiKey(owner);
  if (Number(earnedEth) > 0) {
    getDb().prepare("INSERT INTO transactions (tx_id, task_id, from_agent, to_agent, amount_eth, status, incoming_signature, fee_amount, currency, created_at, settled_at) VALUES (?, ?, 'someone', ?, ?, 'completed', NULL, 0, 'ETH', ?, ?)")
      .run(randomUUID(), randomUUID(), id, Number(earnedEth), new Date().toISOString(), new Date().toISOString());
  }
  return id;
}

const ok: RulesJudge = async () => ({ ok: true });
const TASK = {
  title: "Check the opening hours at Central Library",
  details: "Go to the main entrance of the Central Library and read the opening hours on the door sign. Photograph the sign.",
  place: "Central Library, main entrance",
  proof: "photo",
  checks: ["The sign with the opening hours can be read", "The library's name is visible"],
  priceEth: "0.0001",
  takeHours: 4,
  days: 2,
};
const photo = { id: "f_" + "a".repeat(32), sha256: "b".repeat(64), mime: "image/jpeg", kind: "image" };
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 7)]);
/** A photo really kept in the files store, as a person's upload is. */
function stored(me: string, taskId: string) {
  const s = storeFile({ bytes: PNG, name: "sign.png", wallet: me, taskId });
  if (!s.ok) throw new Error(s.reason);
  return { id: s.file.id, sha256: s.file.sha256, mime: s.file.mime, kind: s.file.kind };
}

async function posted(o: Partial<typeof TASK> & Record<string, unknown> = {}) {
  const owner = wallet(), agentId = agentOf(owner);
  const r = await postPeopleTask({ agentId, ...TASK, ...o }, { wallet: owner }, ok);
  if (!r.ok) throw new Error(r.why);
  return { owner, agentId, task: r.task };
}

describe("the switch and the caps", () => {
  it("is off unless AGENT_PEOPLE=on, and nothing posts while it is off", async () => {
    expect(peopleEnabled({})).toBe(false);
    expect(peopleEnabled({ AGENT_PEOPLE: "on" })).toBe(true);
    const owner = wallet(), agentId = agentOf(owner);
    process.env.AGENT_PEOPLE = "off";
    expect(await postPeopleTask({ agentId, ...TASK }, { wallet: owner }, ok)).toMatchObject({ ok: false, code: "off" });
  });

  it("keeps every number a deployment sets inside bounds", () => {
    const c = peopleCaps({ AGENT_PEOPLE_MAX_PRICE_ETH: "500", AGENT_PEOPLE_MIN_PRICE_ETH: "-1", AGENT_PEOPLE_REVIEW_HOURS: "0", AGENT_PEOPLE_TAKES_PER_DAY: "x" });
    expect(c.maxPriceWei).toBe(ETH / 100n);
    expect(c.minPriceWei).toBe(10n ** 13n);
    expect(c.reviewHours).toBe(24);
    expect(c.takesPerDay).toBe(10);
    expect(peopleCaps({ AGENT_PEOPLE_MAX_PRICE_ETH: "0.002" }).maxPriceWei).toBe(2n * 10n ** 15n);
  });

  it("lets a good record hold more tasks at once", () => {
    expect([0, 2, 3, 9, 10, 50].map(holdLimit)).toEqual([1, 1, 2, 2, 3, 3]);
  });
});

describe("the rules", () => {
  it("screens words that never belong in a task for people", () => {
    expect(screenTask("Find out the home address of the man in this photo")).toBe("No personal data about others");
    expect(screenTask("Follow her from the station and tell me where she goes")).toBe("No personal data about others");
    expect(screenTask("Take a photo of the people waiting outside")).toBe("No personal data about others");
    expect(screenTask("Buy two gift cards and send me the codes")).toBe("Money moves only through Axon");
    expect(screenTask("Receive a parcel for me and reship it")).toBe("Money moves only through Axon");
    expect(screenTask("Write five-star fake reviews for my cafe")).toBe("Nothing illegal");
    expect(screenTask("Call him and pretend to be from the bank")).toBe("Calls are to businesses");
    expect(screenTask("Photograph the menu board at Cafe Lumen and the opening hours")).toBeNull();
    expect(screenTask("Write our three action items by hand and photograph them")).toBeNull();
    expect(screenTask("Photograph her front door")).toBe("No personal data about others");
    expect(screenTask("Call the bike shop on Main Street and ask if they repair e-bikes")).toBeNull();
  });

  it("refuses a task the screen or the model's check rejects, and one that cannot be checked", async () => {
    const owner = wallet(), agentId = agentOf(owner);
    expect(await postPeopleTask({ agentId, ...TASK, details: "Find the home address of the owner of the red car parked outside." }, { wallet: owner }, ok)).toMatchObject({ ok: false, code: "rules" });
    expect(await postPeopleTask({ agentId, ...TASK }, { wallet: owner }, async () => ({ ok: false, rule: "Nobody put at risk", why: "It sends someone onto a roof." }))).toEqual({ ok: false, code: "rules", why: 'This task breaks the rule "Nobody put at risk": It sends someone onto a roof.' });
    expect(await postPeopleTask({ agentId, ...TASK }, { wallet: owner }, async () => null)).toMatchObject({ ok: false, code: "unavailable" });
    expect(getDb().prepare("SELECT COUNT(*) n FROM people_tasks").get()).toEqual({ n: 0 });
  });

  it("reads the model's answers strictly", () => {
    expect(parseRules('{"ok": true}')).toEqual({ ok: true });
    expect(parseRules('Sure: {"ok": false, "rule": "nothing illegal", "why": "It asks for fake reviews — not allowed"}')).toEqual({ ok: false, rule: "Nothing illegal", why: "It asks for fake reviews, not allowed" });
    expect(parseRules("no idea")).toBeNull();
    expect(parseProof('{"verdict":"reject","failed_check":2,"reason":"The name is cut off"}', 2)).toEqual({ verdict: "reject", failedCheck: 1, reason: "The name is cut off" });
    expect(parseProof('{"verdict":"reject","failed_check":7,"reason":"x"}', 2)).toMatchObject({ verdict: "reject", failedCheck: null });
    expect(parseProof("garbage", 2)).toMatchObject({ verdict: "unsure" });
  });
});

describe("posting", () => {
  it("is for the agent's verified owner, with a task that says what proof it needs, within the price caps", async () => {
    const owner = wallet(), agentId = agentOf(owner);
    expect(await postPeopleTask({ agentId, ...TASK }, { wallet: wallet() }, ok)).toMatchObject({ ok: false, why: "Only the agent's owner can do that." });
    const other = wallet(), unverified = agentOf(other, "0.01", { verified: false });
    expect(await postPeopleTask({ agentId: unverified, ...TASK }, { wallet: other }, ok)).toMatchObject({ ok: false, why: "The agent's owner has to sign in with their wallet first." });
    expect(await postPeopleTask({ agentId, ...TASK, checks: [] }, { wallet: owner }, ok)).toMatchObject({ ok: false, code: "invalid" });
    expect(await postPeopleTask({ agentId, ...TASK, proof: "video" }, { wallet: owner }, ok)).toMatchObject({ ok: false, why: "Say what proof to hand in: photo, file or answer." });
    expect(await postPeopleTask({ agentId, ...TASK, priceEth: "0.5" }, { wallet: owner }, ok)).toMatchObject({ ok: false, why: "A task pays at most 0.01 ETH." });
    expect(await postPeopleTask({ agentId, ...TASK, priceEth: "0.000001" }, { wallet: owner }, ok)).toMatchObject({ ok: false, why: "A task pays at least 0.00001 ETH." });
    expect(await postPeopleTask({ agentId, ...TASK, takeHours: 500 }, { wallet: owner }, ok)).toMatchObject({ ok: false, code: "invalid" });
  });

  it("locks the pay from the agent's earnings, so the same ETH cannot be spent or withdrawn twice", async () => {
    const owner = wallet(), agentId = agentOf(owner, "0.0003");
    expect(getAvailableBalanceWei(agentId)).toBe(wei("0.0003"));
    const r = await postPeopleTask({ agentId, ...TASK, priceEth: "0.0002" }, { wallet: owner }, ok);
    expect(r.ok).toBe(true);
    const t = (r as { task: ReturnType<typeof getPeopleTask> & object }).task;
    expect(t).toMatchObject({ status: "open", lockState: "held", funding: "earnings", postedBy: "owner" });
    expect(getAvailableBalanceWei(agentId)).toBe(wei("0.0001"));
    expect(withdrawableWei(agentId)).toBe(wei("0.0001"));
    expect(await postPeopleTask({ agentId, ...TASK, priceEth: "0.0002" }, { wallet: owner }, ok)).toMatchObject({ ok: false, code: "payment" });
    // cancelled before anyone took it: the lock comes back
    expect(cancelPeopleTask(t.taskId, owner)).toMatchObject({ ok: true, task: { status: "cancelled", lockState: "returned" } });
    expect(getAvailableBalanceWei(agentId)).toBe(wei("0.0003"));
  });

  it("can be paid from the owner's wallet instead, once per payment, and an unused one goes back on-chain", async () => {
    const owner = wallet(), agentId = agentOf(owner, "0");
    const verify = vi.fn(async () => ({ ok: true, reason: "ok" }));
    const tx = `0x${"c".repeat(64)}`;
    const r = await postPeopleTask({ agentId, ...TASK, funding: "wallet", paymentTx: tx }, { wallet: owner }, ok, { verify });
    expect(r).toMatchObject({ ok: true, task: { funding: "wallet", fundingTx: tx, lockState: "held" } });
    expect(verify).toHaveBeenCalledWith(tx, expect.objectContaining({ wei: wei("0.0001") }), owner);
    expect(await postPeopleTask({ agentId, ...TASK, funding: "wallet", paymentTx: tx }, { wallet: owner }, ok, { verify })).toMatchObject({ ok: false, why: "That payment was already used." });
    expect(await postPeopleTask({ agentId, ...TASK, funding: "wallet", paymentTx: `0x${"d".repeat(64)}` }, { wallet: owner }, ok, { verify: async () => ({ ok: false, reason: "wrong amount" }) })).toMatchObject({ ok: false, code: "payment" });
    const id = (r as { task: { taskId: string } }).task.taskId;
    cancelPeopleTask(id, owner);
    const send = vi.fn(async (_to: string, _amt: string | number, onSent?: (h: string) => void) => { onSent?.("0xreturn"); return "0xreturn"; });
    expect(await runPayouts({ send, balance: async () => ETH })).toMatchObject({ sent: 1 });
    expect(send).toHaveBeenCalledWith(owner, "0.0001", expect.any(Function));
    expect(getPeopleTask(id)).toMatchObject({ status: "cancelled", lockState: "returned" });
  });

  it("keeps an agent and an owner to their daily and open caps", async () => {
    const owner = wallet(), agentId = agentOf(owner, "0.1");
    const caps = { ...peopleCaps(), postsPerAgentDay: 2 };
    expect((await postPeopleTask({ agentId, ...TASK }, { wallet: owner }, ok, { caps })).ok).toBe(true);
    expect((await postPeopleTask({ agentId, ...TASK }, { wallet: owner }, ok, { caps })).ok).toBe(true);
    expect(await postPeopleTask({ agentId, ...TASK }, { wallet: owner }, ok, { caps })).toMatchObject({ ok: false, code: "limit" });
  });

  it("shows anybody the task but never its owner", async () => {
    const { owner, task } = await posted();
    const v = publicView(task);
    expect(JSON.stringify(v)).not.toContain(owner.slice(2));
    expect(v).toMatchObject({ title: TASK.title, proof: "photo", pay: "0.0001 ETH", paymentLocked: true, status: "open", checks: TASK.checks });
    expect(boardTasks().map((t) => t.taskId)).toContain(task.taskId);
  });
});

describe("taking and handing in", () => {
  it("is for anyone signed in but the owner, one task at a time for someone new", async () => {
    const { owner, task } = await posted();
    expect(takePeopleTask(task.taskId, owner)).toEqual({ ok: false, why: "You cannot take a task your own agent posted." });
    const me = wallet();
    expect(takePeopleTask(task.taskId, me)).toMatchObject({ ok: true, task: { status: "taken", takerWallet: me } });
    expect(takePeopleTask(task.taskId, wallet())).toMatchObject({ ok: false, why: "Someone else has this task, or it is closed." });
    const second = await posted();
    expect(takePeopleTask(second.task.taskId, me)).toMatchObject({ ok: false, why: "You can hold 1 task at once with your record. Finish one first." });
    const gated = await posted({ minDone: 3 } as never);
    expect(takePeopleTask(gated.task.taskId, wallet())).toMatchObject({ ok: false, why: "This task is for people with at least 3 accepted tasks on their record." });
  });

  it("needs the proof the task asked for, and goes to the check", async () => {
    const { task } = await posted();
    const me = wallet();
    takePeopleTask(task.taskId, me);
    expect(deliverPeopleTask(task.taskId, wallet(), { file: photo })).toEqual({ ok: false, why: "You do not have this task." });
    expect(deliverPeopleTask(task.taskId, me, { answer: "It is open 9 to 5" })).toMatchObject({ ok: false, why: "This task needs a photo: a PNG, JPEG, GIF or WebP picture." });
    const r = deliverPeopleTask(task.taskId, me, { file: photo, answer: "Open 9 to 17" });
    expect(r).toMatchObject({ ok: true, task: { status: "delivered", tries: 1 }, delivery: { verdict: null, fileSha256: photo.sha256 } });
    expect(deliverPeopleTask(task.taskId, me, { file: photo })).toMatchObject({ ok: false, why: "Your proof is already being looked at." });
  });

  it("gives up to the board for someone else, on the person's record", async () => {
    const { task } = await posted();
    const me = wallet();
    takePeopleTask(task.taskId, me);
    expect(giveUpPeopleTask(task.taskId, me)).toMatchObject({ ok: true, task: { status: "open", takerWallet: null } });
    expect(recordOf(me)).toMatchObject({ gaveUp: 1, done: 0 });
    expect(takePeopleTask(task.taskId, me)).toMatchObject({ ok: false, why: "You already had this task. It is someone else's turn." });
  });
});

describe("the verdict", () => {
  async function delivered() {
    const p = await posted();
    const me = wallet();
    takePeopleTask(p.task.taskId, me);
    const file = stored(me, p.task.taskId);
    deliverPeopleTask(p.task.taskId, me, { file });
    return { ...p, me, file };
  }

  it("accepts and pays the person on-chain, once, with the hash on the task", async () => {
    const { task, me, agentId } = await delivered();
    const judge: ProofJudge = async () => ({ verdict: "accept", failedCheck: null, reason: "Both lines are met", model: "claude-haiku-4-5", costUsd: 0.001 });
    expect(await checkProof(task.taskId, judge)).toBe("accept");
    expect(getPeopleTask(task.taskId)!.status).toBe("accepted");
    const send = vi.fn(async (_to: string, _amt: string | number, onSent?: (h: string) => void) => { onSent?.("0xpaid"); return "0xpaid"; });
    await payNow(task.taskId, { send, balance: async () => ETH });
    await payNow(task.taskId, { send, balance: async () => ETH });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(me, "0.0001", expect.any(Function));
    expect(getPeopleTask(task.taskId)).toMatchObject({ status: "paid", lockState: "paid" });
    expect(recordOf(me)).toMatchObject({ done: 1, earned: "0.0001 ETH" });
    // paid out of the agent's earnings for good
    expect(getAvailableBalanceWei(agentId)).toBe(wei("0.0099"));
    expect(takerView(getPeopleTask(task.taskId)!, me)).toMatchObject({ payout: { status: "sent", txHash: "0xpaid" } });
    expect(eventsOf(task.taskId).map((e) => e.kind)).toEqual(["posted", "taken", "handed_in", "accepted", "paid"]);
  });

  it("turns a rejection that names no line into the owner's decision", async () => {
    const { task } = await delivered();
    await checkProof(task.taskId, async () => ({ verdict: "reject", failedCheck: null, reason: "Looks wrong", model: null, costUsd: null }));
    expect(getPeopleTask(task.taskId)!.status).toBe("review");
  });

  it("lets a rejected person hand in again, then ask for a second look; the owner's silence pays them", async () => {
    const { task, me, owner, file } = await delivered();
    const reject: ProofJudge = async () => ({ verdict: "reject", failedCheck: 1, reason: "The library's name is not in the photo", model: null, costUsd: null });
    await checkProof(task.taskId, reject);
    expect(getPeopleTask(task.taskId)).toMatchObject({ status: "rejected", tries: 1 });
    expect(takerView(getPeopleTask(task.taskId)!, me).deliveries[0]).toMatchObject({ verdict: "reject", failedCheck: "The library's name is visible" });
    expect(deliverPeopleTask(task.taskId, me, { file })).toMatchObject({ ok: true });
    await checkProof(task.taskId, reject);
    expect(deliverPeopleTask(task.taskId, me, { file })).toMatchObject({ ok: false, why: "You have handed in 2 times. Ask the owner for a second look, or leave it." });
    // the owner cannot reject while the check's rejection stands; only when it waits for them
    expect(ownerDecides(task.taskId, owner, { decision: "reject", failedCheck: 0, reason: "No" })).toMatchObject({ ok: false });
    const now = Date.now();
    expect(askSecondLook(task.taskId, me, { nowMs: now })).toMatchObject({ ok: true, task: { status: "review", secondLook: true } });
    expect(askSecondLook(task.taskId, me)).toMatchObject({ ok: false });
    expect(moveClock(now + 23 * 3_600_000)).toMatchObject({ paidOnSilence: 0 });
    expect(moveClock(now + 25 * 3_600_000)).toMatchObject({ paidOnSilence: 1 });
    expect(getPeopleTask(task.taskId)!.status).toBe("accepted");
  });

  it("lets the owner reject a proof in review only by naming a line and a reason; that is final for the person", async () => {
    const { task, me, owner } = await delivered();
    await checkProof(task.taskId, async () => ({ verdict: "unsure", failedCheck: null, reason: "Blurry", model: null, costUsd: null }));
    expect(ownerDecides(task.taskId, owner, { decision: "reject", failedCheck: 5, reason: "Nope" })).toMatchObject({ ok: false, why: "Pick which of the task's checks the proof does not meet." });
    expect(ownerDecides(task.taskId, owner, { decision: "reject", failedCheck: 0, reason: "" })).toMatchObject({ ok: false });
    expect(ownerDecides(task.taskId, wallet(), { decision: "reject", failedCheck: 0, reason: "The hours cannot be read" })).toMatchObject({ ok: false, why: "There is no such task of yours." });
    expect(ownerDecides(task.taskId, owner, { decision: "reject", failedCheck: 0, reason: "The hours cannot be read" })).toMatchObject({ ok: true, task: { status: "open", takerWallet: null } });
    expect(recordOf(me)).toMatchObject({ rejected: 1, done: 0 });
    expect(ownerView(getPeopleTask(task.taskId)!).deliveries[0]).toMatchObject({ verdict: "reject", by: "owner", failedCheck: "The sign with the opening hours can be read" });
  });

  it("lets the owner accept over the check", async () => {
    const { task, owner } = await delivered();
    await checkProof(task.taskId, async () => ({ verdict: "reject", failedCheck: 0, reason: "Hours unreadable", model: null, costUsd: null }));
    expect(ownerDecides(task.taskId, owner, { decision: "accept" })).toMatchObject({ ok: true, task: { status: "accepted" } });
  });

  it("sends a proof to the owner when the check cannot run", async () => {
    const { task } = await delivered();
    expect(await checkProof(task.taskId, async () => null)).toBe("unsure");
    expect(getPeopleTask(task.taskId)!.status).toBe("review");
  });
});

describe("the clock", () => {
  it("lets go of a person whose time ran out, and closes a task past its time with the lock back", async () => {
    const { task, agentId } = await posted();
    const me = wallet(), start = Date.now();
    takePeopleTask(task.taskId, me, { nowMs: start });
    expect(moveClock(start + 5 * 3_600_000)).toMatchObject({ timedOut: 1 });
    expect(getPeopleTask(task.taskId)).toMatchObject({ status: "open", takerWallet: null });
    expect(recordOf(me).gaveUp).toBe(1);
    expect(getAvailableBalanceWei(agentId)).toBe(wei("0.0099"));
    expect(moveClock(start + 3 * 24 * 3_600_000)).toMatchObject({ expired: 1 });
    expect(getPeopleTask(task.taskId)).toMatchObject({ status: "expired", lockState: "returned" });
    expect(getAvailableBalanceWei(agentId)).toBe(wei("0.01"));
  });
});

describe("payouts", () => {
  it("wait for the next day past the network's daily ceiling, and are tried again when the wallet is short", async () => {
    const a = await posted(), b = await posted();
    for (const p of [a, b]) {
      const me = wallet();
      takePeopleTask(p.task.taskId, me);
      deliverPeopleTask(p.task.taskId, me, { file: photo });
      applyVerdict(p.task.taskId, { verdict: "accept", reason: "ok", by: "check" });
    }
    const caps = { ...peopleCaps(), payoutsPerDayWei: wei("0.00015") };
    const send = vi.fn(async () => "0xhash");
    expect(await runPayouts({ send, balance: async () => 0n, caps })).toMatchObject({ sent: 0 });
    expect(await runPayouts({ send, balance: async () => ETH, caps, nowMs: Date.now() + 6 * 60_000 })).toMatchObject({ sent: 1, waiting: 1 });
    expect(paidToday()).toBe(wei("0.0001"));
    const waiting = [a, b].map((p) => getPeopleTask(p.task.taskId)!.status).sort();
    expect(waiting).toEqual(["accepted", "paid"]);
  });

  it("never sends a payout twice when its receipt did not come back", async () => {
    const { task } = await posted();
    const me = wallet();
    takePeopleTask(task.taskId, me);
    deliverPeopleTask(task.taskId, me, { file: photo });
    applyVerdict(task.taskId, { verdict: "accept", reason: "ok", by: "check" });
    const send = vi.fn(async (_to: string, _amt: string | number, onSent?: (h: string) => void) => { onSent?.("0xsent"); throw new Error("timeout"); });
    await payNow(task.taskId, { send, balance: async () => ETH });
    await runPayouts({ send, balance: async () => ETH, nowMs: Date.now() + 60 * 60_000 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(getDb().prepare("SELECT status, tx_hash FROM people_payouts WHERE task_id = ?").get(task.taskId)).toEqual({ status: "pending", tx_hash: "0xsent" });
  });
});

describe("moderation", () => {
  it("takes a task off the board after enough reports, and a moderator decides", async () => {
    const { task, agentId } = await posted();
    const caps = { ...peopleCaps(), reportsToHide: 2 };
    expect(reportPeopleTask(task.taskId, "ip:one", "unsafe", null, { caps })).toEqual({ ok: true, hidden: false });
    expect(reportPeopleTask(task.taskId, "ip:one", "unsafe", null, { caps })).toEqual({ ok: false, why: "You already reported this task." });
    expect(reportPeopleTask(task.taskId, "ip:two", "scam", "asks for codes", { caps })).toEqual({ ok: true, hidden: true });
    expect(getPeopleTask(task.taskId)).toMatchObject({ status: "cancelled", lockState: "returned" });
    expect(boardTasks().map((t) => t.taskId)).not.toContain(task.taskId);
    expect(moderate(task.taskId, "block_agent", "Asked for codes")).toMatchObject({ ok: true });
    const owner = getPeopleTask(task.taskId)!.ownerWallet;
    expect(await postPeopleTask({ agentId, ...TASK }, { wallet: owner }, ok)).toMatchObject({ ok: false, why: "This agent may not post tasks for people." });
  });
});
