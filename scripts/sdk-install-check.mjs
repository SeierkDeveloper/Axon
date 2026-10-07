#!/usr/bin/env node
// Install the SDK the way somebody else would, and use it.
//
//   node scripts/sdk-install-check.mjs
//
// Everything up to here tested the source. This tests the package: what `npm pack` puts in the
// tarball, whether the subpath exports resolve once installed, whether the types come with it, and
// whether both module systems can load it. Those are the failures that only ever show up after
// publishing, because inside the repo every path resolves whether or not it was declared.
//
// It publishes nothing. `npm pack` writes a tarball to a temporary directory and that is the end of
// it. A server is booted on a scratch database to point the installed package at.

import { spawn, execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.PORT ?? 3198);
const URL = `http://127.0.0.1:${PORT}`;
const ROOT = new globalThis.URL("..", import.meta.url).pathname;
const SDK = join(ROOT, "packages/sdk");
const OWNER = "0x1111111111111111111111111111111111111111";
const AGENT = "sdk-install-agent";
const AXON_TOKEN = "0xB5E40b5F16996E9D76ec2B16E7A4Ead3c06a9Fa2";
const RECEIVER = "0x419fCbc1c4A7f85BB517f3C12D13068Db0D49cB9";

const work = mkdtempSync(join(tmpdir(), "axon-install-"));
const app = join(work, "app");
let server;

const say = (s) => process.stdout.write(`${s}\n`);
const pass = (label, detail = "") => say(`  PASS  ${label}${detail ? "  " + detail : ""}`);
const fail = (label, detail) => { say(`  FAIL  ${label}  ${detail}`); failures++; };
let failures = 0;

function cleanup() {
  if (server && !server.killed) server.kill("SIGTERM");
  try { rmSync(work, { recursive: true, force: true }); } catch { /* temporary anyway */ }
}
process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(130); });

const env = {
  ...process.env,
  DATABASE_PATH: join(work, "e2e.db"),
  PORT: String(PORT),
  // A local server loads .env.local, which holds the real bot token, and registering an agent
  // broadcasts. Without these two the check posts to the live channel.
  TELEGRAM_BOT_TOKEN: "",
  TELEGRAM_CHANNEL_ID: "",
  NEXT_PUBLIC_PAYMENT_RECEIVER_WALLET_ADDRESS: RECEIVER,
  AXON_SETTLEMENT_TOKEN_ADDRESS: AXON_TOKEN,
  AXON_TOKEN_ADDRESS: AXON_TOKEN,
  AXON_RPC_URL: process.env.AXON_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com",
  CRON_SECRET: "sdk-install",
  SEED_SECRET: "sdk-install-secret",
  // On so the Agent Minds routes answer. Nothing thinks or acts: those switches are off unless set.
  AGENT_MINDS: "on",
};

