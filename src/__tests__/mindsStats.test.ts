// Agent Minds, phase 4: the numbers the board and the launch terminal show, and the log of what moved.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/embeddings", async (orig) => ({ ...(await orig<typeof import("@/lib/embeddings")>()), generateEmbedding: async () => null, scheduleAgentEmbedding: () => {} }));
vi.mock("@/lib/agentDescription", async (orig) => ({ ...(await orig<typeof import("@/lib/agentDescription")>()), scheduleAgentDescription: () => {} }));

import { getDb } from "@/lib/db";
import { curveProgressBps, type MindsChain, type MindLaunchEvent, type Snapshot, type TransferEvent } from "@/lib/mindsChain";
import { prepare } from "@/lib/mindsAgent";
import { indexMinds } from "@/lib/mindsIndex";
import { refreshStats, board, boardToken, boardTotals, events, PAGE_SIZE } from "@/lib/mindsStats";
import { unreadChain } from "./helpers/unreadChain";

let n = 0;
const addr = () => `0x${(++n + 9_500_000).toString(16).padStart(40, "0")}`;
const ON = { AGENT_MINDS: "on", NEXT_PUBLIC_MIND_LAUNCHER: "0x00000000000000000000000000000000000a110c", MIND_DEPLOY_BLOCK: "1000" };
const E18 = 10n ** 18n;
const ZERO = `0x${"0".repeat(40)}`, DEAD = "0x000000000000000000000000000000000000dead";

const CURVE = addr(), POOL = addr();
const snap = (over: Partial<Snapshot> = {}): Snapshot => ({ phase: 0, curve: CURVE, priceEth: 1.68e-9, supply: 1e9, curveBps: 0, feesEth: 0, toMindEth: 0, burnedTokens: 0, burnedEth: 0, burns: 0, treasuryEth: 0, poolManager: null, ...over });

/** A chain written down here: its launches, each token's numbers, every transfer. */
function world() {
  const state = { head: 2000n, launches: [] as MindLaunchEvent[], snaps: new Map<string, Snapshot>(), transfers: [] as TransferEvent[], asked: [] as { tokens: string[]; from: bigint; to: bigint }[] };
  const chain: MindsChain = {
    ...unreadChain,
    head: async () => state.head,
    launches: async (_l, from, to) => state.launches.filter((e) => BigInt(e.blockNumber) >= from && BigInt(e.blockNumber) <= to),
    blockTime: async (b) => new Date(Date.UTC(2026, 9, 5, 12) + b * 100).toISOString(),
    tokenMeta: async () => { throw new Error("no name on this chain"); },
    treasury: async () => { throw new Error("unused"); },
    feeFlow: async () => { throw new Error("unused"); },
    snapshot: async (t) => { const s = state.snaps.get(t.token); if (!s) throw new Error("unreadable"); return s; },
    vaultDay: async () => ({ spentTodayEth: 0, actionsToday: 0, costTodayEth: 0 }),
    transfers: async (tokens, from, to) => { state.asked.push({ tokens, from, to }); return state.transfers.filter((x) => tokens.includes(x.token) && BigInt(x.blockNumber) >= from && BigInt(x.blockNumber) <= to); },
  };
  const launch = (name: string, symbol: string, block: number) => {
    const me = addr();
    const p = prepare(me, { name, symbol, line: "Explains company filings in plain words" });
    if (typeof p === "string") throw new Error(p);
    const ev: MindLaunchEvent = { kind: "launched", token: addr(), creator: me, agentRef: p.ref, pot: addr(), splitter: addr(), vault: addr(), payout: me, taxBps: 300, creatorBps: 5000, burnBps: 2000, axonBps: 1000, mindBps: 2000, blockNumber: block, txHash: `0x${String(block).padStart(64, "0")}` };
    state.launches.push(ev);
    state.snaps.set(ev.token, snap());
    // the whole supply is minted to the curve
    state.transfers.push({ token: ev.token, from: ZERO, to: CURVE, value: 1_000_000_000n * E18, blockNumber: block });
    return ev;
  };
  const move = (token: string, from: string, to: string, whole: number, block: number) => state.transfers.push({ token, from, to, value: BigInt(whole) * E18, blockNumber: block });
  const pass = async () => { await indexMinds(chain, ON); return refreshStats(chain, ON); };
  return { state, chain, launch, move, pass };
}

beforeEach(() => { getDb().exec("DELETE FROM mind_tokens; DELETE FROM mind_launches; DELETE FROM mind_cursor; DELETE FROM mind_stats; DELETE FROM mind_holders; DELETE FROM mind_events;"); });

describe("how far along its curve a token is", () => {
  const T = 4_200_000_000_000_000_000n; // the launch factory's 4.2 ETH
  it("starts at nothing on a fresh curve and is full when the ETH paid in reaches the threshold", () => {
    expect(curveProgressBps(1_680_000_000_000_000_000n, T)).toBe(0);
    expect(curveProgressBps(1_680_000_000_000_000_000n + T / 2n, T)).toBe(5000);
    expect(curveProgressBps(5_851_000_000_000_000_000n, T)).toBe(9930); // measured on the chain copy: not ready yet
    expect(curveProgressBps(5_880_000_000_000_000_000n, T)).toBe(10_000);
    expect(curveProgressBps(9n * E18, T)).toBe(10_000);
    expect(curveProgressBps(1n, T)).toBe(0);
    expect(curveProgressBps(5n * E18, 0n)).toBe(0);
  });
});

