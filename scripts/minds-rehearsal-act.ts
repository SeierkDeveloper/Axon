// Agent Minds on a copy of the chain, with money moving: a token is launched and traded, the signer moves its fees,
// its mind proposes, the rule check passes or refuses, the signer sends what passed, holders claim a reward with the
// proofs the site keeps, and the mind pays for its thinking. Every number is then read back from the chain itself.
//
//   anvil --fork-url https://rpc.mainnet.chain.robinhood.com --port 8599 --chain-id 4663
//   AXON_RPC_URL=http://127.0.0.1:8599 DATABASE_PATH=/tmp/minds-act.db NEXT_PUBLIC_MIND_LAUNCHER=0x… MIND_DEPLOY_BLOCK=… \
//     MIND_SIGNER_KEY=… npx tsx scripts/minds-rehearsal-act.ts
//
// It only ever talks to the local copy: it refuses any RPC that is not on this machine. The signer's key is the one
// the launcher on the copy names as its signer; everybody else is a fresh wallet the copy lets it stand in for.

import { randomBytes } from "node:crypto";
import { createPublicClient, createWalletClient, formatEther, http, parseAbi, parseEther, type Hex } from "viem";

const RPC = process.env.AXON_RPC_URL ?? "";
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(RPC)) throw new Error("AXON_RPC_URL must be a local copy of the chain");
if (!process.env.DATABASE_PATH?.startsWith("/tmp/") && !process.env.DATABASE_PATH?.startsWith("/private/tmp/")) throw new Error("DATABASE_PATH must be a throwaway file under /tmp");
process.env.AGENT_MINDS = "on"; process.env.MINDS_THINKING = "live"; process.env.MINDS_ACTING = "on"; process.env.ANTHROPIC_API_KEY = "not-a-key"; process.env.MINDS_DAILY_BUDGET_USD = "1000";

