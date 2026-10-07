// Put two tokens with a mind into the scratch database the SDK's live tests run against.
//
//   DATABASE_PATH=... E2E_MIND_CREATOR=0x... npx tsx scripts/sdk-e2e-seed.ts
//
// Run by scripts/sdk-e2e.mjs, never against a real database. A mind's token normally arrives from the launcher's
// events; a scratch server has no launcher, so the two rows are written the way the indexer writes them.
//
//   CHAIN    its pot, splitter and treasury are real contracts on Robinhood Chain, so the server answers with a
//            treasury, fees and books read off the chain, not made up here. It also has a plan and one thought.
//   NOCHAIN  nothing behind its addresses, so everything the chain would say comes back null. It was left a brief
//            seven hours ago, which makes it the one whose brief may be changed or taken back right now.
//
// Both are given to E2E_MIND_CREATOR, so that wallet's key can leave a brief.

import { getDb } from "@/lib/db";
import { upsertToken } from "@/lib/mindsStore";
import { savePlan } from "@/lib/mindsPlan";
import { setBrief } from "@/lib/mindsBrief";

const creator = (process.env.E2E_MIND_CREATOR ?? "").toLowerCase();
if (!/^0x[0-9a-f]{40}$/.test(creator)) throw new Error("E2E_MIND_CREATOR must be a wallet address");
if (!process.env.DATABASE_PATH) throw new Error("DATABASE_PATH must point at the scratch database");

export const CHAIN = "0x4efeab63e58ebc2ed18e768ee1baa1c66321a6c9";
export const NOCHAIN = "0x00000000000000000000000000000000000e2e02";
const HOUR = 3_600_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

upsertToken({
  token: CHAIN, creator, agentId: null, agentRef: `0x${"e2".repeat(32)}`,
  pot: "0x176da4455d3c79c6e89a00a977fd484e735d6f2f", splitter: "0x83c7f684e48d767d2890d5b61a4c09ae96ab4d41", vault: "0xa5b5e702db907895bf4e5a4a89c113dcf1a08d9a", payout: creator,
  taxBps: 300, creatorBps: 3000, burnBps: 2000, axonBps: 1000, mindBps: 4000, attached: false,
  name: "E2E On Chain", symbol: "E2EC", logo: null, description: "A token the SDK's live tests read.", model: "claude-opus-5-5", mindUrl: null,
  blockNumber: 80970815, txHash: `0x${"c1".repeat(32)}`, launchedAt: ago(48 * HOUR),
});
upsertToken({
  token: NOCHAIN, creator, agentId: null, agentRef: `0x${"e3".repeat(32)}`,
  pot: "0x00000000000000000000000000000000000e2e12", splitter: "0x00000000000000000000000000000000000e2e22", vault: "0x00000000000000000000000000000000000e2e32", payout: creator,
  taxBps: 300, creatorBps: 3000, burnBps: 2000, axonBps: 1000, mindBps: 4000, attached: false,
  name: "E2E No Chain", symbol: "E2EN", logo: null, description: null, model: "claude-opus-5-5", mindUrl: null,
  blockNumber: 80970816, txHash: `0x${"c2".repeat(32)}`, launchedAt: ago(24 * HOUR),
});

const db = getDb();
const thoughtId = Number(db.prepare("INSERT INTO mind_thoughts (token, at, model, standin, status, reasons, thought, action, verdict, verdict_reason, input_tokens, output_tokens, cost_usd, cost_eth, last_event_id, error) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
  .run(CHAIN, ago(HOUR), "claude-opus-5-5", 0, "thought", "[]", "Fees came in. I would buy back, but that is more than one action may spend.", JSON.stringify({ kind: "buyback", eth: 5 }), "refused", "More than one action may spend.", 0, 0, 0, 0, 0, null).lastInsertRowid);
const plan = savePlan(CHAIN, { mission: "Grow the holder count slowly and keep a reserve.", goal: { kind: "holders", target: 100000 }, split: { buyback: 40, reward: 30, burnAxon: 10, reserve: 20 }, reserveEth: 0.001, thesis: "Rewards bring holders back more than buybacks do." }, thoughtId);

const brief = setBrief(NOCHAIN, creator, "Reward the holders before buying back.", Date.now() - 7 * HOUR);
if (!brief.ok) throw new Error(`could not leave the brief: ${brief.reason}`);

console.log(JSON.stringify({ chain: CHAIN, noChain: NOCHAIN, plan, thoughtId }));
