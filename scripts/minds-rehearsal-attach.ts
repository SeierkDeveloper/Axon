// Agent Minds on a copy of the chain: a token launched the EARLIER way (its own burn pot, through the agent-token
// factory, before minds) is given a mind by the wallet that launched it, topped up, and its mind acts.
//
//   anvil --fork-url https://rpc.mainnet.chain.robinhood.com --port 8599 --chain-id 4663
//   AXON_RPC_URL=http://127.0.0.1:8599 DATABASE_PATH=/tmp/minds-attach.db NEXT_PUBLIC_MIND_LAUNCHER=0x… MIND_DEPLOY_BLOCK=… \
//     NEXT_PUBLIC_AGENT_LAUNCH_FACTORY=0x… MIND_SIGNER_KEY=… npx tsx scripts/minds-rehearsal-attach.ts
//
// It only ever talks to the local copy.

import { randomBytes } from "node:crypto";
import { createPublicClient, createWalletClient, formatEther, http, parseAbi, parseEther, type Hex } from "viem";
import { FACTORY_ABI, POT_ABI, launchParams } from "../src/lib/launchAbi";

const RPC = process.env.AXON_RPC_URL ?? "";
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(RPC)) throw new Error("AXON_RPC_URL must be a local copy of the chain");
if (!process.env.DATABASE_PATH?.startsWith("/tmp/") && !process.env.DATABASE_PATH?.startsWith("/private/tmp/")) throw new Error("DATABASE_PATH must be a throwaway file under /tmp");
process.env.AGENT_MINDS = "on"; process.env.MINDS_THINKING = "live"; process.env.MINDS_ACTING = "on"; process.env.ANTHROPIC_API_KEY = "not-a-key"; process.env.OPENROUTER_API_KEY = "not-a-key";

