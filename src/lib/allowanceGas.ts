// Watching the allowance operator's gas.
//
// Every allowance payment is sent by one operator wallet: it sets the money aside, pays it out, and
// gives it back. When that wallet runs dry every payment stops at once, one-off hires and retainers
// alike, and the only sign used to be a string of refused hires. So the worker reads its balance every
// few minutes, the status page shows how many payments it has left, and the log says so loudly well
// before it is empty.

import { formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getDb } from "./db";
import { publicClient } from "./evm";
import { logger } from "./logger";
import { OPERATOR_KEY_ENV, allowancesEnabled } from "./allowancePolicy";

/** What one payment costs the operator, reserve plus its share of a batch payout, as measured at 0.028 gwei with room to spare. */
export const GAS_PER_PAYMENT_WEI = 5_000_000_000_000n; // 0.000005 ETH
/** Below this the status page turns amber and the log errors: roughly 40 payments left. */
export const LOW_GAS_WEI = 200_000_000_000_000n; // 0.0002 ETH
const CHECK_EVERY_MS = 10 * 60_000;
const STATE_KEY = "allowance_operator_gas";

const last = globalThis as typeof globalThis & { __axonOperatorGasCheckedAt?: number };

function operatorAddress(): `0x${string}` | null {
  const raw = process.env[OPERATOR_KEY_ENV]?.trim();
  if (!raw) return null;
  try {
    return privateKeyToAccount((raw.startsWith("0x") ? raw : `0x${raw}`) as `0x${string}`).address;
  } catch {
    return null;
  }
}

/** Read the operator's balance if it is time to, record it, and say so when it is low. */
export async function checkOperatorGas(nowMs = Date.now(), force = false): Promise<bigint | null> {
  if (!allowancesEnabled()) return null;
  if (!force && last.__axonOperatorGasCheckedAt && nowMs - last.__axonOperatorGasCheckedAt < CHECK_EVERY_MS) return null;
  const address = operatorAddress();
  if (!address) return null;
  last.__axonOperatorGasCheckedAt = nowMs;

  const wei = await publicClient().getBalance({ address });
  getDb()
    .prepare(`INSERT INTO worker_state (key, value, updated_at) VALUES (?, ?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run(STATE_KEY, wei.toString(), new Date(nowMs).toISOString());
  if (wei < LOW_GAS_WEI) {
    logger.error("allowance.operator_gas_low", "The allowance operator is running out of gas; top it up from the bot wallet", {
      operator: address,
      balance: formatEther(wei),
      paymentsLeft: Number(wei / GAS_PER_PAYMENT_WEI),
    });
  }
  return wei;
}

/** The last reading, for the status page. Null until the worker has read it once. */
export function operatorGasReading(): { wei: bigint; paymentsLeft: number; at: string } | null {
  try {
    const row = getDb().prepare(`SELECT value, updated_at FROM worker_state WHERE key = ?`).get(STATE_KEY) as
      { value: string; updated_at: string } | undefined;
    if (!row) return null;
    const wei = BigInt(row.value);
    return { wei, paymentsLeft: Number(wei / GAS_PER_PAYMENT_WEI), at: row.updated_at };
  } catch {
    return null;
  }
}