describe("the numbers a token shows", () => {
  it("does nothing while switched off, or before the launcher has been read", async () => {
    const w = world();
    w.launch("Ledger Lens", "LENS", 1100);
    expect(await refreshStats(w.chain, { ...ON, AGENT_MINDS: "off" })).toBeNull();
    expect(await refreshStats(w.chain, ON)).toBeNull();
    expect(board()).toEqual([]);
  });

  it("writes price, market cap, curve, fees, burns and treasury as the chain gives them", async () => {
    const w = world();
    const t = w.launch("Ledger Lens", "LENS", 1100);
    w.state.snaps.set(t.token, snap({ priceEth: 2e-9, curveBps: 1234, feesEth: 0.05, toMindEth: 0.01, treasuryEth: 0.008, burnedTokens: 250_000, burnedEth: 0.004, burns: 2 }));
    expect(await w.pass()).toEqual({ tokens: 1, events: 2 });
    const [row] = board();
    expect(row).toMatchObject({ token: t.token, name: "Ledger Lens", symbol: "LENS", agentName: "Ledger Lens", phase: 0, priceEth: 2e-9, curveBps: 1234, feesEth: 0.05, toMindEth: 0.01, treasuryEth: 0.008, burnedTokens: 250_000, burnedEth: 0.004, burns: 2, taxBps: 300, mindBps: 2000, attached: false });
    expect(row.mcapEth).toBeCloseTo(2, 9);
    expect(boardTotals()).toMatchObject({ tokens: 1, feesEth: 0.05, burnedEth: 0.004, toMindEth: 0.01, treasuryEth: 0.008 });
  });

  it("gives the board a page at a time, and any one token wherever it is", async () => {
    const w = world();
    const a = w.launch("Ledger Lens", "LENS", 1100), b = w.launch("Tide Clock", "TIDE", 1101), c = w.launch("Copper Fox", "CFOX", 1102);
    for (const t of [a, b, c]) w.state.snaps.set(t.token, snap());
    await w.pass();
    expect(PAGE_SIZE).toBe(15);
    const all = board("new", 10).map((t) => t.token);
    expect(all).toHaveLength(3);
    expect(board("new", 2, 0).map((t) => t.token)).toEqual(all.slice(0, 2));
    expect(board("new", 2, 2).map((t) => t.token)).toEqual(all.slice(2));
    expect(board("new", 2, 4)).toEqual([]);
    expect(boardToken(b.token.toUpperCase().replace("0X", "0x"))).toMatchObject({ token: b.token, symbol: "TIDE" });
    expect(boardToken("0x00000000000000000000000000000000000000aa")).toBeNull();
  });

  it("shows no price rather than a wrong one while a token is between its curve and its pool", async () => {
    const w = world();
    const t = w.launch("Ledger Lens", "LENS", 1100);
    w.state.snaps.set(t.token, snap({ phase: 1, priceEth: null, curveBps: 10_000 }));
    await w.pass();
    expect(board()[0]).toMatchObject({ phase: 1, priceEth: null, mcapEth: null, curveBps: 10_000 });
  });

  it("keeps a token's last numbers when the chain cannot be read for it, and still refreshes the others", async () => {
    const w = world();
    const a = w.launch("Ledger Lens", "LENS", 1100), b = w.launch("Tide Table", "TIDE", 1200);
    w.state.snaps.set(a.token, snap({ feesEth: 0.02 }));
    await w.pass();
    w.state.snaps.delete(a.token);
    w.state.snaps.set(b.token, snap({ feesEth: 0.07 }));
    expect(await w.pass()).toMatchObject({ tokens: 1 });
    const rows = Object.fromEntries(board().map((r) => [r.symbol, r.feesEth]));
    expect(rows).toEqual({ LENS: 0.02, TIDE: 0.07 });
  });

  it("orders the board by newest, by market cap and by what was burned", async () => {
    const w = world();
    const a = w.launch("Ledger Lens", "LENS", 1100), b = w.launch("Tide Table", "TIDE", 1200), c = w.launch("North Star", "NRTH", 1300);
    w.state.snaps.set(a.token, snap({ priceEth: 9e-9, burnedEth: 0.001 }));
    w.state.snaps.set(b.token, snap({ priceEth: 2e-9, burnedEth: 0.5 }));
    w.state.snaps.set(c.token, snap({ priceEth: 5e-9, burnedEth: 0.02 }));
    await w.pass();
    expect(board("new").map((r) => r.symbol)).toEqual(["NRTH", "TIDE", "LENS"]);
    expect(board("mcap").map((r) => r.symbol)).toEqual(["LENS", "NRTH", "TIDE"]);
    expect(board("burned").map((r) => r.symbol)).toEqual(["TIDE", "NRTH", "LENS"]);
    expect(board("new", 2)).toHaveLength(2);
  });
});

