// Agent Minds' switch: off unless it is switched on, so merged code shows and starts nothing.
import { describe, it, expect } from "vitest";
import { agentMindsEnabled } from "@/lib/mindsPolicy";

describe("the Agent Minds switch", () => {
  it("is off unless it is set to on", () => {
    expect(agentMindsEnabled({})).toBe(false);
    expect(agentMindsEnabled({ AGENT_MINDS: "" })).toBe(false);
    expect(agentMindsEnabled({ AGENT_MINDS: "off" })).toBe(false);
    expect(agentMindsEnabled({ AGENT_MINDS: "true" })).toBe(false);
    expect(agentMindsEnabled({ AGENT_MINDS: "on" })).toBe(true);
    expect(agentMindsEnabled({ AGENT_MINDS: " ON " })).toBe(true);
  });
});
