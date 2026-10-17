import { describe, it, expect, vi } from "vitest";
import { createAgent } from "@/lib/agents";
import { createTask } from "@/lib/tasks";
import { getDb } from "@/lib/db";
import type { Agent } from "@/sdk/types";

// the agent's own model, stood in for: the plan asks for nothing, the answer is written directly
vi.mock("@/lib/providers", async (orig) => ({
  ...(await orig<typeof import("@/lib/providers")>()),
  getProvider: () => ({ complete: async (_s: string, prompt: string) => (prompt.includes("Return ONLY a JSON array") ? "[]" : "THE ANSWER") }),
}));

const { runOrchestration } = await import("@/lib/orchestrator");

describe("an orchestrator's own model calls", () => {
  it("are steps in the job's trace, so what they cost can be read from it", async () => {
    const mk = (id: string, orchestrator: boolean): Agent => {
      const a: Agent = { agentId: id, name: id, capabilities: ["x"], publicKey: `pk-${id}`, walletAddress: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8", provider: "anthropic", reputation: 0, orchestrator, createdAt: new Date().toISOString() };
      createAgent(a);
      return a;
    };
    const lead = mk(`orc-trace-${Date.now()}`, true), buyer = mk(`orc-trace-buyer-${Date.now()}`, false);
    const task = createTask({ fromAgent: buyer.agentId, toAgent: lead.agentId, task: "A job it does alone", initialStatus: "running", startedBy: "orchestrator" });
    await runOrchestration(lead, task, { pollMs: 5, perHireTimeoutMs: 200 });
    const steps = getDb().prepare("SELECT kind FROM trace_events WHERE task_id = ? AND kind = 'step.model'").all(task.taskId);
    expect(steps).toHaveLength(2); // the plan, then the answer
  });
});