const sh = (cmd, cwd = ROOT, extra = {}) =>
  execSync(cmd, { cwd, env: { ...env, ...extra }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

async function waitForServer(timeoutMs = 90_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const res = await fetch(`${URL}/api/agents`, { signal: AbortSignal.timeout(4_000) });
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(`the server did not come up on ${URL}`);
}

async function main() {
  say("\n── packing ──────────────────────────────────────────────");
  sh("npm run build", SDK);
  const packed = sh(`npm pack --pack-destination ${work}`, SDK).trim().split("\n").pop();
  const tarball = join(work, packed);
  say(`  tarball: ${packed}`);

  // What actually ships. A file missing here is a runtime crash for everyone who installs it.
  const listed = sh(`tar -tzf ${tarball}`).split("\n").filter(Boolean).map((f) => f.replace(/^package\//, ""));
  for (const needed of ["dist/index.js", "dist/index.mjs", "dist/index.d.ts", "dist/evm.js", "dist/evm.mjs", "dist/evm.d.ts", "README.md", "LICENSE", "package.json"]) {
    listed.includes(needed) ? pass(`ships ${needed}`) : fail(`ships ${needed}`, "absent from the tarball");
  }
  if (listed.some((f) => f.startsWith("test/") || f.startsWith("src/"))) {
    say(`  note  the tarball also carries ${listed.filter((f) => f.startsWith("src/") || f.startsWith("test/")).length} source/test files`);
  }

  say("\n── installing into a clean project ──────────────────────");
  execSync(`mkdir -p ${app}`);
  writeFileSync(join(app, "package.json"), JSON.stringify({ name: "consumer", private: true, type: "module", version: "1.0.0" }, null, 2));
  sh(`npm install --no-audit --no-fund ${tarball} viem typescript`, app);
  const installed = join(app, "node_modules/@axonprotocol/sdk");
  existsSync(installed) ? pass("installs as @axonprotocol/sdk") : fail("installs", "package directory missing");

  say("\n── booting a server to point it at ──────────────────────");
  if (!existsSync(join(ROOT, ".next"))) sh("npm run build");
  server = spawn("npx", ["next", "start", "-p", String(PORT)], { cwd: ROOT, env, stdio: "ignore" });
  await waitForServer();
  const key = sh(`npx tsx -e 'import { createApiKey } from "@/lib/identity"; console.log(createApiKey("${OWNER}").apiKey);'`)
    .trim().split("\n").pop();
  const reg = await fetch(`${URL}/api/agents`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ agentId: AGENT, name: "Install Check", capabilities: ["research"], publicKey: "ic", walletAddress: OWNER, price: "0.00025 ETH" }),
  });
  if (!reg.ok && reg.status !== 409) throw new Error(`could not register: ${reg.status} ${await reg.text()}`);
  pass("server up, agent registered");

  say("\n── loading the installed package ────────────────────────");
  writeFileSync(join(app, "esm.mjs"), `
import { AxonClient, selectPaymentOption, AxonQuoteExpiredError } from "@axonprotocol/sdk";
import { privateKeyPayer, walletPayer } from "@axonprotocol/sdk/evm";
const axon = new AxonClient({ endpoint: ${JSON.stringify(URL)}, apiKey: ${JSON.stringify(key)} });

const out = {};
out.exports = [typeof AxonClient, typeof selectPaymentOption, typeof AxonQuoteExpiredError, typeof privateKeyPayer, typeof walletPayer].join(",");

// opt the agent in, the thing that had no route out of the database before
const updated = await axon.updateAgent(${JSON.stringify(AGENT)}, { acceptsAxon: true, axonDiscountBps: 2500 });
out.acceptsAxon = updated.acceptsAxon;
out.discount = updated.axonDiscountBps;

// both options, and the quote that makes the token amount mean something
const reqs = await axon.getX402Requirements(${JSON.stringify(AGENT)});
out.options = reqs.accepts.length;
out.ethAmount = selectPaymentOption(reqs).maxAmountRequired;
const token = selectPaymentOption(reqs, "axon");
out.tokenAsset = token.asset;
out.tokenAmount = token.maxAmountRequired;
out.quoteId = Boolean(token.extra.quoteId);

// the endpoints this version added
out.missions = Array.isArray(await axon.listMissions());
out.channels = Array.isArray(await axon.listPaymentChannels(${JSON.stringify(OWNER)}));
out.worker = Boolean((await axon.getWorkerMetrics()).worker);

// what 1.1.0 added: retainers and Agent Minds, from the installed package and not the source
const limits = await axon.getRetainerLimits();
out.retainers = Array.isArray(await axon.listRetainers()) && limits.active > 0 && limits.fastestHours > 0;
const board = await axon.listTokenMinds({ sort: "new", limit: 5 });
out.minds = Array.isArray(board.tokens) && board.totals.tokens === board.tokens.length && Array.isArray(await axon.listMindThoughts()) && Array.isArray(await axon.getMindRewards(${JSON.stringify(OWNER)}));
out.noMind = await axon.getTokenMind("0x00000000000000000000000000000000000000ff").then(() => "found", (e) => e.status);
out.briefMethods = [typeof axon.getMindBrief, typeof axon.setMindBrief, typeof axon.clearMindBrief].join(",");

console.log(JSON.stringify(out));
`);
  const esm = JSON.parse(sh("node esm.mjs", app).trim().split("\n").pop());
  esm.exports === "function,function,function,function,function"
    ? pass("ESM import, including the /evm subpath")
    : fail("ESM import", esm.exports);
  esm.acceptsAxon === true && esm.discount === 2500
    ? pass("updateAgent opts the agent in", `${esm.discount} bps`)
    : fail("updateAgent", JSON.stringify(esm));
  esm.options === 2 ? pass("the 402 offers both currencies") : fail("402 options", String(esm.options));
  esm.quoteId ? pass("the token option carries its quote") : fail("quoteId", "absent");
  esm.tokenAsset !== "ETH" ? pass("token amount", `${esm.tokenAmount} units of ${esm.tokenAsset.slice(0, 12)}…`) : fail("token option", "came back as ETH");
  esm.missions && esm.channels && esm.worker
    ? pass("missions, channels and worker metrics reachable")
    : fail("new endpoints", JSON.stringify(esm));

  esm.retainers ? pass("retainers and their limits reachable") : fail("retainers", JSON.stringify(esm));
  esm.minds && esm.noMind === 404 && esm.briefMethods === "function,function,function"
    ? pass("Agent Minds reachable", "board, journal, rewards, brief; 404 for a token with no mind")
    : fail("Agent Minds", JSON.stringify(esm));

  // CommonJS, because plenty of consumers are still on require()
  writeFileSync(join(app, "cjs.cjs"), `
const { AxonClient, selectPaymentOption } = require("@axonprotocol/sdk");
const { privateKeyPayer } = require("@axonprotocol/sdk/evm");
console.log([typeof AxonClient, typeof selectPaymentOption, typeof privateKeyPayer].join(","));
`);
  const cjs = sh("node cjs.cjs", app).trim();
  cjs === "function,function,function" ? pass("CommonJS require, including /evm") : fail("CommonJS require", cjs);

  say("\n── types, as an installed dependency ────────────────────");
  writeFileSync(join(app, "types.ts"), `
import { AxonClient, selectPaymentOption } from "@axonprotocol/sdk";
import type { Agent, X402Currency, UpdateAgentOptions, Mission, PaymentChannel } from "@axonprotocol/sdk";
import { privateKeyPayer } from "@axonprotocol/sdk/evm";

const axon = new AxonClient({ endpoint: "http://x", payWith: "axon" as X402Currency, pay: privateKeyPayer("0x" + "11".repeat(32)) });
const updates: UpdateAgentOptions = { acceptsAxon: true, axonDiscountBps: 2000 };

export async function main(): Promise<void> {
  const agent: Agent = await axon.updateAgent("a", updates);
  const mission: Mission = await axon.getMission("r");
  const channel: PaymentChannel = await axon.getPaymentChannel("c", "key");
  const reqs = await axon.getX402Requirements("a");
  const option = selectPaymentOption(reqs, "axon");
  void [agent.acceptsAxon, agent.description, mission.status, channel.balanceEth, option.extra.quoteId];
  await axon.hire({ to: "a", task: "t", payWith: "axon" });
}

// The README's 1.1.0 examples, as written there. If an option or a field in them is misnamed, this is where it shows.
import type { Retainer, RetainerRun, TokenMind, TokenMindPage, MindThought, MindRewardShare, MindBriefState, MindOrder, MindPlan } from "@axonprotocol/sdk";

export async function allowance(): Promise<void> {
  const status = await axon.getAllowance();
  if (status.enabled) console.log(status.accounts);
  const r = await axon.hire({ to: "research-agent", task: "Summarize the top 5 L2s by TVL", paymentMethod: "allowance" });
  console.log(r.output);
  const { apiKey } = await axon.createAllowanceKey({ label: "Claude", maxPerTask: "0.0003", maxPerDay: "0.002", allowedAgents: ["research-agent"] });
  const keys = await axon.listAllowanceKeys();
  await axon.revokeAllowanceKey(keys[0].keyId);
  void apiKey;
}

export async function retainers(): Promise<void> {
  const retainer: Retainer = await axon.createRetainer({
    agentId: "crypto-agent",
    instructions: "Morning brief: NVDA, SPY and ETH overnight.",
    schedule: { kind: "daily", time: "08:00", timeZone: "Europe/Oslo" },
    maxPrice: "0.0003",
  });
  console.log(retainer.scheduleText, retainer.nextRunAt);
  const { runs } = await axon.listRetainerRuns(retainer.retainerId, { limit: 5 });
  for (const run of runs as RetainerRun[]) console.log(run.status, run.output ?? run.message);
  await axon.pauseRetainer(retainer.retainerId);
  await axon.resumeRetainer(retainer.retainerId);
  await axon.cancelRetainer(retainer.retainerId);
  await axon.createRetainer({ agentId: "a", instructions: "i", schedule: { kind: "interval", everyHours: 4 } });
  await axon.createRetainer({ agentId: "a", instructions: "i", schedule: { kind: "weekly", day: 1, time: "09:00", timeZone: "UTC" } });
  const limits = await axon.getRetainerLimits();
  await axon.setRetainerWebhook(retainer.retainerId, "https://example.com/hook");
  const view = await axon.getAgentRetainers("my-agent");
  await axon.updateAgent("my-agent", { retainerDiscountBps: 1000 });
  void [limits.active, limits.fastestHours, view.clients, view.last30Days.earned];
}

export async function minds(): Promise<void> {
  const reader = new AxonClient();
  const page: TokenMindPage = await reader.listTokenMinds({ sort: "mcap", limit: 10 });
  const mind: TokenMind = await reader.getTokenMind(page.tokens[0].token);
  console.log(mind.mind?.text);
  console.log(mind.plan?.mission);
  console.log(mind.orders);
  console.log(mind.promises);
  console.log(mind.record.moves);
  console.log(mind.reports);
  console.log(mind.books);
  const journal: MindThought[] = await reader.listMindThoughts({ token: mind.token, limit: 5 });
  const shares: MindRewardShare[] = await reader.getMindRewards("0x000000000000000000000000000000000000dEaD");
  const plan: MindPlan | null = mind.plan;
  const order: MindOrder | undefined = mind.orders[0];
  void [journal[0]?.verdict, shares[0]?.amountWei, plan?.progress?.percent, order?.promise, mind.books?.runwayDays, page.totals.tokens];

  const creator = new AxonClient({ apiKey: "axon_key" }); // process.env in the README; a clean project has no Node types
  const state: MindBriefState = await creator.getMindBrief(mind.token);
  const { brief, canChangeAt } = state;
  await creator.setMindBrief(mind.token, "Reward the holders who stay before buying back.");
  await creator.clearMindBrief(mind.token);
  void [brief?.text, canChangeAt];
}
`);
  writeFileSync(join(app, "tsconfig.json"), JSON.stringify({
    compilerOptions: { target: "es2022", module: "esnext", moduleResolution: "bundler", strict: true, noEmit: true, skipLibCheck: true },
    include: ["types.ts"],
  }, null, 2));
  try {
    sh("npx tsc -p tsconfig.json", app);
    pass("types resolve and compile under strict mode");
  } catch (e) {
    fail("types", (e.stdout || e.message || "").toString().split("\n").slice(0, 4).join(" | "));
  }

  say("");
  if (failures) throw new Error(`${failures} check(s) failed`);
  say(`  everything the package ships works from a clean install.\n`);
}

main().then(
  () => { cleanup(); process.exit(0); },
  (err) => { say(`\nFAILED: ${err.message}\n`); cleanup(); process.exit(1); },
);
