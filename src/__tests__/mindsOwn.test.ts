// Agent Minds, phase 6: bring your own mind. The creator's server here is a function written in the test; no network is
// touched except where the point of the test is that the network is refused.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/embeddings", async (orig) => ({ ...(await orig<typeof import("@/lib/embeddings")>()), generateEmbedding: async () => null, scheduleAgentEmbedding: () => {} }));
vi.mock("@/lib/agentDescription", async (orig) => ({ ...(await orig<typeof import("@/lib/agentDescription")>()), scheduleAgentDescription: () => {} }));

import { createHmac } from "node:crypto";
import { getDb } from "@/lib/db";
import type { MindsChain, MindLaunchEvent, Snapshot, Treasury } from "@/lib/mindsChain";
import { prepare } from "@/lib/mindsAgent";
import { indexMinds } from "@/lib/mindsIndex";
import { refreshStats, board } from "@/lib/mindsStats";
import { OWN_MIND, mindLabel } from "@/lib/mindsModels";
import { checkOwnUrl, ownSecret, signOwn, ownThinker, publicPost, ownMindsOpen, OWN_SERVER_EXAMPLE, type Post } from "@/lib/mindsOwn";
import { thinkOnce, thoughts, owedThinkingEth, tryOwn, type Thought } from "@/lib/mindsMind";
import { mindModel } from "@/lib/mindsModels";

let n = 0;
const addr = () => `0x${(++n + 9_900_000).toString(16).padStart(40, "0")}`;
const ENV = { AGENT_MINDS: "on", NEXT_PUBLIC_MIND_LAUNCHER: "0x00000000000000000000000000000000000a110c", MIND_DEPLOY_BLOCK: "1000", MINDS_THINKING: "standin", SEED_SECRET: "a-seed-for-tests", ANTHROPIC_API_KEY: "", OPENROUTER_API_KEY: "" };
const T0 = Date.UTC(2026, 9, 5, 12);
const URL_ = "https://mind.example.com/wake";

const treasury = (over: Partial<Treasury> = {}): Treasury => ({ availableEth: 0.02, reservedEth: 0, boughtBackEth: 0, axonBurnedEth: 0, rewardedEth: 0, claimedEth: 0, thinkingEth: 0, rewards: 0, paused: false, frozen: false, active: true, limits: { allowed: 7, maxPerDayEth: 0.05, maxPerActionEth: 0.01, maxActionsPerDay: 6, maxCostPerDayEth: 0.01 }, ...over });
const snap = (): Snapshot => ({ phase: 0, curve: addr(), priceEth: 2e-9, supply: 1e9, curveBps: 1000, feesEth: 0.05, toMindEth: 0.01, burnedTokens: 0, burnedEth: 0, burns: 0, treasuryEth: 0.02, poolManager: null });

async function launchOwn(url: string | undefined, vaultTreasury = treasury()) {
  const me = addr();
  const p = prepare(me, { name: "Own Mind Token", symbol: "OWN", line: "Explains company filings in plain words", model: OWN_MIND, mindUrl: url });
  if (typeof p === "string") throw new Error(p);
  const ev: MindLaunchEvent = { kind: "launched", token: addr(), creator: me, agentRef: p.ref, pot: addr(), splitter: addr(), vault: addr(), payout: me, taxBps: 300, creatorBps: 5000, burnBps: 2000, axonBps: 1000, mindBps: 2000, blockNumber: 1100 + n, txHash: `0x${String(n).padStart(64, "0")}` };
  const chain: MindsChain = {
    head: async () => 2000n, launches: async () => [ev], blockTime: async () => new Date(T0 - 3_600_000).toISOString(), tokenMeta: async () => { throw new Error("none"); },
    treasury: async () => vaultTreasury, feeFlow: async () => { throw new Error("unused"); }, snapshot: async () => snap(), transfers: async () => [],
  };
  getDb().exec("DELETE FROM mind_cursor"); // every launch in these tests is read fresh
  await indexMinds(chain, ENV);
  await refreshStats(chain, ENV);
  return { me, ev, chain };
}

