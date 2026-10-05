// Agent Minds on a copy of the chain: deploy the launcher, prepare and launch a token, trade it, split its fees, let
// the mind act, then read all of it back the way the site does and compare every number with the chain itself.
//
//   anvil --fork-url https://rpc.mainnet.chain.robinhood.com --port 8599 --chain-id 4663
//   AXON_RPC_URL=http://127.0.0.1:8599 DATABASE_PATH=/tmp/minds-rehearsal.db npx tsx scripts/minds-rehearsal.ts
//
// It only ever talks to the local copy: it refuses any RPC that is not on this machine, and signs as wallets the copy
// lets it stand in for, so no key is involved.

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, formatEther, http, parseAbi, parseEther, toFunctionSelector, type Hex } from "viem";

const RPC = process.env.AXON_RPC_URL ?? "";
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(RPC)) throw new Error("AXON_RPC_URL must be a local copy of the chain");
if (!process.env.DATABASE_PATH?.startsWith("/tmp/") && !process.env.DATABASE_PATH?.startsWith("/private/tmp/")) throw new Error("DATABASE_PATH must be a throwaway file under /tmp");

const PONS = "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e" as const;
const AXON_POT = "0x419fCbc1c4A7f85BB517f3C12D13068Db0D49cB9" as const;
const chain = { id: 4663, name: "copy", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const;
const pub = createPublicClient({ chain, transport: http(RPC) });
const wallet = createWalletClient({ chain, transport: http(RPC) });
const artifact = (name: string) => JSON.parse(readFileSync(`contracts/out/${name}.sol/${name}.json`, "utf8")) as { abi: readonly unknown[]; bytecode: { object: Hex } };

const PONS_ABI = parseAbi(["function launchFee() view returns (uint256)"]);
const CURVE_ABI = parseAbi(["function buy(uint256, uint256, address) payable returns (uint256)"]);
const SPLITTER_WRITE = parseAbi(["function sweep() returns (uint256)"]);
const VAULT_WRITE = parseAbi(["function buyback(uint256 amount)", "function burnAxon(uint256 amount)", "function payThinking(uint256 amount)"]);
const RAW = parseAbi([
  "function available() view returns (uint256)", "function reserved() view returns (uint256)", "function totalBuyback() view returns (uint256)",
  "function totalAxon() view returns (uint256)", "function totalThinking() view returns (uint256)", "function totalSplit() view returns (uint256)",
  "function totalToCreator() view returns (uint256)", "function totalToBurn() view returns (uint256)", "function totalToAxon() view returns (uint256)", "function totalToMind() view returns (uint256)",
]);

let failed = 0;
const check = (what: string, ok: boolean, detail = "") => { if (!ok) failed++; console.log(`${ok ? "  ok  " : "  FAIL"} ${what}${detail ? `  (${detail})` : ""}`); };
const eth = (wei: bigint) => Number(formatEther(wei));
const sent = async (hash: Hex) => { const r = await pub.waitForTransactionReceipt({ hash }); if (r.status !== "success") throw new Error(`reverted: ${hash}`); return r; };
const skip = async (seconds: number) => { await pub.request({ method: "evm_increaseTime" as never, params: [seconds] as never }); await pub.request({ method: "evm_mine" as never, params: [] as never }); };

async function main() {
  // fresh wallets nobody has a key to: the copy's own well-known test wallets carry sweeper code on the real chain,
  // which forwards anything they receive
  const fresh = async (funded: boolean) => {
    const a = `0x${randomBytes(20).toString("hex")}` as `0x${string}`;
    await pub.request({ method: "anvil_impersonateAccount" as never, params: [a] as never });
    if (funded) await pub.request({ method: "anvil_setBalance" as never, params: [a, "0x56BC75E2D63100000"] as never });
    return a;
  };
  const [deployer, signer, creator, trader] = await Promise.all([fresh(true), fresh(true), fresh(true), fresh(true)]);
  const [guardian, costSink, payout] = await Promise.all([fresh(false), fresh(false), fresh(false)]);

  console.log("1. Deploy the launcher on the copy");
  const L = artifact("MindLauncher");
  const deployed = await sent(await wallet.deployContract({ account: deployer, abi: L.abi, bytecode: L.bytecode.object, args: [PONS, AXON_POT, guardian, signer, costSink], gas: 15_000_000n } as never));
  const launcher = deployed.contractAddress!;
  console.log(`   launcher ${launcher} at block ${deployed.blockNumber}, gas ${deployed.gasUsed}`);
  process.env.AGENT_MINDS = "on";
  process.env.NEXT_PUBLIC_MIND_LAUNCHER = launcher;
  process.env.MIND_DEPLOY_BLOCK = String(deployed.blockNumber);

  // the site's own code, loaded after the settings above are in place
  const { prepare } = await import("../src/lib/mindsAgent");
  const { indexMinds, liveToken } = await import("../src/lib/mindsIndex");
  const { getToken, getPrepared, listTokens } = await import("../src/lib/mindsStore");
  const { getAgentById } = await import("../src/lib/agents");
  const { getInstructions } = await import("../src/lib/agentKnowledge");

  console.log("2. Prepare a launch the way the form will, then launch it in one transaction");
  const line = "Reads a company's filings and explains what changed";
  const p = prepare(creator, { name: "Ledger Lens", symbol: "LENS", line, logo: "https://example.com/lens.png" });
  if (typeof p === "string") throw new Error(p);
  const fee = await pub.readContract({ address: PONS, abi: PONS_ABI, functionName: "launchFee" });
  const openingBuy = parseEther("0.01");
  const limits = { allowed: 7, maxPerDay: parseEther("0.05"), maxPerAction: parseEther("0.01"), maxActionsPerDay: 6, maxCostPerDay: parseEther("0.002") };
  const input = {
    name: "Ledger Lens", symbol: "LENS", logo: "https://example.com/lens.png", description: line,
    socials: { twitter: "", telegram: "", discord: "", website: "", farcaster: "" },
    salt: p.ref as Hex, agentRef: p.ref as Hex, taxBps: 300, payout, creatorBps: 5000, burnBps: 2000, axonBps: 1000, mindBps: 2000, limits,
  };
  const before = { payout: await pub.getBalance({ address: payout }), axonPot: await pub.getBalance({ address: AXON_POT }), sink: await pub.getBalance({ address: costSink }), guardian: await pub.getBalance({ address: guardian }) };
  const launchTx = await sent(await wallet.writeContract({ account: creator, address: launcher, abi: L.abi, functionName: "launch", args: [input], value: fee + openingBuy, gas: 12_000_000n } as never));
  console.log(`   launched in block ${launchTx.blockNumber}, gas ${launchTx.gasUsed}`);

  console.log("3. The site reads the launcher's events");
  const pass = await indexMinds();
  check("the pass found the launch", pass?.added === 1, JSON.stringify(pass));
  const row = listTokens(1)[0];
  const coin = (await pub.readContract({ address: launcher, abi: L.abi, functionName: "coin", args: [row.token as Hex] })) as { creator: string; pot: string; splitter: string; vault: string; payout: string; taxBps: number; creatorBps: number; burnBps: number; axonBps: number; mindBps: number; agentRef: string };
  const same = (a: string | null, b: string) => a?.toLowerCase() === b.toLowerCase();
  check("creator, pot, splitter, treasury and payout are the launcher's own record", same(row.creator, coin.creator) && same(row.pot, coin.pot) && same(row.splitter, coin.splitter) && same(row.vault, coin.vault) && same(row.payout, coin.payout));
  check("tax and the four shares are the launcher's own record", row.taxBps === coin.taxBps && row.creatorBps === coin.creatorBps && row.burnBps === coin.burnBps && row.axonBps === coin.axonBps && row.mindBps === coin.mindBps, `${row.taxBps} / ${row.creatorBps} ${row.burnBps} ${row.axonBps} ${row.mindBps}`);
  check("the token's own name and ticker were read", row.name === "Ledger Lens" && row.symbol === "LENS", `${row.name} ${row.symbol}`);
  const block = await pub.getBlock({ blockNumber: launchTx.blockNumber });
  check("the launch time is the block's own", row.launchedAt === new Date(Number(block.timestamp) * 1000).toISOString(), row.launchedAt);
  const agent = row.agentId ? getAgentById(row.agentId) : null;
  check("a starter agent was made for the creator's wallet", !!agent && same(agent.walletAddress ?? null, creator), agent?.agentId);
  check("its instructions carry the creator's line", !!agent && (getInstructions(agent.agentId) ?? "").includes(line));
  check("the prepared launch is marked launched", getPrepared(p.ref)?.status === "launched" && same(getPrepared(p.ref)!.token, row.token));
  check("a second pass adds nothing", (await indexMinds())?.added === 0);

  console.log("4. Somebody trades, the fees are split, the mind acts");
  // the factory's record of the token: the curve is the word after the token's own address
  const info = await pub.call({ to: PONS, data: `${toFunctionSelector("getLaunchedToken(address)")}${row.token.slice(2).padStart(64, "0")}` as Hex });
  const words = info.data!.slice(2).match(/.{64}/g)!;
  const first = words.findIndex((w) => w.endsWith(row.token.slice(2).toLowerCase()));
  const curve = `0x${words[first + 1].slice(24)}` as Hex;
  await skip(600);
  await sent(await wallet.writeContract({ account: trader, address: curve, abi: CURVE_ABI, functionName: "buy", args: [parseEther("0.5"), 0n, trader], value: parseEther("0.5"), gas: 3_000_000n }));
  const splitter = row.splitter as Hex, vault = row.vault as Hex, pot = row.pot as Hex;
  const potBefore = await pub.getBalance({ address: pot });
  await sent(await wallet.writeContract({ account: trader, address: splitter, abi: SPLITTER_WRITE, functionName: "sweep", gas: 3_000_000n }));
  const raw = (address: Hex, functionName: (typeof RAW)[number]["name"]) => pub.readContract({ address, abi: RAW, functionName });
  const total = await raw(splitter, "totalSplit");
  const [toCreator, toBurn, toAxon, toMind] = await Promise.all([raw(splitter, "totalToCreator"), raw(splitter, "totalToBurn"), raw(splitter, "totalToAxon"), raw(splitter, "totalToMind")]);
  check("the trade left fees and the four shares are all of them", total > 0n && toCreator + toBurn + toAxon + toMind === total, `${formatEther(total)} ETH`);
  check("burn 20%, $AXON 10%, mind 20%, the rest to the creator", toBurn === (total * 2000n) / 10000n && toAxon === (total * 1000n) / 10000n && toMind === (total * 2000n) / 10000n);
  check("the payout wallet received the creator's share", (await pub.getBalance({ address: payout })) - before.payout === toCreator);
  check("the token's burn pot received the burn share", (await pub.getBalance({ address: pot })) - potBefore === toBurn);
  check("$AXON's burn pot received its share", (await pub.getBalance({ address: AXON_POT })) - before.axonPot === toAxon);
  check("the mind's treasury holds the mind's share", (await pub.getBalance({ address: vault })) === toMind);
  check("nothing stays in the splitter or the launcher", (await pub.getBalance({ address: splitter })) === 0n && (await pub.getBalance({ address: launcher })) === 0n);

  const buy = toMind / 4n, axon = toMind / 10n, think = parseEther("0.0001") < toMind / 4n ? parseEther("0.0001") : toMind / 20n;
  await sent(await wallet.writeContract({ account: signer, address: vault, abi: VAULT_WRITE, functionName: "buyback", args: [buy], gas: 3_000_000n }));
  await sent(await wallet.writeContract({ account: signer, address: vault, abi: VAULT_WRITE, functionName: "burnAxon", args: [axon], gas: 3_000_000n }));
  const sinkGas = await pub.getBalance({ address: costSink });
  await sent(await wallet.writeContract({ account: signer, address: vault, abi: VAULT_WRITE, functionName: "payThinking", args: [think], gas: 3_000_000n }));
  check("thinking was paid to the cost wallet, to the wei", (await pub.getBalance({ address: costSink })) - sinkGas === think);
  check("the guardian received nothing", (await pub.getBalance({ address: guardian })) === before.guardian);

  console.log("5. The token's page numbers against the chain");
  const live = (await liveToken(row.token))!;
  const t = live.treasury!, f = live.fees!;
  check("fees: total and the four shares", f.totalEth === eth(total) && f.toCreatorEth === eth(toCreator) && f.toBurnEth === eth(toBurn) && f.toAxonEth === eth(toAxon) && f.toMindEth === eth(toMind), `${f.totalEth} = ${f.toCreatorEth} + ${f.toBurnEth} + ${f.toAxonEth} + ${f.toMindEth}`);
  check("treasury: bought back, $AXON burned, thinking", t.boughtBackEth === eth(buy) && t.axonBurnedEth === eth(axon) && t.thinkingEth === eth(think), `${t.boughtBackEth} / ${t.axonBurnedEth} / ${t.thinkingEth}`);
  const left = toMind - buy - axon - think;
  check("treasury: what is left is what the contract holds", t.availableEth === eth(left) && (await pub.getBalance({ address: vault })) === left, `${t.availableEth} ETH`);
  check("treasury: its limits are the ones set at launch", t.limits.allowed === 7 && t.limits.maxPerDayEth === 0.05 && t.limits.maxPerActionEth === 0.01 && t.limits.maxActionsPerDay === 6 && t.limits.maxCostPerDayEth === 0.002);
  check("treasury: running, not paused or frozen", t.active && !t.paused && !t.frozen);
  check("the agent has earned nothing yet, and says so", live.agent?.earnedEth === 0);
  check("the stored token did not change", JSON.stringify(getToken(row.token)) === JSON.stringify(row));

  console.log(failed ? `\n${failed} check(s) FAILED` : "\nEvery number the site reads matches the chain copy.");
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
