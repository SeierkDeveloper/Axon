// What an ETH is worth in dollars, for showing a market cap the way people read one. Display only: nothing is ever
// priced, paid or decided with this number. Null when it cannot be read, and the page shows ETH instead.

let cached: { usd: number; at: number } | null = null;
let inFlight: Promise<number | null> | null = null;
const FRESH_MS = 60_000;
const USABLE_MS = 15 * 60_000;

export async function ethUsd(): Promise<number | null> {
  if (cached && Date.now() - cached.at < FRESH_MS) return cached.usd;
  if (!inFlight) {
    inFlight = fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd", { signal: AbortSignal.timeout(4000) })
      .then(async (r) => {
        const usd = r.ok ? Number(((await r.json()) as { ethereum?: { usd?: number } }).ethereum?.usd) : NaN;
        if (Number.isFinite(usd) && usd > 0) cached = { usd, at: Date.now() };
        return Number.isFinite(usd) && usd > 0 ? usd : null;
      })
      .catch(() => null)
      .finally(() => { inFlight = null; });
  }
  const fresh = await inFlight;
  // a price a few minutes old is still the right order of magnitude; an hour old is not shown
  return fresh ?? (cached && Date.now() - cached.at < USABLE_MS ? cached.usd : null);
}
