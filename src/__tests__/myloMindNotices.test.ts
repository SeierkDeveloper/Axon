// Mylo meets the minds, phase 4: what Mylo tells people about tokens. A creator hears what their token's mind did and
// why, a holder milestone and the graduation; a holder hears only about a reward that is theirs to claim.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { getDb } from "@/lib/db";
import { runMyloPass, LOOK_BACK_HOURS } from "@/lib/myloPass";
import { feed, inboxOf, unreadCount, startConversation } from "@/lib/myloStore";
import { upsertToken } from "@/lib/mindsStore";
import { addEvent } from "@/lib/mindsStats";
import { runTool } from "@/lib/myloTools";

let n = 0;
const addr = () => `0x${(++n + 5_500_000).toString(16).padStart(40, "0")}`;
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

function token(creator: string, name: string, symbol: string): string {
  const t = addr();
  upsertToken({
    token: t, creator, agentId: null, agentRef: `0x${"0".repeat(64)}`, pot: addr(), splitter: addr(), vault: addr(), payout: creator,
    taxBps: 300, creatorBps: 4000, burnBps: 3000, axonBps: 1000, mindBps: 2000, attached: false, name, symbol, logo: null, description: null,
    model: "claude-opus-5-5", mindUrl: null, blockNumber: 4000 + n, txHash: `0x${n.toString(16).padStart(64, "0")}`, launchedAt: ago(600),
  });
  return t;
}
/** Something a mind proposed, and what became of it. */
function action(tok: string, kind: string, eth: number, status: string, minutesAgo: number, thought: string | null = "Fees came in and the treasury is well above what I need."): number {
  const db = getDb();
  const thoughtId = thought === null ? null : Number(db.prepare("INSERT INTO mind_thoughts (token, at, model, standin, status, reasons, thought, action, verdict, verdict_reason, input_tokens, output_tokens, cost_usd, cost_eth, last_event_id, error) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(tok, ago(minutesAgo + 1), "claude-opus-5-5", 0, "thought", "[]", thought, JSON.stringify({ kind, eth }), "approved", null, 0, 0, 0, 0, 0, null).lastInsertRowid);
  return Number(db.prepare("INSERT INTO mind_actions (thought_id, token, kind, wei, eth, status, tx_hash, error, at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run(thoughtId, tok, kind, "0", eth, status, null, null, ago(minutesAgo + 1), ago(minutesAgo)).lastInsertRowid);
}
function reward(tok: string, id: number, shares: [string, number][], minutesAgo = 5): void {
  const now = Math.floor(Date.now() / 1000), db = getDb();
  db.prepare("INSERT INTO mind_rewards (token, reward_id, root, total_wei, start_at, end_at, at_block, created_at) VALUES (?,?,?,?,?,?,?,?)").run(tok, id, `0x${"1".repeat(64)}`, "0", now - 60, now + 7 * 86_400, 1, ago(minutesAgo));
  shares.forEach(([account, eth], idx) => db.prepare("INSERT INTO mind_reward_shares (token, reward_id, idx, account, amount_wei, proof, claimed) VALUES (?,?,?,?,?,?,0)").run(tok, id, idx, account.toLowerCase(), BigInt(Math.round(eth * 1e18)).toString(), "[]"));
}
const titles = (w: string) => inboxOf(w).map((x) => x.title);

// whatever the database already holds is noticed first, so each test counts only what it wrote itself
beforeEach(() => { vi.stubEnv("AGENT_MINDS", "on"); runMyloPass(); });

describe("what Mylo tells people about tokens", () => {
  it("tells a creator what their token's mind did, in the mind's own words, once it is done on chain", () => {
    const me = addr(), tok = token(me, "Ledger Lens", "LENS");
    action(tok, "buyback", 0.004, "done", 20, "Fees came in from a busy hour. I am using a fifth of the treasury to buy back.");
    action(tok, "reward", 0.002, "done", 15);
    action(tok, "burn_axon", 0.001, "done", 10, null);
    // not news: still on its way, failed, never sent, or the mind paying for its own thinking
    action(tok, "buyback", 0.003, "sent", 9);
    action(tok, "buyback", 0.003, "failed", 8);
    action(tok, "buyback", 0.003, "dropped", 7);
    action(tok, "thinking", 0.0002, "done", 6, null);

    expect(runMyloPass().notices).toBe(3);
    const inbox = inboxOf(me);
    expect(inbox.map((x) => x.title).sort()).toEqual(["Ledger Lens's mind bought back $LENS", "Ledger Lens's mind burned $AXON", "Ledger Lens's mind rewarded holders"]);
    const bought = inbox.find((x) => /bought back/.test(x.title))!;
    expect(bought).toMatchObject({ kind: "mind", link: `/launch?token=${tok}` });
    expect(bought.body).toBe('It used 0.004 ETH of its treasury to buy $LENS and send it to the dead address. In its own words: "Fees came in from a busy hour. I am using a fifth of the treasury to buy back."');
    expect(inbox.find((x) => /burned \$AXON/.test(x.title))!.body).toBe("It used 0.001 ETH of its treasury to buy $AXON and send it to the dead address.");
    expect(inbox.find((x) => /rewarded holders/.test(x.title))!.body).toMatch(/^It set 0\.002 ETH aside for holders to claim on the token's page\./);

    // the next pass looks back over the same hours and adds nothing
    expect(runMyloPass().notices).toBe(0);
    expect(unreadCount(me)).toBe(3);
  });

  it("tells a creator about a holder milestone and the graduation, each once", () => {
    const me = addr(), tok = token(me, "Paper Lantern", "PLNT");
    addEvent(tok, "holders", { tokens: 100, at: ago(30) });
    addEvent(tok, "graduated", { at: ago(12) });
    // the log's other lines are for the page, not for anyone's inbox
    addEvent(tok, "fees", { eth: 0.01, at: ago(11) });
    addEvent(tok, "burn", { tokens: 5000, eth: 0.002, at: ago(10) });
    addEvent(tok, "thought", { at: ago(9) });

    expect(runMyloPass().notices).toBe(2);
    expect(titles(me).sort()).toEqual(["Paper Lantern graduated", "Paper Lantern passed 100 holders"]);
    expect(inboxOf(me).every((x) => x.kind === "milestone" && x.link === `/launch?token=${tok}`)).toBe(true);
    expect(runMyloPass().notices).toBe(0);
  });

  it("tells each holder about a reward that is theirs to claim, and nobody else about anything", () => {
    const creator = addr(), a = addr(), b = addr(), bystander = addr(), tok = token(creator, "Night Ferry", "FERRY");
    reward(tok, 3, [[a, 0.0004], [b, 0.0011]]);
    // b claimed theirs before Mylo looked
    getDb().prepare("UPDATE mind_reward_shares SET claimed = 1 WHERE token = ? AND reward_id = 3 AND account = ?").run(tok, b.toLowerCase());

    expect(runMyloPass().notices).toBe(1);
    const [mine] = inboxOf(a);
    expect(mine).toMatchObject({ kind: "reward", title: "A reward from Night Ferry is waiting for you", link: `/launch?token=${tok}` });
    expect(mine.body).toMatch(/^0\.0004 ETH, set aside by its mind for holders of \$FERRY\. Claim it from your own wallet on the token's page before \d{1,2} [A-Z][a-z]+\.$/);
    expect(inboxOf(b)).toEqual([]);
    expect(inboxOf(bystander)).toEqual([]);
    expect(inboxOf(creator)).toEqual([]);
    expect(runMyloPass().notices).toBe(0);
  });

  it("says nothing about what happened before it looks back, nothing in public, and nothing with Agent Minds off", () => {
    const me = addr(), holder = addr(), tok = token(me, "Old News", "OLD");
    const before = feed(50).length;
    action(tok, "buyback", 0.004, "done", LOOK_BACK_HOURS * 60 + 30);
    addEvent(tok, "holders", { tokens: 50, at: ago(LOOK_BACK_HOURS * 60 + 30) });
    reward(tok, 1, [[holder, 0.001]], LOOK_BACK_HOURS * 60 + 30);
    expect(runMyloPass().notices).toBe(0);

    const fresh = token(me, "Switched Off", "OFF");
    action(fresh, "buyback", 0.004, "done", 5);
    vi.stubEnv("AGENT_MINDS", "off");
    expect(runMyloPass().notices).toBe(0);
    vi.stubEnv("AGENT_MINDS", "on");
    expect(runMyloPass().notices).toBe(1);
    expect(feed(50).length).toBe(before);
  });

  it("is what Mylo reads back when they ask what they missed", async () => {
    const me = addr(), tok = token(me, "Glass Atlas", "ATLAS");
    action(tok, "reward", 0.003, "done", 4, "We passed 100 holders. I am sending part of the treasury out to them.");
    runMyloPass();
    const out = await runTool("my_inbox", {}, { wallet: me, owner: me, conversationId: startConversation(me, "t").id });
    expect((out.result as { new: { what: string; detail: string; link: string }[] }).new).toEqual([expect.objectContaining({ what: "Glass Atlas's mind rewarded holders", detail: expect.stringMatching(/In its own words: "We passed 100 holders/), link: `/launch?token=${tok}` })]);
    expect(unreadCount(me)).toBe(0);
  });
});