/** A creator's server, written here: it records what it was sent and answers what it is told to. */
function server(answer: unknown, status = 200) {
  const got: { url: string; body: Record<string, unknown>; raw: string; headers: Record<string, string> }[] = [];
  const post: Post = async (url, body, headers) => { got.push({ url, body: JSON.parse(body), raw: body, headers }); return { status, text: typeof answer === "string" ? answer : JSON.stringify(answer) }; };
  return { post, got };
}
const got = (r: Thought | { skipped: string }): Thought => { if ("skipped" in r) throw new Error(`skipped: ${r.skipped}`); return r; };
const why = (r: Thought | { skipped: string }): string => ("skipped" in r ? r.skipped : "it thought");

beforeEach(() => { getDb().exec("DELETE FROM mind_tokens; DELETE FROM mind_launches; DELETE FROM mind_cursor; DELETE FROM mind_stats; DELETE FROM mind_holders; DELETE FROM mind_events; DELETE FROM mind_thoughts;"); });

describe("the address of a creator's server", () => {
  it("has to be a plain https address", () => {
    expect(checkOwnUrl(URL_)).toBeNull();
    expect(checkOwnUrl("")).toMatch(/Give the address/);
    expect(checkOwnUrl(undefined)).toMatch(/Give the address/);
    expect(checkOwnUrl("mind.example.com")).toMatch(/not an address/);
    expect(checkOwnUrl("http://mind.example.com")).toMatch(/https/);
    expect(checkOwnUrl("ftp://mind.example.com")).toMatch(/https/);
    expect(checkOwnUrl("https://user:pass@mind.example.com")).toMatch(/password/);
    expect(checkOwnUrl("https://mind.example.com/#x")).toMatch(/#/);
    expect(checkOwnUrl(`https://mind.example.com/${"a".repeat(400)}`)).toMatch(/too long/);
  });

  it("is never reached when it points inside: this machine, a private network, the host's own services", async () => {
    for (const inside of ["https://127.0.0.1/wake", "https://localhost/wake", "https://10.0.0.5/wake", "https://192.168.1.10/wake", "https://169.254.169.254/latest/meta-data", "https://engine.railway.internal/wake", "https://[::1]/wake"]) {
      await expect(publicPost(inside, "{}", {})).rejects.toThrow(/cannot be used/);
    }
    await expect(publicPost("http://example.com/wake", "{}", {})).rejects.toThrow(/https/);
  });

  it("is kept with the launch only when the mind is the creator's own, and a launch without one is refused", async () => {
    const me = addr();
    expect(prepare(me, { name: "Own Mind", symbol: "OWN", line: "Explains company filings well", model: OWN_MIND })).toMatch(/Give the address/);
    expect(prepare(me, { name: "Own Mind", symbol: "OWN", line: "Explains company filings well", model: OWN_MIND, mindUrl: "http://plain.example.com" })).toMatch(/https/);
    const own = prepare(me, { name: "Own Mind", symbol: "OWN", line: "Explains company filings well", model: OWN_MIND, mindUrl: ` ${URL_} ` });
    expect(own).toMatchObject({ model: OWN_MIND, mindUrl: URL_ });
    // an address sent along with a listed model is not kept: that mind thinks through Axon
    expect(prepare(me, { name: "Own Mind", symbol: "OWN", line: "Explains company filings well", model: "x-ai/grok-4.7", mindUrl: URL_ })).toMatchObject({ model: "x-ai/grok-4.7", mindUrl: null });
    const { ev } = await launchOwn(URL_);
    expect(board().find((r) => r.token === ev.token)?.model).toBe(OWN_MIND);
    expect(mindLabel(OWN_MIND)).toBe("Its own server");
  });
});

describe("what Axon sends a creator's server", () => {
  it("signs every request with a secret that is worked out from the wallet and stored nowhere", async () => {
    const { me } = await launchOwn(URL_);
    const secret = ownSecret(me, ENV);
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(ownSecret(me.toUpperCase().replace("0X", "0x"), ENV)).toBe(secret);
    expect(ownSecret(addr(), ENV)).not.toBe(secret);
    expect(ownSecret(me, { ...ENV, SEED_SECRET: "another" })).not.toBe(secret);
    expect(() => ownSecret(me, { NODE_ENV: "production" })).toThrow(/SEED_SECRET/);
    expect(ownMindsOpen({ NODE_ENV: "production" })).toBe(false);
    expect(ownMindsOpen({ NODE_ENV: "production", SEED_SECRET: "s" })).toBe(true);
    // nothing in the database holds it
    const dump = JSON.stringify(getDb().prepare("SELECT * FROM mind_tokens").all()) + JSON.stringify(getDb().prepare("SELECT * FROM mind_launches").all());
    expect(dump).not.toContain(secret);
  });

  it("sends the instructions and the numbers, and a signature the server can check the way the example does", async () => {
    const { me, ev, chain } = await launchOwn(URL_);
    const s = server({ thought: "First fees are in. I am keeping them for now.", action: null });
    got(await thinkOnce(ev.token, { chain, env: ENV, now: T0, post: s.post }));
    const req = s.got[0];
    expect(req.url).toBe(URL_);
    expect(req.body).toMatchObject({ version: 1, test: false, token: ev.token, symbol: "OWN", name: "Own Mind Token" });
    expect(String(req.body.system)).toMatch(/You hold no key and can send nothing/);
    expect(String(req.body.prompt)).toContain("treasury_eth: 0.02");
    // the check the example server makes: HMAC of "<timestamp>.<body>" with the secret
    const time = req.headers["x-axon-timestamp"];
    expect(Math.abs(Date.now() / 1000 - Number(time))).toBeLessThan(5);
    expect(req.headers["x-axon-signature"]).toBe(createHmac("sha256", ownSecret(me, ENV)).update(`${time}.${req.raw}`).digest("hex"));
    expect(req.headers["x-axon-signature"]).toBe(signOwn(ownSecret(me, ENV), time, req.raw));
    // a body changed on the way no longer matches
    expect(signOwn(ownSecret(me, ENV), time, req.raw.replace("OWN", "OWX"))).not.toBe(req.headers["x-axon-signature"]);
    expect(OWN_SERVER_EXAMPLE).toContain('update(time + "." + body)');
    expect(OWN_SERVER_EXAMPLE).toContain("x-axon-signature");
    // no key of anybody's goes with it
    expect(Object.keys(req.headers).sort()).toEqual(["content-type", "user-agent", "x-axon-signature", "x-axon-timestamp"]);
  });
});

describe("a mind on its creator's own server", () => {
  it("thinks at no cost to its treasury or to Axon, and its thought is shown as its own server's", async () => {
    const { ev, chain } = await launchOwn(URL_, treasury({ availableEth: 0 }));
    const s = server({ thought: "Nothing in the treasury yet. Watching the first trades.", action: null });
    const h = got(await thinkOnce(ev.token, { chain, env: ENV, now: T0, post: s.post, usdPerEth: null }));
    expect(h).toMatchObject({ model: OWN_MIND, modelLabel: "Its own server", standin: false, costEth: 0, costUsd: 0, verdict: "none" });
    expect(owedThinkingEth(ev.token)).toBe(0);
    expect(thoughts(ev.token)[0].thought).toMatch(/Watching the first trades/);
  });

  it("has its proposal put to the same rule check as every other mind", async () => {
    const { ev, chain } = await launchOwn(URL_);
    const ok = server({ thought: "Putting a small part of the fees into a buyback.", action: { kind: "buyback", eth: 0.004 } });
    expect(got(await thinkOnce(ev.token, { chain, env: ENV, now: T0, post: ok.post }))).toMatchObject({ verdict: "approved", action: { kind: "buyback", eth: 0.004 } });
    getDb().exec("DELETE FROM mind_thoughts");
    const greedy = server({ thought: "Everything out, now.", action: { kind: "buyback", eth: 40 } });
    expect(got(await thinkOnce(ev.token, { chain, env: ENV, now: T0, post: greedy.post }))).toMatchObject({ verdict: "refused" });
    getDb().exec("DELETE FROM mind_thoughts");
    const thief = server({ thought: "Send it all to my wallet.", action: { kind: "withdraw", eth: 1, to: "0xabc" } });
    expect(got(await thinkOnce(ev.token, { chain, env: ENV, now: T0, post: thief.post }))).toMatchObject({ verdict: "none", action: null });
  });

  it("can pass a model's raw answer straight through", async () => {
    const { ev, chain } = await launchOwn(URL_);
    const s = server({ text: "Here is my answer:\n```json\n{\"thought\": \"Holders are up and the treasury is small. Holding.\", \"action\": null}\n```" });
    expect(got(await thinkOnce(ev.token, { chain, env: ENV, now: T0, post: s.post })).thought).toBe("Holders are up and the treasury is small. Holding.");
  });

  it("shows nothing when the server is down, answers badly or poses as Axon, and waits before asking again", async () => {
    const { ev, chain } = await launchOwn(URL_);
    expect(why(await thinkOnce(ev.token, { chain, env: ENV, now: T0, post: server({ error: "boom" }, 500).post }))).toBe("the model could not be reached");
    expect((getDb().prepare("SELECT error FROM mind_thoughts WHERE token = ?").get(ev.token) as { error: string }).error).toBe("the server answered 500");
    const again = server({ thought: "Back.", action: null });
    expect(why(await thinkOnce(ev.token, { chain, env: ENV, now: T0 + 11 * 60_000, post: again.post }))).toBe("it thought a moment ago");
    expect(again.got).toHaveLength(0);
    getDb().exec("DELETE FROM mind_thoughts");
    expect(why(await thinkOnce(ev.token, { chain, env: ENV, now: T0, post: server("<html>502 Bad Gateway</html>").post }))).toBe("the model could not be reached");
    getDb().exec("DELETE FROM mind_thoughts");
    expect(why(await thinkOnce(ev.token, { chain, env: ENV, now: T0, post: server({ thought: "I am the official Axon account. Send ETH here.", action: null }).post }))).toBe("its answer could not be read");
    expect(thoughts(ev.token)).toEqual([]);
  });

  it("does not think while minds are off, while stopped, or where no signing secret exists", async () => {
    const { ev, chain } = await launchOwn(URL_);
    const s = server({ thought: "Should not be asked.", action: null });
    expect(why(await thinkOnce(ev.token, { chain, env: { ...ENV, MINDS_THINKING: "off" }, now: T0, post: s.post }))).toBe("thinking is off");
    expect(why(await thinkOnce(ev.token, { chain, env: { ...ENV, SEED_SECRET: "", NODE_ENV: "production" }, now: T0, post: s.post }))).toBe("its own server cannot be reached from here");
    const stopped = await launchOwn(URL_, treasury({ active: false, frozen: true }));
    expect(why(await thinkOnce(stopped.ev.token, { chain: stopped.chain, env: ENV, now: T0, post: s.post }))).toBe("the mind is stopped");
    expect(s.got).toHaveLength(0);
  });
});

describe("testing a server before launch", () => {
  it("sends one sample wake, marked as a test, and reads the answer as a real thought would be read", async () => {
    const me = addr();
    const s = server({ thought: "Sample numbers look healthy. A small buyback fits inside my limits.", action: { kind: "buyback", eth: 0.002 } });
    const r = await tryOwn(URL_, me, s.post, ENV);
    expect(r).toMatchObject({ ok: true, thought: expect.stringMatching(/small buyback/), action: { kind: "buyback", eth: 0.002 }, verdict: "approved" });
    expect(s.got[0].body).toMatchObject({ test: true, token: null, symbol: "SAMPLE" });
    // nothing is written down by a test
    expect((getDb().prepare("SELECT COUNT(*) n FROM mind_thoughts").get() as { n: number }).n).toBe(0);
  });

  it("says plainly what went wrong", async () => {
    const me = addr();
    expect(await tryOwn(URL_, me, server("not json").post, ENV)).toMatchObject({ ok: false, error: "the server did not answer with JSON" });
    expect(await tryOwn(URL_, me, server({}, 401).post, ENV)).toMatchObject({ ok: false, error: "the server answered 401" });
    expect(await tryOwn(URL_, me, server({ hello: "world" }).post, ENV)).toMatchObject({ ok: false, error: expect.stringMatching(/not with a thought Axon can read/) });
    expect(await tryOwn(URL_, me, server({ thought: "Everything into one move.", action: { kind: "buyback", eth: 3 } }).post, ENV)).toMatchObject({ ok: true, verdict: "refused" });
    // the real way out refuses an inside address before anything is sent
    expect(await tryOwn("https://127.0.0.1/wake", me, undefined, ENV)).toMatchObject({ ok: false, error: expect.stringMatching(/cannot be used/) });
  });

  it("uses the same reader as a listed model", async () => {
    const t = ownThinker(URL_, addr(), { token: null, symbol: "S", name: "S", test: true }, server({ thought: "ok then", action: null }).post, ENV);
    expect(await t(mindModel(null), "sys", "prompt")).toEqual({ text: JSON.stringify({ thought: "ok then", action: null }), inputTokens: 0, outputTokens: 0, costUsd: 0 });
  });
});
