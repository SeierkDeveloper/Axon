// A chain nothing can be read from: every read fails. Tests spread it and write only the reads they are about, so a
// new kind of read added to the site does not have to be added to every test's chain by hand.
import type { MindsChain } from "@/lib/mindsChain";

const no = (what: string) => async (): Promise<never> => { throw new Error(`this test's chain has no ${what}`); };

export const unreadChain: MindsChain = {
  head: no("head"), launches: no("launches"), blockTime: no("block times"), tokenMeta: no("token names"), treasury: no("treasuries"),
  snapshot: no("snapshots"), transfers: no("transfers"), earlierToken: no("earlier tokens"), earlierTokenOf: no("earlier tokens"),
  vaultDay: async () => ({ spentTodayEth: 0, actionsToday: 0, costTodayEth: 0 }), feeFlow: no("fee flows"),
};
