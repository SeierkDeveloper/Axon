#!/usr/bin/env node
// Run the outside policy check end to end: Axon's real hire flow, a real allowance, the provider's real API.
//
//   AUREON_TEST_KEY=aureon_... AUREON_OBJ_ALLOW=obj_... AUREON_OBJ_APPROVAL=obj_... AUREON_OBJ_PAUSED=obj_... \
//     node scripts/policy-e2e.mjs
//
// Boots the built app on a scratch database and a local Anvil fork of Robinhood Chain, deploys the real Allowance
// contract on the fork, funds an allowance from a development wallet, links that wallet to AUREON with a test key
// and objectives AUREON gave us, and hires agents through POST /api/tasks exactly as an assistant would. What comes
// back, and what the chain says was set aside, is compared with what AUREON is documented to answer.
//
// The fork's ETH is not real and the model keys are blanked. The only thing that leaves this machine is the policy
// check itself, to AUREON's host, which is the thing under test. The key and the objective ids are read from the
// environment and are never written anywhere.
//
// The objectives are expected to be: ALLOW with a 0.05 ETH cap and no approval, APPROVAL with the same cap where a
// hire inside it still needs the user, and PAUSED, which is paused.

import { spawn, execSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { createPublicClient, createWalletClient, http, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const PORT = Number(process.env.PORT ?? 3189);
const URL = `http://127.0.0.1:${PORT}`;
const ROOT = new globalThis.URL("..", import.meta.url).pathname;
const AGENT_OWNER = "0x1111111111111111111111111111111111111111";
const AXON_TOKEN = "0xB5E40b5F16996E9D76ec2B16E7A4Ead3c06a9Fa2";
const RECEIVER = "0x419fCbc1c4A7f85BB517f3C12D13068Db0D49cB9";

const AUREON_KEY = process.env.AUREON_TEST_KEY?.trim();
const OBJ = { allow: process.env.AUREON_OBJ_ALLOW?.trim(), approval: process.env.AUREON_OBJ_APPROVAL?.trim(), paused: process.env.AUREON_OBJ_PAUSED?.trim() };
if (!AUREON_KEY || !OBJ.allow || !OBJ.approval || !OBJ.paused) {
  console.error("Set AUREON_TEST_KEY, AUREON_OBJ_ALLOW, AUREON_OBJ_APPROVAL and AUREON_OBJ_PAUSED.");
  process.exit(2);
}

// Anvil's standard development keys: the fork gives each of them test ETH.
const DEPLOYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const ALLOWANCE_OWNER_KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";
const OPERATOR_KEY = "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6";
const ANVIL = [join(homedir(), ".foundry/bin/anvil")].find(existsSync);
const FORK_RPC = `http://127.0.0.1:${PORT + 1}`;

const dir = mkdtempSync(join(tmpdir(), "axon-policy-e2e-"));
let server;
let anvil;
let failures = 0;
const say = (s) => process.stdout.write(`${s}\n`);
const pass = (label, detail = "") => say(`  PASS  ${label}${detail ? `  ${detail}` : ""}`);
const fail = (label, detail) => { say(`  FAIL  ${label}  ${detail}`); failures++; };
const expect = (label, ok, detail) => (ok ? pass(label, typeof detail === "string" ? detail : "") : fail(label, typeof detail === "string" ? detail : JSON.stringify(detail)));

function cleanup() {
  if (server && !server.killed) server.kill("SIGTERM");
  if (anvil && !anvil.killed) anvil.kill("SIGTERM");
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* it was temporary anyway */ }
}
process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(130); });
process.on("SIGTERM", () => { cleanup(); process.exit(143); });

const env = {
  ...process.env,
  DATABASE_PATH: join(dir, "e2e.db"),
  PORT: String(PORT),
  TELEGRAM_BOT_TOKEN: "",
  TELEGRAM_CHANNEL_ID: "",
  NEXT_PUBLIC_PAYMENT_RECEIVER_WALLET_ADDRESS: RECEIVER,
  AXON_SETTLEMENT_TOKEN_ADDRESS: AXON_TOKEN,
  AXON_TOKEN_ADDRESS: AXON_TOKEN,
  AXON_RPC_URL: process.env.AXON_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com",
  CRON_SECRET: "policy-e2e",
  SEED_SECRET: "policy-e2e-secret",
  ANTHROPIC_API_KEY: "",
  OPENAI_API_KEY: "",
  XAI_API_KEY: "",
  OPENROUTER_API_KEY: "",
  POLICY_CHECKS: "on",
};
// The server never needs these: the key reaches it the way a user's would, through the link route.
for (const k of ["AUREON_TEST_KEY", "AUREON_OBJ_ALLOW", "AUREON_OBJ_APPROVAL", "AUREON_OBJ_PAUSED"]) delete env[k];