describe("who holds a token", () => {
  it("counts wallets with a balance, and never the curve, the pool, the token's own contracts or the dead address", async () => {
    const w = world();
    const t = w.launch("Ledger Lens", "LENS", 1100);
    const [amy, ben, cal] = [addr(), addr(), addr()];
    w.move(t.token, CURVE, amy, 5_000_000, 1150);
    w.move(t.token, CURVE, ben, 2_000_000, 1160);
    w.move(t.token, CURVE, t.pot, 100_000, 1170);     // the pot buying back
    w.move(t.token, t.pot, DEAD, 100_000, 1170);       // and burning
    w.move(t.token, CURVE, t.vault, 50_000, 1180);
    await w.pass();
    expect(board()[0].holders).toBe(2);

    // ben sells everything, amy sends some to cal: two holders still, and they are amy and cal
    w.state.head = 2500n;
    w.move(t.token, ben, CURVE, 2_000_000, 2100);
    w.move(t.token, amy, cal, 1_000_000, 2200);
    await w.pass();
    expect(board()[0].holders).toBe(2);
    const bal = (a: string) => (getDb().prepare("SELECT balance FROM mind_holders WHERE token = ? AND address = ?").get(t.token, a) as { balance: string }).balance;
    expect(bal(amy)).toBe((4_000_000n * E18).toString());
    expect(bal(cal)).toBe((1_000_000n * E18).toString());
    expect(bal(ben)).toBe("0");
    expect(bal(DEAD)).toBe((100_000n * E18).toString());
  });

  it("reads each stretch of blocks once, starting a token at the block it launched in", async () => {
    const w = world();
    const a = w.launch("Ledger Lens", "LENS", 1100);
    await w.pass();
    expect(w.state.asked).toEqual([{ tokens: [a.token], from: 1100n, to: 2000n }]);
    await w.pass();
    expect(w.state.asked).toHaveLength(1);

    // a later token starts at its own launch; the earlier one carries on from where it stopped
    w.state.head = 3000n;
    const b = w.launch("Tide Table", "TIDE", 2500);
    await w.pass();
    expect(w.state.asked.slice(1)).toEqual(expect.arrayContaining([{ tokens: [a.token], from: 2001n, to: 3000n }, { tokens: [b.token], from: 2500n, to: 3000n }]));
    // from then on they share one request
    w.state.head = 3500n;
    await w.pass();
    expect(w.state.asked[w.state.asked.length - 1]).toMatchObject({ from: 3001n, to: 3500n });
    expect(w.state.asked[w.state.asked.length - 1].tokens.sort()).toEqual([a.token, b.token].sort());
  });

  it("counts the pool as nobody once a token has graduated", async () => {
    const w = world();
    const t = w.launch("Ledger Lens", "LENS", 1100);
    const amy = addr();
    w.move(t.token, CURVE, amy, 5_000_000, 1150);
    w.move(t.token, CURVE, POOL, 200_000_000, 1900);
    w.state.snaps.set(t.token, snap({ phase: 2, curveBps: 10_000, poolManager: POOL }));
    await w.pass();
    expect(board()[0]).toMatchObject({ holders: 1, phase: 2 });
  });
});

describe("the terminal's log", () => {
  it("writes down a launch, fees paid out, a burn and a graduation, each once, by how much", async () => {
    const w = world();
    const t = w.launch("Ledger Lens", "LENS", 1100);
    await w.pass();
    expect(events().map((e) => e.kind)).toEqual(["launch"]);
    expect(events()[0]).toMatchObject({ token: t.token, symbol: "LENS", name: "Ledger Lens" });

    w.state.snaps.set(t.token, snap({ feesEth: 0.03, burns: 1, burnedTokens: 120_000, burnedEth: 0.002 }));
    await w.pass();
    w.state.snaps.set(t.token, snap({ feesEth: 0.05, burns: 1, burnedTokens: 120_000, burnedEth: 0.002 }));
    await w.pass();
    await w.pass(); // nothing moved: nothing is written
    w.state.snaps.set(t.token, snap({ phase: 2, curveBps: 10_000, feesEth: 0.05, burns: 3, burnedTokens: 300_000, burnedEth: 0.006 }));
    await w.pass();

    const log = events().reverse();
    expect(log.map((e) => e.kind)).toEqual(["launch", "fees", "burn", "fees", "burn", "graduated"]);
    expect(log[1].eth).toBeCloseTo(0.03, 12);
    expect(log[2]).toMatchObject({ tokens: 120_000, eth: 0.002 });
    expect(log[3].eth).toBeCloseTo(0.02, 12);
    expect(log[4].tokens).toBeCloseTo(180_000, 6);
    // only what is newer than the last one seen
    expect(events(40, log[3].id).map((e) => e.kind)).toEqual(["graduated", "burn"]);
  });
});