const PONS = "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e" as const;
const AXON_POT = "0x419fCbc1c4A7f85BB517f3C12D13068Db0D49cB9" as const;
const chain = { id: 4663, name: "copy", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const;
const pub = createPublicClient({ chain, transport: http(RPC) });
const wallet = createWalletClient({ chain, transport: http(RPC) });
const rpc = (method: string, params: unknown[] = []) => pub.request({ method: method as never, params: params as never });

const L = parseAbi([
  "function signer() view returns (address)", "function costSink() view returns (address)",
  "function launch((string name,string symbol,string logo,string description,(string twitter,string telegram,string discord,string website,string farcaster) socials,bytes32 salt,bytes32 agentRef,uint16 taxBps,address payout,uint16 creatorBps,uint16 burnBps,uint16 axonBps,uint16 mindBps,(uint8 allowed,uint96 maxPerDay,uint96 maxPerAction,uint16 maxActionsPerDay,uint96 maxCostPerDay) limits) in_) payable returns (address token)",
]);
const F = parseAbi(["function launchFee() view returns (uint256)", "function getLaunchedToken(address) view returns ((address token,address curve,address deployer,address creatorFeeRecipient,address pairToken,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,uint16 creatorTaxBps,bool buybackEnabled,uint8 phase,uint256 sweptQuote,uint256 sweptTokens,uint256 sweptAt,bool exists))"]);
const C = parseAbi(["function buy(uint256,uint256,address) payable returns (uint256)"]);
const V = parseAbi([
  "function totalBuyback() view returns (uint256)", "function totalAxon() view returns (uint256)", "function totalRewarded() view returns (uint256)", "function totalClaimed() view returns (uint256)", "function totalThinking() view returns (uint256)",
  "function reserved() view returns (uint256)", "function available() view returns (uint256)", "function setPaused(bool)", "function claim(uint256 id, uint256 index, address account, uint256 amount, bytes32[] proof)",
]);
const P = parseAbi(["function totalTokensBurned() view returns (uint256)", "function totalEthBurned() view returns (uint256)"]);

let failed = 0;
const check = (what: string, ok: boolean, detail = "") => { if (!ok) failed++; console.log(`${ok ? "  ok  " : "  FAIL"} ${what}${detail ? `  (${detail})` : ""}`); };
const sent = async (hash: Hex) => { const r = await pub.waitForTransactionReceipt({ hash }); if (r.status !== "success") throw new Error(`reverted: ${hash}`); return r; };
const fresh = async (funded = true) => { const a = `0x${randomBytes(20).toString("hex")}` as Hex; await rpc("anvil_impersonateAccount", [a]); if (funded) await rpc("anvil_setBalance", [a, "0x56BC75E2D63100000"]); return a; };
const skip = async (seconds: number) => { await rpc("evm_increaseTime", [seconds]); await rpc("evm_mine"); };
const bal = (a: string) => pub.getBalance({ address: a as Hex });
const eth = (wei: bigint) => Number(formatEther(wei));

async function main() {
  // a fresh copy cannot answer a read until it has made a block of its own
  await rpc("evm_mine");
  const launcher = process.env.NEXT_PUBLIC_MIND_LAUNCHER as Hex;
  const { privateKeyToAccount } = await import("viem/accounts");
  const signer = privateKeyToAccount((process.env.MIND_SIGNER_KEY ?? "") as Hex).address;
  check("the key this run holds is the launcher's own signer", (await pub.readContract({ address: launcher, abi: L, functionName: "signer" })).toLowerCase() === signer.toLowerCase(), signer);
  await rpc("anvil_setBalance", [signer, "0x2386F26FC10000"]); // 0.01 ETH of gas for the signer
  const costSink = await pub.readContract({ address: launcher, abi: L, functionName: "costSink" });
  const signerStart = await bal(signer);

  const { prepare } = await import("../src/lib/mindsAgent");
  const { indexMinds } = await import("../src/lib/mindsIndex");
  const { refreshStats, board } = await import("../src/lib/mindsStats");
  const { thinkOnce, owedThinkingEth, thoughts } = await import("../src/lib/mindsMind");
  const { actDue, keepUp, payThinkingDue, sharesOf } = await import("../src/lib/mindsAct");
  const { getDb } = await import("../src/lib/db");
  const read = async () => { await indexMinds(); await refreshStats(); return board()[0]; };

  console.log("1. A token is launched and three wallets buy it");
  const creator = await fresh();
  const p = prepare(creator, { name: "Slow River", symbol: "SLOW", line: "Turns long documents into short, clear briefs", logo: "https://example.com/slow.png" });
  if (typeof p === "string") throw new Error(p);
  const fee = await pub.readContract({ address: PONS, abi: F, functionName: "launchFee" });
  const limits = { allowed: 7, maxPerDay: parseEther("0.05"), maxPerAction: parseEther("0.01"), maxActionsPerDay: 6, maxCostPerDay: parseEther("0.002") };
  await sent(await wallet.writeContract({ account: creator, address: launcher, abi: L, functionName: "launch", gas: 12_000_000n, value: fee, args: [{ name: "Slow River", symbol: "SLOW", logo: "https://example.com/slow.png", description: "x", socials: { twitter: "", telegram: "", discord: "", website: "", farcaster: "" }, salt: p.ref as Hex, agentRef: p.ref as Hex, taxBps: 300, payout: creator, creatorBps: 5000, burnBps: 2000, axonBps: 1000, mindBps: 2000, limits }] }));
  let t = await read();
  check("the site read the launch", t?.symbol === "SLOW" && t.creator === creator.toLowerCase(), t?.token);
  const vault = t.vault as Hex, pot = t.pot as Hex, token = t.token as Hex;
  const info = await pub.readContract({ address: PONS, abi: F, functionName: "getLaunchedToken", args: [token] });
  await skip(600);
  const holders: Hex[] = [];
  for (const amt of ["0.6", "0.9", "0.3"]) { const who = await fresh(); holders.push(who); await sent(await wallet.writeContract({ account: who, address: info.curve, abi: C, functionName: "buy", args: [parseEther(amt), 0n, who], value: parseEther(amt), gas: 3_000_000n })); }

  console.log("2. The signer moves the fees: the four shares are paid, the mind's treasury is filled");
  check("nothing has reached the treasury yet", (await bal(vault)) === 0n);
  check("the signer swept the fees", (await keepUp())?.swept === 1);
  t = await read();
  const filled = await bal(vault);
  check("the treasury holds the mind's share", filled > 0n && t.treasuryEth === eth(filled), `${formatEther(filled)} ETH`);
  check("the board counts three holders", t.holders === 3, String(t.holders));

  // the mind says what the test tells it to; everything after that is the real path
  let T = Date.now();
  const propose = async (action: unknown, costUsd = 0.02) => {
    T += 11 * 60_000;
    getDb().prepare("INSERT INTO mind_events (token, kind, eth, at) VALUES (?, 'fees', 0.001, ?)").run(token.toLowerCase(), new Date(T).toISOString());
    const r = await thinkOnce(token, { now: T, usdPerEth: 2500, thinker: async () => ({ text: JSON.stringify({ thought: "The treasury has room for this inside my limits.", action }), inputTokens: 1200, outputTokens: 200, costUsd }) });
    if ("skipped" in r) throw new Error(`the mind did not think: ${r.skipped}`);
    return r;
  };

  console.log("3. A buyback: proposed, passed, sent by the signer, and burned by the pot");
  const potBefore = await bal(pot);
  const a = await propose({ kind: "buyback", eth: 0.002 });
  check("the rule check passed it", a.verdict === "approved");
  check("the signer sent it", (await actDue({ now: T }))?.done === 1);
  check("the treasury's own count says 0.002 ETH bought back", (await pub.readContract({ address: vault, abi: V, functionName: "totalBuyback" })) === parseEther("0.002"));
  check("that ETH is in the token's burn pot", (await bal(pot)) - potBefore === parseEther("0.002"));
  check("the public journal links the transaction", thoughts(token)[0].sent?.status === "done" && /^0x[0-9a-f]{64}$/.test(thoughts(token)[0].sent?.txHash ?? ""));
  await skip(1900);
  const burnedBefore = await pub.readContract({ address: pot, abi: P, functionName: "totalTokensBurned" });
  check("half an hour on the signer lets the pot burn", (await keepUp())?.burned === 1);
  check("tokens were burned", (await pub.readContract({ address: pot, abi: P, functionName: "totalTokensBurned" })) > burnedBefore, `${Math.round(eth((await pub.readContract({ address: pot, abi: P, functionName: "totalTokensBurned" })) - burnedBefore))} $SLOW`);

  console.log("4. A $AXON burn");
  const axonBefore = await bal(AXON_POT);
  await propose({ kind: "burn_axon", eth: 0.001 });
  check("sent", (await actDue({ now: T }))?.done === 1);
  check("$AXON's own burn pot received exactly 0.001 ETH", (await bal(AXON_POT)) - axonBefore === parseEther("0.001"));
  check("the treasury's count agrees", (await pub.readContract({ address: vault, abi: V, functionName: "totalAxon" })) === parseEther("0.001"));

  console.log("5. A reward: set aside against a root, claimed by a holder with the proof the site keeps");
  await read();
  await propose({ kind: "reward", eth: 0.003 });
  check("sent", (await actDue({ now: T }))?.done === 1);
  check("0.003 ETH is set aside in the treasury", (await pub.readContract({ address: vault, abi: V, functionName: "reserved" })) === parseEther("0.003"));
  const mine = holders.map((h) => sharesOf(h, 0)[0]);
  check("every holder has a share, and the shares are all of it", mine.every(Boolean) && mine.reduce((s, x) => s + BigInt(x.amountWei), 0n) === parseEther("0.003"), mine.map((x) => x?.amountEth).join(" + "));
  // a share is by what each wallet holds, as the token itself counts it
  const held = await Promise.all(holders.map((h) => pub.readContract({ address: token, abi: parseAbi(["function balanceOf(address) view returns (uint256)"]), functionName: "balanceOf", args: [h] })));
  const all = held.reduce((x, y) => x + y, 0n);
  check("each share is that holder's part of the tokens held, to the wei", mine.every((x, i) => { const exact = (parseEther("0.003") * held[i]) / all; const d = BigInt(x.amountWei) - exact; return d >= 0n && d <= 2n; }), held.map((h) => `${Math.round(eth(h) / 1e6)}M`).join(" / "));
  const claim = (who: Hex, s: (typeof mine)[number], amount = BigInt(s.amountWei)) => wallet.writeContract({ account: who, address: vault, abi: V, functionName: "claim", args: [BigInt(s.rewardId), BigInt(s.index), who, amount, s.proof as Hex[]], gas: 500_000n });
  const early = await claim(holders[0], mine[0]).then(sent).then(() => true).catch(() => false);
  check("a claim before the wait is over is refused by the treasury", !early);
  await skip(1900);
  const before = await bal(holders[1]);
  const r = await sent(await claim(holders[1], mine[1]));
  check("a holder claims their share with the stored proof", (await bal(holders[1])) - before + r.gasUsed * r.effectiveGasPrice === BigInt(mine[1].amountWei), `${mine[1].amountEth} ETH`);
  check("the same share cannot be claimed twice", !(await claim(holders[1], mine[1]).then(sent).then(() => true).catch(() => false)));
  check("a share cannot be claimed for more than it is", !(await claim(holders[0], mine[0], BigInt(mine[0].amountWei) + 1n).then(sent).then(() => true).catch(() => false)));
  const stranger = await fresh();
  check("a stranger cannot claim somebody's share to themselves", !(await wallet.writeContract({ account: stranger, address: vault, abi: V, functionName: "claim", args: [BigInt(mine[0].rewardId), BigInt(mine[0].index), stranger, BigInt(mine[0].amountWei), mine[0].proof as Hex[]], gas: 500_000n }).then(sent).then(() => true).catch(() => false)));
  check("the treasury's count of claims is that one share", (await pub.readContract({ address: vault, abi: V, functionName: "totalClaimed" })) === BigInt(mine[1].amountWei));

  console.log("6. The mind pays for its thinking, at cost, to the cost wallet");
  await propose(null, 1.5); // a dear thought: 0.0006 ETH at this price
  const owed = owedThinkingEth(token);
  const sinkBefore = await bal(costSink);
  check("it owes for its thinking", owed > 0.0006, `${owed} ETH`);
  check("the treasury paid", (await payThinkingDue()) === 1);
  const paid = (await bal(costSink)) - sinkBefore;
  check("the cost wallet received what was owed, to the gwei", Math.abs(eth(paid) - owed) < 1e-9, `${formatEther(paid)} ETH`);
  check("the treasury's count agrees, and nothing is owed now", (await pub.readContract({ address: vault, abi: V, functionName: "totalThinking" })) === paid && owedThinkingEth(token) < 1e-9);

  console.log("7. What is refused stays unsent");
  const big = await propose({ kind: "buyback", eth: 0.5 });
  check("a proposal past its limits is refused by the rule check", big.verdict === "refused");
  check("and nothing is sent for it", JSON.stringify(await actDue({ now: T })) === JSON.stringify({ done: 0, failed: 0, dropped: 0 }));
  const late = await propose({ kind: "buyback", eth: 0.001 });
  await sent(await wallet.writeContract({ account: creator, address: vault, abi: V, functionName: "setPaused", args: [true], gas: 200_000n }));
  const dropped = await actDue({ now: T });
  check("a proposal passed before its creator paused the mind is dropped on the second look", late.verdict === "approved" && dropped?.dropped === 1 && /stopped/.test(thoughts(token)[0].sent?.error ?? ""), thoughts(token)[0].sent?.error ?? "");
  check("the treasury's buyback count has not moved", (await pub.readContract({ address: vault, abi: V, functionName: "totalBuyback" })) === parseEther("0.002"));

  console.log("8. Where the money is");
  const left = await bal(vault);
  const out = parseEther("0.002") + parseEther("0.001") + BigInt(mine[1].amountWei) + paid;
  check("the treasury holds what came in less exactly what went out", left === filled - out + ((await read()).toMindEth > eth(filled) ? parseEther(String((await read()).toMindEth)) - filled : 0n), `${formatEther(left)} ETH left`);
  check("of that, the two unclaimed shares are still set aside", (await pub.readContract({ address: vault, abi: V, functionName: "reserved" })) === parseEther("0.003") - BigInt(mine[1].amountWei));
  console.log(`   the signer spent ${formatEther(signerStart - (await bal(signer)))} ETH on gas for all of it (the copy's gas price is about 50 times the real chain's)`);

  console.log(failed ? `\n${failed} check(s) FAILED` : "\nEverything that moved matches the chain copy, and nothing moved that was not allowed.");
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