const run = (cmd) => execSync(cmd, { cwd: ROOT, env, encoding: "utf8" });
const mintKey = (wallet) => run(`npx tsx -e 'import { createApiKey } from "@/lib/identity"; console.log(createApiKey("${wallet}").apiKey);'`).trim().split("\n").pop();

async function api(method, path, key, body) {
  const res = await fetch(`${URL}${path}`, { method, headers: { "content-type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function main() {
  if (!ANVIL) throw new Error("Anvil is needed for this: the hires pay from a real allowance on a fork");
  if (!existsSync(join(ROOT, ".next"))) throw new Error("build the app first: npm run build");
  const artifact = join(ROOT, "contracts/out/Allowance.sol/Allowance.json");
  if (!existsSync(artifact)) execSync("forge build", { cwd: join(ROOT, "contracts"), stdio: "ignore", env: { ...process.env, PATH: `${join(homedir(), ".foundry/bin")}:${process.env.PATH}` } });

  anvil = spawn(ANVIL, ["--fork-url", env.AXON_RPC_URL, "--port", String(PORT + 1), "--silent"], { stdio: "ignore" });
  const pub = createPublicClient({ transport: http(FORK_RPC) });
  for (let i = 0; i < 120; i++) { try { await pub.getChainId(); break; } catch { await new Promise((r) => setTimeout(r, 500)); } }

  const { abi, bytecode } = JSON.parse(readFileSync(artifact, "utf8"));
  const deployer = createWalletClient({ account: privateKeyToAccount(DEPLOYER_KEY), transport: http(FORK_RPC) });
  const hash = await deployer.deployContract({ abi, bytecode: bytecode.object, args: [RECEIVER, AXON_TOKEN, deployer.account.address, privateKeyToAccount(OPERATOR_KEY).address], chain: null });
  const address = (await pub.waitForTransactionReceipt({ hash })).contractAddress;

  // An allowance wide enough that its own limits never refuse these hires: every refusal below is the provider's.
  const ownerWallet = createWalletClient({ account: privateKeyToAccount(ALLOWANCE_OWNER_KEY), transport: http(FORK_RPC) });
  const block = await pub.getBlock();
  for (const [functionName, args, value] of [
    ["deposit", [], parseEther("1")],
    ["setRules", ["0x0000000000000000000000000000000000000000", parseEther("0.1"), parseEther("1"), block.timestamp + 30n * 86_400n]],
  ]) {
    await pub.waitForTransactionReceipt({ hash: await ownerWallet.writeContract({ address, abi, functionName, args, value, chain: null }) });
  }
  const OWNER = ownerWallet.account.address.toLowerCase();
  Object.assign(env, { AXON_RPC_URL: FORK_RPC, AXON_ALLOWANCE_ADDRESS: address, AXON_ALLOWANCE_OPERATOR_KEY: OPERATOR_KEY });

  say(`allowance on a local fork at ${address}; starting a server on ${URL}`);
  server = spawn("npx", ["next", "start", "-p", String(PORT)], { cwd: ROOT, env, stdio: "ignore" });
  const until = Date.now() + 90_000;
  for (;;) {
    try { if ((await fetch(`${URL}/api/agents`, { signal: AbortSignal.timeout(4_000) })).ok) break; } catch { /* not up yet */ }
    if (Date.now() > until) throw new Error("the server did not come up");
    await new Promise((r) => setTimeout(r, 1_000));
  }

  const agentKey = mintKey(AGENT_OWNER);
  const ownerKey = mintKey(OWNER);
  const AGENTS = { cap: ["policy-agent-cap", "0.05 ETH"], over: ["policy-agent-over", "0.06 ETH"], small: ["policy-agent-small", "0.01 ETH"] };
  for (const [agentId, price] of Object.values(AGENTS)) {
    const r = await api("POST", "/api/agents", agentKey, { agentId, name: agentId, capabilities: ["research"], publicKey: agentId, walletAddress: AGENT_OWNER, price });
    if (r.status >= 300 && r.status !== 409) throw new Error(`could not register ${agentId}: ${r.status} ${JSON.stringify(r.body)}`);
  }

  const reserved = async () => (await api("GET", "/api/allowance", ownerKey)).body.accounts.find((a) => a.token === "ETH").reserved;
  const link = (objectiveId, apiKey = AUREON_KEY) => api("PUT", "/api/allowance/policy", ownerKey, { provider: "aureon", apiKey, objectiveId });
  const hire = (agent, key = ownerKey) => api("POST", "/api/tasks", key, { from: OWNER, to: AGENTS[agent][0], task: `policy check ${agent}`, paymentMethod: "allowance" });
  const latest = async () => (await api("GET", "/api/allowance/policy", ownerKey)).body.recent[0];

  say("\n── before anything is linked ────────────────────────────");
  let r = await api("GET", "/api/allowance/policy", ownerKey);
  expect("the policy check is on and nothing is linked", r.body.enabled === true && r.body.link === null && r.body.recent.length === 0, r.body);
  r = await link(OBJ.allow, "aureon_0000000000000000000000000000000000000000");
  expect("a key AUREON does not know is turned away at link time", r.status === 400 && /did not accept/.test(r.body.error ?? ""), r);

  say("\n── case 01: 0.05 ETH on the allow objective (the cap) ──");
  r = await link(OBJ.allow);
  expect("linked, and the key is not sent back", r.status === 200 && r.body.link?.objectiveId === OBJ.allow && !JSON.stringify(r.body).includes(AUREON_KEY), r);
  r = await hire("cap");
  expect("the hire goes on", r.status === 201 && ["queued", "pending"].includes(r.body.status), r);
  expect("0.05 ETH is set aside in the allowance", (await reserved()) === "0.05", await reserved());
  let c = await latest();
  expect("AUREON's answer is kept", c?.outcome === "allow" && c.amount === "0.05" && c.asset === "ETH", c);
  say(`        AUREON: ${c?.outcome} · "${c?.reason}" · ${c?.ms} ms`);

  say("\n── case 02: 0.06 ETH on the approval objective (over the cap) ──");
  await link(OBJ.approval);
  r = await hire("over");
  expect("the hire stops with AUREON's reason", r.status === 402 && /^AUREON refused this hire: /.test(r.body.error ?? ""), r);
  expect("nothing more is set aside", (await reserved()) === "0.05", await reserved());
  c = await latest();
  expect("recorded as refused", c?.outcome === "refuse", c);
  say(`        Axon said: "${r.body.error}" · ${c?.ms} ms`);

  say("\n── case 04: 0.01 ETH on the approval objective (inside the cap) ──");
  r = await hire("small");
  expect("the hire stops and says it needs the user", r.status === 402 && /^AUREON says this hire needs your approval first: /.test(r.body.error ?? ""), r);
  expect("nothing more is set aside", (await reserved()) === "0.05", await reserved());
  c = await latest();
  expect("recorded as needing approval", c?.outcome === "authorization_required", c);
  say(`        Axon said: "${r.body.error}" · ${c?.ms} ms`);

  say("\n── an allowance key is watched too, and cannot take the check off ──");
  const minted = await api("POST", "/api/allowance/keys", ownerKey, { label: "policy e2e", maxPerTask: "0.1", maxPerDay: "1" });
  const assistant = minted.body.apiKey;
  r = await hire("small", assistant);
  expect("its hire is stopped the same way", r.status === 402 && /needs your approval first/.test(r.body.error ?? ""), r);
  r = await api("DELETE", "/api/allowance/policy", assistant);
  expect("it cannot remove the check", r.status === 403, r);
  r = await api("GET", "/api/allowance/policy", assistant);
  expect("it cannot read the check", r.status === 403, r);

  say("\n── a paused objective ───────────────────────────────────");
  await link(OBJ.paused);
  r = await hire("small");
  expect("the hire stops", r.status === 402 && /^AUREON refused this hire: /.test(r.body.error ?? ""), r);
  say(`        Axon said: "${r.body.error}"`);

  say("\n── an objective this key does not own ───────────────────");
  await link("obj_000000000000000000000000");
  r = await hire("small");
  expect("the hire stops and says where to fix the link", r.status === 402 && /does not recognise this policy link/.test(r.body.error ?? ""), r);
  expect("still nothing more set aside", (await reserved()) === "0.05", await reserved());

  say("\n── the check removed ────────────────────────────────────");
  r = await api("DELETE", "/api/allowance/policy", ownerKey);
  expect("removed", r.status === 200 && r.body.link === null, r);
  const before = (await api("GET", "/api/allowance/policy", ownerKey)).body.recent.length;
  r = await hire("over");
  expect("the 0.06 ETH hire AUREON refused now goes on under the allowance's own limits", r.status === 201, r);
  expect("0.11 ETH is set aside", (await reserved()) === "0.11", await reserved());
  expect("and AUREON was not asked", (await api("GET", "/api/allowance/policy", ownerKey)).body.recent.length === before, { note: "a check was recorded" });

  say("");
  if (failures) throw new Error(`${failures} check(s) failed`);
  say("  the policy check works end to end against AUREON's host.\n");

  // POLICY_E2E_HOLD=<file>: keep the server up, linked again, to look at the dashboard. Writes where it is and the
  // scratch wallet's key to that file. The key opens nothing but this throwaway database.
  if (process.env.POLICY_E2E_HOLD) {
    await link(OBJ.allow);
    writeFileSync(process.env.POLICY_E2E_HOLD, JSON.stringify({ url: URL, ownerKey }));
    say(`  holding the server at ${URL} until this is stopped`);
    await new Promise(() => {});
  }
}

main().then(
  () => { cleanup(); process.exit(0); },
  (err) => { say(`\nFAILED: ${err.message}`); cleanup(); process.exit(1); },
);
