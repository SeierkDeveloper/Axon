// Use an in-memory SQLite database for all tests — no disk I/O, no cleanup needed.
process.env.DATABASE_PATH = ":memory:";

// Suppress logger output during tests — only real errors pass through
process.env.LOG_LEVEL = "error";

// Fixed test wallet: a well-known EVM address
process.env.NEXT_PUBLIC_PAYMENT_RECEIVER_WALLET_ADDRESS = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";

// Chain answers that cannot change are kept between calls (lib/rpcCache.ts). The tests stand in for the chain and
// give one transaction hash a different receipt from test to test, which no chain does: so each test starts with
// nothing kept.
import { beforeEach } from "vitest";
import { resetRpcCache } from "@/lib/rpcCache";
beforeEach(() => resetRpcCache());
