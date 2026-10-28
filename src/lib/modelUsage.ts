import { AsyncLocalStorage } from "async_hooks";

// Model-usage side-channel. `complete()` returns a bare string and runs on the
// live money path, so token usage is captured without changing its signature:
// the provider reports usage into an AsyncLocalStorage slot the caller opens
// around the model call. With no slot active (any untraced call) it's a no-op.
//
// This module deliberately imports nothing but async_hooks — so the provider can
// use it without pulling the DB layer onto the model-call path.

interface UsageSlot {
  model?: string;
  inputTokens: number;
  outputTokens: number;
  calls: number;
  // What the provider itself said the calls cost, for a provider that says it (Raeto). Summed while every call
  // reported one; a single call without it makes the step's cost an estimate again.
  costUsd?: number;
  unpriced?: boolean;
}

const usageALS = new AsyncLocalStorage<UsageSlot>();

export function recordModelUsage(model: string, inputTokens: number, outputTokens: number, costUsd?: number): void {
  const slot = usageALS.getStore();
  if (!slot) return;
  slot.model = model;
  slot.inputTokens += inputTokens;
  slot.outputTokens += outputTokens;
  slot.calls += 1;
  if (costUsd !== undefined && Number.isFinite(costUsd) && costUsd >= 0) slot.costUsd = (slot.costUsd ?? 0) + costUsd;
  else slot.unpriced = true;
}

export interface CapturedStep<T> {
  result: T;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  calls: number;
  latencyMs: number;
  /** What the provider charged for the step, when it said so for every call; otherwise undefined (estimate it). */
  costUsd?: number;
}

// Run a model step inside a usage-capture context, returning the result plus the
// accumulated tokens (across any continuation calls) and measured latency.
export async function captureModelStep<T>(fn: () => Promise<T>): Promise<CapturedStep<T>> {
  const slot: UsageSlot = { inputTokens: 0, outputTokens: 0, calls: 0 };
  const t0 = Date.now();
  const result = await usageALS.run(slot, fn);
  return {
    result,
    model: slot.model,
    inputTokens: slot.inputTokens,
    outputTokens: slot.outputTokens,
    calls: slot.calls,
    latencyMs: Date.now() - t0,
    costUsd: slot.unpriced || slot.costUsd === undefined ? undefined : Math.round(slot.costUsd * 1_000_000) / 1_000_000,
  };
}
