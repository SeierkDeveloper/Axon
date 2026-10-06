// Agent Minds 2, phase 1: what a mind can sense: how its token's numbers moved over an hour, six hours and a day,
// roughly what was traded, what its largest holders own, what is unusual, and where it stands among the other tokens.
import { describe, it, expect } from "vitest";
import { getDb } from "@/lib/db";
import { sample, top10Bps, sensesOf, sensesLines, SAMPLE_MS, KEEP_DAYS } from "@/lib/mindsSenses";
import { upsertToken } from "@/lib/mindsStore";

let n = 0;
const addr = () => `0x${(++n + 3_300_000).toString(16).padStart(40, "0")}`;
const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);
const MIN = 60_000, HOUR = 60 * MIN;
const E18 = 10n ** 18n;

function token(symbol: string, mcapEth: number, holders: number, feesEth = 0): string {
  const t = addr();
  upsertToken({
    token: t, creator: addr(), agentId: null, agentRef: `0x${"0".repeat(64)}`, pot: addr(), splitter: addr(), vault: addr(), payout: addr(),
    taxBps: 300, creatorBps: 4000, burnBps: 3000, axonBps: 1000, mindBps: 2000, attached: false, name: `${symbol} Token`, symbol, logo: null, description: null,
    model: "claude-opus-5-5", mindUrl: null, blockNumber: 5000 + n, txHash: `0x${n.toString(16).padStart(64, "0")}`, launchedAt: new Date(NOW - 3 * 86_400_000).toISOString(),
  });
  getDb().prepare("INSERT INTO mind_stats (token, phase, price_eth, mcap_eth, curve_bps, holders, fees_eth, to_mind_eth, burned_tokens, burned_eth, burns, treasury_eth, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(t, 0, mcapEth / 1e9, mcapEth, 2000, holders, feesEth, 0, 0, 0, 0, 0.02, new Date(NOW).toISOString());
  return t;
}
const was = (t: string, minutesAgo: number, mcapEth: number, holders: number, feesEth = 0, top10Bps: number | null = null) =>
  getDb().prepare("INSERT INTO mind_history (token, at, mcap_eth, price_eth, holders, top10_bps, fees_eth) VALUES (?,?,?,?,?,?,?)").run(t, new Date(NOW - minutesAgo * MIN).toISOString(), mcapEth, mcapEth / 1e9, holders, top10Bps, feesEth);

describe("writing a token's numbers down", () => {
  it("takes one sample every ten minutes, however often it is asked", () => {
    const t = addr(), s = { mcapEth: 2, priceEth: 2e-9, holders: 10, top10Bps: 4000, feesEth: 0.1, burnedTokens: 0, treasuryEth: 0.01 };
    expect(sample(t, s, NOW)).toBe(true);
    expect(sample(t, s, NOW + 20_000)).toBe(false);
    expect(sample(t, s, NOW + SAMPLE_MS - 1)).toBe(false);
    expect(sample(t, { ...s, mcapEth: 3 }, NOW + SAMPLE_MS)).toBe(true);
    expect((getDb().prepare("SELECT COUNT(*) n FROM mind_history WHERE token = ?").get(t) as { n: number }).n).toBe(2);
  });

  it("lets go of samples older than it keeps", () => {
    const t = addr(), s = { mcapEth: 2, priceEth: 2e-9, holders: 10, top10Bps: null, feesEth: 0, burnedTokens: 0, treasuryEth: 0 };
    sample(t, s, NOW - (KEEP_DAYS + 1) * 86_400_000);
    sample(t, s, NOW - 86_400_000);
    sample(t, s, NOW);
    expect((getDb().prepare("SELECT COUNT(*) n FROM mind_history WHERE token = ?").get(t) as { n: number }).n).toBe(2);
  });

  it("works out what the ten largest holders own, leaving out who is not a holder", () => {
    const t = addr(), curve = addr(), db = getDb();
    const put = (a: string, tokens: bigint) => db.prepare("INSERT INTO mind_holders (token, address, balance) VALUES (?,?,?)").run(t, a, (tokens * E18).toString());
    expect(top10Bps(t, [curve])).toBeNull();
    put(curve, 800_000_000n);                       // the curve is not a holder
    for (let i = 0; i < 10; i++) put(addr(), 6n);   // ten who hold 6 each
    for (let i = 0; i < 20; i++) put(addr(), 2n);   // twenty who hold 2 each: 100 held in all
    expect(top10Bps(t, [curve.toUpperCase().replace("0X", "0x")])).toBe(6000);
    put(addr(), 0n);
    expect(top10Bps(t, [curve])).toBe(6000);
  });
});

describe("what a mind is told has moved", () => {
  it("compares now with an hour, six hours and a day ago, and estimates what was traded from the fees", () => {
    const t = token("MOVE", 3.3, 54, 0.9);
    was(t, 25 * 60, 2.0, 30, 0.3, 5200);  // a day ago (the newest sample at least a day old)
    was(t, 6 * 60 + 5, 3.0, 50, 0.6);     // six hours ago
    was(t, 62, 3.0, 52, 0.87);            // an hour ago
    was(t, 8, 3.2, 54, 0.9, 4100);        // just now
    const s = sensesOf(t, 300, NOW);
    expect(s.hour).toEqual({ capPct: 10, holders: 2, volumeEth: 1 });            // 0.03 ETH of fees at 3% is 1 ETH traded
    expect(s.sixHours).toEqual({ capPct: 10, holders: 4, volumeEth: 10 });
    expect(s.day).toEqual({ capPct: 65, holders: 24, volumeEth: 20 });
    expect(s.top10Pct).toBe(41); expect(s.top10PctDayAgo).toBe(52);
    expect(s.high24hEth).toBe(3.3); expect(s.fromHighPct).toBe(0);
    // a token with no tax has no fees to estimate trading from
    expect(sensesOf(t, 0, NOW).hour.volumeEth).toBeNull();
  });

  it("says nothing it cannot know: a young token, or a gap in the samples, has no comparison", () => {
    const young = token("YNG", 2, 9);
    was(young, 20, 1.9, 8);
    const s = sensesOf(young, 300, NOW);
    expect(s.hour).toEqual({ capPct: null, holders: null, volumeEth: null });
    expect(s.day.capPct).toBeNull();
    // a sample from four hours ago is not "an hour ago"
    const gap = token("GAP", 2, 9);
    was(gap, 4 * 60, 1, 5);
    expect(sensesOf(gap, 300, NOW).hour.capPct).toBeNull();
    expect(sensesLines(s)[0]).toBe("last_hour: not enough history yet");
    // and a token that is not here at all still answers, with nothing
    expect(sensesOf(addr(), 300, NOW).hour).toEqual({ capPct: null, holders: null, volumeEth: null });
  });

  it("puts what is unusual on its radar, and nothing when nothing is", () => {
    const calm = token("CALM", 3.0, 50, 0.5);
    was(calm, 62, 2.95, 50, 0.499); was(calm, 25 * 60, 2.9, 49, 0.45, 4000); was(calm, 5, 3.0, 50, 0.5, 4100);
    expect(sensesOf(calm, 300, NOW).radar).toEqual([]);
    expect(sensesLines(sensesOf(calm, 300, NOW))).toContain("radar: nothing unusual");

    const wild = token("WILD", 1.5, 40, 2.0);
    was(wild, 25 * 60, 2.4, 60, 1.0, 3000);   // a day ago
    was(wild, 10 * 60, 3.0, 62, 1.1);          // the high of the day
    was(wild, 62, 2.0, 52, 1.4);               // an hour ago
    was(wild, 5, 1.5, 40, 2.0, 4200);          // now
    const radar = sensesOf(wild, 300, NOW).radar;
    expect(radar).toContain("market cap down 25% in the last hour");
    expect(radar).toContain("holders down 12 in the last hour");
    expect(radar.some((r) => /times the usual hourly volume/.test(r))).toBe(true);
    expect(radar).toContain("50% below its high of the last day");
    expect(radar).toContain("the ten largest holders went from 30% to 42% in a day");
  });

  it("knows where it stands among the other tokens here", () => {
    const db = getDb();
    db.prepare("DELETE FROM mind_stats"); db.prepare("DELETE FROM mind_tokens").run(); db.prepare("DELETE FROM mind_stats").run();
    const alone = token("SOLO", 2, 10);
    expect(sensesOf(alone, 300, NOW).peers).toEqual({ count: 0, rank: 1, biggest: [] });
    expect(sensesLines(sensesOf(alone, 300, NOW)).at(-1)).toBe("other_tokens_here: none yet, you are the only one");
    token("BIGA", 40, 900); token("BIGB", 12, 300); token("SMOL", 1, 4); token("TINY", 0.5, 2);
    const s = sensesOf(alone, 300, NOW);
    expect(s.peers.count).toBe(4); expect(s.peers.rank).toBe(3);
    expect(s.peers.biggest.map((p) => p.symbol)).toEqual(["BIGA", "BIGB", "SMOL"]);
    expect(sensesLines(s).at(-1)).toBe("other_tokens_here: 4; you are 3rd by market cap. $BIGA 40 ETH, 900 holders; $BIGB 12 ETH, 300 holders; $SMOL 1 ETH, 4 holders");
  });

  it("reads as six short lines", () => {
    const t = token("LINE", 3.3, 54, 0.9);
    was(t, 25 * 60, 2.0, 30, 0.3, 5200); was(t, 6 * 60 + 5, 3.0, 50, 0.6); was(t, 62, 3.0, 52, 0.87); was(t, 8, 3.2, 54, 0.9, 4100);
    const lines = sensesLines(sensesOf(t, 300, NOW));
    expect(lines.slice(0, 5)).toEqual([
      "last_hour: market cap +10%, holders +2, about 1 ETH traded",
      "last_6_hours: market cap +10%, holders +4, about 10 ETH traded",
      "last_24_hours: market cap +65%, holders +24, about 20 ETH traded; high 3.3 ETH (at it now)",
      "ten_largest_holders_own: 41% of what holders hold (52% a day ago)",
      "radar: market cap up 10% in the last hour; the ten largest holders went from 52% to 41% in a day",
    ]);
    expect(lines.join("\n").length).toBeLessThan(700);
  });
});
