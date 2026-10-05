// Agent Minds: every model on the list, asked for real.
//
// Each model is given the same three situations through the same code a live mind runs (thinkOnce): one where its
// treasury can afford to act, one where it cannot, and one where it is full. What comes back is read, priced and rule-checked exactly as it
// would be on the site. It uses a throwaway database and a made-up chain, so nothing is sent and nothing real is
// touched; the only thing spent is the model calls themselves (fifteen in all, a few cents).
//
//   railway run --service <service> npx tsx scripts/minds-models-check.ts        (the keys come from the service)
//
// Exit code 0 only if every model answered each in a form the rule check reads.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), "minds-models-")), "check.db");

async function main() {
  const { getDb } = await import("../src/lib/db");
  const { MIND_MODELS, modelAvailable } = await import("../src/lib/mindsModels");
  const { thinkOnce } = await import("../src/lib/mindsMind");
  const { realThinker } = await import("../src/lib/mindsThinker");
  type Chain = import("../src/lib/mindsChain").MindsChain;
  type Treasury = import("../src/lib/mindsChain").Treasury;

  const env = { ...process.env, AGENT_MINDS: "on", MINDS_THINKING: "live", MINDS_DAILY_BUDGET_USD: "1", NEXT_PUBLIC_MIND_LAUNCHER: "0x00000000000000000000000000000000000a110c", MIND_DEPLOY_BLOCK: "1000" };
  const USD_PER_ETH = 2700;
  const db = getDb();
  const now = Date.now(), at = (ms: number) => new Date(now - ms).toISOString();
  const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;

  const limits = { allowed: 7, maxPerDayEth: 0.05, maxPerActionEth: 0.01, maxActionsPerDay: 6, maxCostPerDayEth: 0.01 };
  const treasuries = new Map<string, Treasury>();
  const no = (what: string) => async (): Promise<never> => { throw new Error(`the check's chain has no ${what}`); };
  const chain: Chain = {
    head: no("head"), launches: no("launches"), blockTime: no("block times"), tokenMeta: no("token names"), snapshot: no("snapshots"), transfers: no("transfers"),
    earlierToken: no("earlier tokens"), earlierTokenOf: no("earlier tokens"), feeFlow: no("fee flows"),
    vaultDay: async () => ({ spentTodayEth: 0, actionsToday: 0, costTodayEth: 0 }),
    treasury: async (vault) => treasuries.get(vault)!,
  };

  // two situations: a treasury that can act, and one too small to (anything proposed there must be refused)
  const SITUATIONS = [
    { key: "can act", freeEth: 0.021, holders: 14, feesEth: 0.031, events: [["launch", null, null], ["fees", 0.031, null], ["holders", null, 14]] as const },
    { key: "too little to act", freeEth: 0.00016, holders: 3, feesEth: 0.0002, events: [["launch", null, null], ["fees", 0.0002, null]] as const },
    // a full treasury on a busy token: here a model is expected to propose something, which is what shows its
    // proposal comes back in the form the rule check reads (holding again is allowed, and is said)
    { key: "a full treasury", freeEth: 0.46, holders: 310, feesEth: 1.9, events: [["fees", 0.52, null], ["holders", null, 310], ["burn", 0.2, 41_000_000], ["fees", 0.38, null]] as const },
  ].filter((x) => !process.argv[2] || x.key.includes(process.argv[2]));

  let n = 0, bad = 0, spent = 0;
  for (const model of MIND_MODELS) {
    console.log(`\n== ${model.label} (${model.maker}, via ${model.via})`);
    if (!modelAvailable(model, env)) { console.log("FAIL  no key for it on this service"); bad++; continue; }
    for (const s of SITUATIONS) {
      const token = addr(0xa000 + ++n), vault = addr(0xb000 + n);
      db.prepare("INSERT INTO mind_tokens (token, creator, agent_ref, pot, splitter, vault, payout, tax_bps, creator_bps, burn_bps, axon_bps, mind_bps, name, symbol, description, model, block_number, tx_hash, launched_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(token, addr(0xc000 + n), `0x${String(n).padStart(64, "0")}`, addr(0xd000 + n), addr(0xe000 + n), vault, addr(0xc000 + n), 300, 5000, 2000, 1000, 2000, "Filing Desk", "DESK", "Explains company filings in plain words", model.id, 1100 + n, `0x${String(n).padStart(64, "f")}`, at(3_600_000), at(3_600_000));
      const burned = s.events.reduce((sum, e) => sum + (e[0] === "burn" ? e[2] ?? 0 : 0), 0);
      db.prepare("INSERT INTO mind_stats (token, phase, price_eth, mcap_eth, curve_bps, holders, fees_eth, to_mind_eth, burned_tokens, treasury_eth, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
        .run(token, 0, 2e-9, 2, 1200, s.holders, s.feesEth, s.freeEth, burned, s.freeEth, at(10_000));
      for (const [kind, eth, tokens] of s.events) db.prepare("INSERT INTO mind_events (token, kind, eth, tokens, at) VALUES (?,?,?,?,?)").run(token, kind, eth, tokens, at(60_000));
      treasuries.set(vault, { availableEth: s.freeEth, reservedEth: 0, boughtBackEth: 0, axonBurnedEth: 0, rewardedEth: 0, claimedEth: 0, thinkingEth: 0, rewards: 0, paused: false, frozen: false, active: true, limits });

      const started = Date.now();
      const r = await thinkOnce(token, { chain, env, thinker: realThinker, usdPerEth: USD_PER_ETH });
      const ms = Date.now() - started;
      if ("skipped" in r) {
        const row = db.prepare("SELECT error, cost_usd FROM mind_thoughts WHERE token = ? ORDER BY id DESC LIMIT 1").get(token) as { error: string | null; cost_usd: number } | undefined;
        spent += row?.cost_usd ?? 0; bad++;
        console.log(`FAIL  ${s.key}: ${r.skipped}${row?.error ? ` (${row.error})` : ""}  [${(ms / 1000).toFixed(1)}s]`);
        continue;
      }
      spent += r.costUsd;
      // with too little in the treasury nothing may get through: it holds, or the rule check refuses what it asked for
      const sound = s.key === "too little to act" ? r.verdict !== "approved" : r.verdict !== "refused" || Boolean(r.verdictReason);
      if (!sound) bad++;
      const size = db.prepare("SELECT input_tokens i, output_tokens o FROM mind_thoughts WHERE id = ?").get(r.id) as { i: number; o: number };
      console.log(`${sound ? "PASS" : "FAIL"}  ${s.key}  [${(ms / 1000).toFixed(1)}s, ${size.i} in + ${size.o} out, $${r.costUsd.toFixed(5)}]`);
      console.log(`      thought: ${r.thought}`);
      console.log(`      action:  ${r.action ? `${r.action.kind} with ${r.action.eth} ETH -> ${r.verdict}${r.verdictReason ? ` (${r.verdictReason})` : ""}` : "none"}`);
    }
  }
  console.log(`\n${bad ? `${bad} FAILED` : "every model answered in a form the rule check reads"}; spent $${spent.toFixed(4)} on ${n} calls`);
  process.exit(bad ? 1 : 0);
}

void main();
