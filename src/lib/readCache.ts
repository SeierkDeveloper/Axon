// A small cache for reads that are slow and the same for everyone: the chain, mostly.
//
// Every visitor to the burn page used to cost nine calls to the Robinhood node, in two rounds, so the page
// waited on the node once per viewer. With this, the node is read at most once per `ttlMs` however many people
// are looking:
//   - callers that arrive together share one read instead of starting one each
//   - past its time to live, the last good value is still answered at once while one refresh runs behind it,
//     up to `staleMs`; after that a caller waits for a fresh read
//   - a failed read is never stored: the last good value stays until a read succeeds
//
// Per process, in memory. Nothing here is a source of truth, only a copy of one for a few seconds.

interface Entry<T> {
  value?: T;
  at: number; // when `value` was read
  inflight?: Promise<T>;
}

const entries = new Map<string, Entry<unknown>>();

export async function cachedRead<T>(key: string, ttlMs: number, load: () => Promise<T>, staleMs = ttlMs * 6): Promise<T> {
  const now = Date.now();
  const e = (entries.get(key) as Entry<T> | undefined) ?? { at: 0 };
  entries.set(key, e);
  const age = now - e.at;
  const has = e.value !== undefined;

  if (has && age < ttlMs) return e.value as T;

  const refresh = () => {
    if (!e.inflight) {
      e.inflight = load()
        .then((v) => {
          e.value = v;
          e.at = Date.now();
          return v;
        })
        .finally(() => {
          e.inflight = undefined;
        });
    }
    return e.inflight;
  };

  if (has && age < ttlMs + staleMs) {
    // answer now with what we have; the refresh lands for the next caller
    refresh().catch(() => {});
    return e.value as T;
  }
  return refresh();
}

/** Test seam: forget everything. */
export function clearReadCache() {
  entries.clear();
}
