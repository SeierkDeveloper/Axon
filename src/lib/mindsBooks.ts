// Agent Minds 2: the mind's books.
//
// A mind runs a small fund in the open. These are its books on one screen: what has come in from the token's trading
// fees, what it holds, what it has spent and on what, what it keeps back (the reserve its plan sets, and what it holds
// for promises), what is free, and how long it can keep paying for its own thinking at the pace it thinks now.
// Every figure is the chain's or Axon's own record; none of it is a forecast.

import { getDb } from "./db";
import type { Treasury } from "./mindsChain";
import { owedThinkingEth } from "./mindsMind";
import { reserveOf } from "./mindsPlan";
import { heldFor } from "./mindsOrders";
import { THINKING_RESERVE_ETH } from "./mindsRules";

export interface Books {
  /** what the token's trading fees have sent to the mind since launch */
  fromFeesEth: number;
  /** what its treasury holds now, outside what is set aside for holders */
  holdsEth: number;
  /** set aside for holders and not claimed yet */
  setAsideEth: number;
  spent: { buybackEth: number; rewardEth: number; burnAxonEth: number; thinkingEth: number };
  /** thinking it has done and not paid for yet */
  owedThinkingEth: number;
  /** the floor its own plan keeps, and what it holds for promises it has made */
  reserveEth: number; heldForPromisesEth: number;
  /** what it could spend right now on an action */
  freeEth: number;
  /** what its thinking has cost per day lately; null when it has cost nothing */
  thinkingPerDayEth: number | null;
  /** how many days its treasury covers its thinking at that pace; null when its thinking costs nothing */
  runwayDays: number | null;
}

const DAYS = 3;

export function booksOf(token: string, treasury: Treasury, toMindEth: number, now = Date.now()): Books {
  const t = token.toLowerCase();
  const owed = owedThinkingEth(t), reserveEth = reserveOf(t), held = heldFor(t);
  // what its thinking really cost over the last days it has been thinking, a day at a time
  const first = (getDb().prepare("SELECT MIN(at) v FROM mind_thoughts WHERE token = ? AND standin = 0 AND cost_eth > 0").get(t) as { v: string | null }).v;
  const cost = (getDb().prepare("SELECT COALESCE(SUM(cost_eth), 0) v FROM mind_thoughts WHERE token = ? AND standin = 0 AND at >= ?").get(t, new Date(now - DAYS * 86_400_000).toISOString()) as { v: number }).v;
  const days = first ? Math.min(DAYS, Math.max(1 / 24, (now - Date.parse(first)) / 86_400_000)) : 0;
  const perDay = days > 0 && cost > 0 ? cost / days : null;
  return {
    fromFeesEth: toMindEth, holdsEth: treasury.availableEth, setAsideEth: treasury.reservedEth,
    spent: { buybackEth: treasury.boughtBackEth, rewardEth: treasury.rewardedEth, burnAxonEth: treasury.axonBurnedEth, thinkingEth: treasury.thinkingEth },
    owedThinkingEth: owed, reserveEth, heldForPromisesEth: held,
    freeEth: Math.max(0, treasury.availableEth - owed - THINKING_RESERVE_ETH - reserveEth - held),
    thinkingPerDayEth: perDay,
    runwayDays: perDay ? Math.floor(Math.max(0, treasury.availableEth - owed) / perDay) : null,
  };
}