const PONS = "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e" as const;
const chain = { id: 4663, name: "copy", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const;
const pub = createPublicClient({ chain, transport: http(RPC) });
const wallet = createWalletClient({ chain, transport: http(RPC) });
const rpc = (method: string, params: unknown[] = []) => pub.request({ method: method as never, params: params as never });
const X = parseAbi(["function launchFee() view returns (uint256)", "function potOf(address) view returns (address)", "function token() view returns (address)", "function totalBuyback() view returns (uint256)", "function totalTokensBurned() view returns (uint256)", "function vaultOf(address) view returns (address)"]);

let failed = 0;
const check = (what: string, ok: boolean, detail = "") => { if (!ok) failed++; console.log(`${ok ? "  ok  " : "  FAIL"} ${what}${detail ? `  (${detail})` : ""}`); };
const sent = async (hash: Hex) => { const r = await pub.waitForTransactionReceipt({ hash }); if (r.status !== "success") throw new Error(`reverted: ${hash}`); return r; };
const fresh = async () => { const a = `0x${randomBytes(20).toString("hex")}` as Hex; await rpc("anvil_impersonateAccount", [a]); await rpc("anvil_setBalance", [a, "0x56BC75E2D63100000"]); return a; };
const skip = async (seconds: number) => { await rpc("evm_increaseTime", [seconds]); await rpc("evm_mine"); };

async function main() {
  await rpc("evm_mine");
  const launcher = process.env.NEXT_PUBLIC_MIND_LAUNCHER as Hex, factory = process.env.NEXT_PUBLIC_AGENT_LAUNCH_FACTORY as Hex;
  const { privateKeyToAccount } = await import("viem/accounts");
  await rpc("anvil_setBalance", [privateKeyToAccount((process.env.MIND_SIGNER_KEY ?? "") as Hex).address, "0x2386F26FC10000"]);

  const { checkAttach, suggestAttach, prepareAttach, ATTACH_ABI } = await import("../src/lib/mindsAttach");
  const { indexMinds } = await import("../src/lib/mindsIndex");
  const { refreshStats, board, events } = await import("../src/lib/mindsStats");
  const { thinkOnce, thoughts } = await import("../src/lib/mindsMind");
  const { actDue, keepUp } = await import("../src/lib/mindsAct");
  const { getDb } = await import("../src/lib/db");

  console.log("1. A token is launched the earlier way: its own burn pot, no mind");
  const dev = await fresh(), stranger = await fresh();
  await sent(await wallet.writeContract({ account: stranger, address: factory, abi: FACTORY_ABI, functionName: "deployPair", args: [dev, 7000], gas: 6_000_000n }));
  const pot = await pub.readContract({ address: factory, abi: X, functionName: "potOf", args: [dev] });
  const fee = await pub.readContract({ address: PONS, abi: X, functionName: "launchFee" });
  await sent(await wallet.writeContract({ account: dev, address: pot, abi: POT_ABI, functionName: "launch", args: [launchParams({ name: "Old Timer", symbol: "OLD", logo: "https://example.com/old.png", description: "launched before minds" }, `0x${randomBytes(32).toString("hex")}`), 0n, [dev]], value: fee + parseEther("0.01"), gas: 8_000_000n }));
  const token = await pub.readContract({ address: pot, abi: X, functionName: "token" });
  check("the token exists and has no mind", !/^0x0+$/.test(token) && /^0x0+$/.test(await pub.readContract({ address: launcher, abi: X, functionName: "vaultOf", args: [token] })), token);

  console.log("2. Who may give it a mind, as the site reads it from the chain");
  const mine = await checkAttach(dev, token);
  check("the wallet that launched it may", mine.ok && mine.token.symbol === "OLD" && mine.token.pot === pot.toLowerCase(), `${mine.token.name} $${mine.token.symbol}`);
  check("a stranger may not", (await checkAttach(stranger, token)).reason === "Only the wallet that launched this token can give it a mind.");
  check("the site finds the token from the wallet alone", (await suggestAttach(dev))?.token.token === token.toLowerCase());
  check("a wallet that launched nothing is offered nothing", (await suggestAttach(stranger)) === null);

  console.log("3. Its creator chooses the mind and signs once");
  const prepared = await prepareAttach(dev, { token, model: "x-ai/grok-4.7" });
  if (typeof prepared === "string") throw new Error(prepared);
  const limits = { allowed: 5, maxPerDay: parseEther("0.05"), maxPerAction: parseEther("0.01"), maxActionsPerDay: 6, maxCostPerDay: parseEther("0.002") };
  const refused = await wallet.writeContract({ account: stranger, address: launcher, abi: ATTACH_ABI, functionName: "attachMind", args: [pot, limits], gas: 3_000_000n }).then(sent).then(() => true).catch(() => false);
  check("the launcher refuses a stranger who signs anyway", !refused);
  const r = await sent(await wallet.writeContract({ account: dev, address: launcher, abi: ATTACH_ABI, functionName: "attachMind", args: [prepared.pot as Hex, limits], gas: 3_000_000n }));
  console.log(`   given in block ${r.blockNumber}, gas ${r.gasUsed}`);
  await indexMinds(); await refreshStats();
  let t = board().find((x) => x.token === token.toLowerCase())!;
  check("the site lists it as an earlier token with the mind its creator chose", !!t && t.attached && t.model === "x-ai/grok-4.7" && t.name === "Old Timer" && t.splitter === null, `${t?.name} · ${t?.model}`);
  const vault = t.vault as Hex;
  check("that treasury is the launcher's own record", (await pub.readContract({ address: launcher, abi: X, functionName: "vaultOf", args: [token] })).toLowerCase() === vault);
  check("it cannot be given a second mind", !(await wallet.writeContract({ account: dev, address: launcher, abi: ATTACH_ABI, functionName: "attachMind", args: [pot, limits], gas: 3_000_000n }).then(sent).then(() => true).catch(() => false)) && (await checkAttach(dev, token)).reason === "This token already has a mind.");

  console.log("4. Its treasury is empty until somebody tops it up");
  let T = Date.now();
  const propose = async (action: unknown) => {
    T += 11 * 60_000;
    return thinkOnce(token, { now: T, usdPerEth: 2500, thinker: async () => ({ text: JSON.stringify({ thought: "Looking at what I hold and what I may do with it.", action }), inputTokens: 1200, outputTokens: 200, costUsd: 0.02 }) });
  };
  const empty = await propose(null);
  check("with nothing in it, the mind does not think", "skipped" in empty && empty.skipped === "its treasury cannot pay for a thought yet", "skipped" in empty ? empty.skipped : "it thought");
  await sent(await wallet.sendTransaction({ account: stranger, to: vault, value: parseEther("0.01"), gas: 100_000n }));
  await refreshStats();
  t = board().find((x) => x.token === token.toLowerCase())!;
  check("a top-up from anybody shows in its treasury and in the log", t.treasuryEth === 0.01 && events().some((e) => e.kind === "topup" && e.token === token.toLowerCase()), `${t.treasuryEth} ETH`);

  console.log("5. Its mind acts through the token's own burn pot");
  const potBefore = await pub.getBalance({ address: pot });
  const a = await propose({ kind: "buyback", eth: 0.002 });
  check("woken by the top-up, its buyback passes the rule check", !("skipped" in a) && a.verdict === "approved" && a.reasons.some((x) => /topped up/.test(x)), "skipped" in a ? a.skipped : a.reasons.join("; "));
  check("the signer sent it", (await actDue({ now: T }))?.done === 1);
  check("0.002 ETH left the treasury for the token's own pot", (await pub.readContract({ address: vault, abi: X, functionName: "totalBuyback" })) === parseEther("0.002") && (await pub.getBalance({ address: pot })) - potBefore === parseEther("0.002"));
  await skip(1900);
  const burnedBefore = await pub.readContract({ address: pot, abi: X, functionName: "totalTokensBurned" });
  await keepUp();
  const burned = (await pub.readContract({ address: pot, abi: X, functionName: "totalTokensBurned" })) - burnedBefore;
  check("the earlier pot burned with it", burned > 0n, `${Math.round(Number(formatEther(burned)))} $OLD`);
  const reward = await propose({ kind: "reward", eth: 0.001 });
  getDb().prepare("INSERT INTO mind_events (token, kind, eth, at) VALUES (?, 'topup', 0.0001, ?)").run(token.toLowerCase(), new Date(T).toISOString());
  const again = "skipped" in reward ? await propose({ kind: "reward", eth: 0.001 }) : reward;
  // refused twice over: its creator never allowed rewards (the screen does not offer them), and the rule check would
  // refuse one for an earlier token even if they had
  check("a reward is refused", !("skipped" in again) && again.verdict === "refused", "skipped" in again ? again.skipped : again.verdictReason ?? "");
  check("and nothing is sent for it", JSON.stringify(await actDue({ now: T })) === JSON.stringify({ done: 0, failed: 0, dropped: 0 }) && thoughts(token)[0].sent === null);

  console.log(failed ? `\n${failed} check(s) FAILED` : "\nAn earlier token got its mind from its own creator, and everything it did matches the chain copy.");
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
