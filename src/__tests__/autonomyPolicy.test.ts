import { describe, it, expect } from "vitest";
import {
  actionsEnabled,
  isFailing,
  pauseBudget,
  looksLikeOutage,
  isPublic,
  VISIBILITY,
  NEVER_TOUCHES,
  ROUTING_PAUSE,
} from "@/lib/autonomyPolicy";

describe("autonomy policy", () => {
  it("acts by default, and AUTONOMY_ACTIONS=off stops every action", () => {
    expect(actionsEnabled({})).toBe(true);
    expect(actionsEnabled({ AUTONOMY_ACTIONS: "on" })).toBe(true);
    expect(actionsEnabled({ AUTONOMY_ACTIONS: "off" })).toBe(false);
    expect(actionsEnabled({ AUTONOMY_ACTIONS: " OFF " })).toBe(false);
  });

  it("calls an agent failing on a poor day of real work, not on one bad answer", () => {
    expect(isFailing({ finished: 2, succeeded: 0, failedInARow: 2 })).toBe(false); // too little to judge
    expect(isFailing({ finished: 10, succeeded: 3, failedInARow: 0 })).toBe(true); // 30%
    expect(isFailing({ finished: 10, succeeded: 6, failedInARow: 0 })).toBe(false); // 60%
    expect(isFailing({ finished: 1, succeeded: 0, failedInARow: 3 })).toBe(true); // three in a row
  });

  it("pauses at most a few agents a run and never more than a tenth of the network", () => {
    expect(pauseBudget(95, 0)).toBe(ROUTING_PAUSE.maxPerRun); // 5, under the ceiling of 9
    expect(pauseBudget(95, 7)).toBe(2); // only up to the ceiling
    expect(pauseBudget(95, 9)).toBe(0);
    expect(pauseBudget(8, 0)).toBe(0); // a tiny network is never thinned out
  });

  it("reads many failures at once as an outage, and does nothing about it", () => {
    expect(looksLikeOutage(95, 5)).toBe(false);
    expect(looksLikeOutage(95, 19)).toBe(true);
    expect(looksLikeOutage(0, 0)).toBe(false);
  });

  it("keeps money, prices and listings off the public page", () => {
    expect(isPublic("agent-restored")).toBe(true);
    expect(isPublic("code-check")).toBe(true);
    for (const k of ["payment-mismatch", "fee-flow", "price-outlier", "dormant-listing", "duplicate-listing", "outage"] as const) {
      expect(isPublic(k)).toBe(false);
    }
    expect(Object.keys(VISIBILITY).length).toBeGreaterThan(10);
  });

  it("names what it never touches, payments and receipts first", () => {
    expect(NEVER_TOUCHES[0]).toMatch(/payments/);
    expect(NEVER_TOUCHES.join(" ")).toMatch(/receipt/);
  });
});
