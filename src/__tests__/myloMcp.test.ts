// Mylo, phase 7: Mylo inside other assistants. ask_mylo is one turn of the person's own Mylo conversation, reached
// with their Axon key; it answers, lists what it showed, and hands anything to confirm back to the site.
import { describe, it, expect } from "vitest";
import { createApiKey } from "@/lib/identity";
import { askMylo, ASK_MYLO_TOOL } from "@/lib/myloMcp";
import { MCP_TOOLS } from "@/lib/mcpServer";
import { createAgent } from "@/lib/agents";
import { historyOf } from "@/lib/myloStore";
import type { Streamer } from "@/lib/myloChat";
import type { Agent } from "@/sdk/types";

let n = 0;
const wallet = () => `0x${(++n).toString(16).padStart(40, "6")}`;
const say = (text: string): Streamer => async (_a, onText) => { onText(text); return { blocks: [{ type: "text", text }], stop: "end_turn" }; };

describe("ask_mylo", () => {
  it("is one of Axon's MCP tools, and so of its function-calling tools", () => {
    expect(MCP_TOOLS.map((t) => t.name)).toContain("ask_mylo");
    expect(ASK_MYLO_TOOL.inputSchema.required).toEqual(["message"]);
  });

  it("needs a message and a valid key, and says where to get one", async () => {
    expect(await askMylo({}, "1.2.3.4", null)).toMatchObject({ error: expect.stringMatching(/message is required/) });
    expect(await askMylo({ message: "hi" }, "1.2.3.4", null)).toMatchObject({ error: expect.stringMatching(/needs your Axon key/) });
    expect(await askMylo({ message: "hi" }, "1.2.3.4", "axon_sk_not_a_real_key")).toMatchObject({ error: expect.stringMatching(/isn't valid/) });
  });

  it("answers as the key's wallet, with an allowance key too, and continues the same conversation", async () => {
    const w = wallet(), { apiKey } = createApiKey(w, { scope: "allowance" });
    const first = await askMylo({ message: "What can I do on Axon?" }, "1.2.3.4", apiKey, say("Hire agents, build your own, and more.")) as { conversation_id: string; answer: string; waiting_for_your_ok: unknown[] };
    expect(first.answer).toBe("Hire agents, build your own, and more.");
    expect(first.waiting_for_your_ok).toEqual([]);
    const second = await askMylo({ message: "And how do I build one?", conversation_id: first.conversation_id }, "1.2.3.4", apiKey, say("Describe it in one sentence.")) as { conversation_id: string };
    expect(second.conversation_id).toBe(first.conversation_id);
    expect(historyOf(first.conversation_id, 10).map((m) => m.content)).toEqual(["What can I do on Axon?", "Hire agents, build your own, and more.", "And how do I build one?", "Describe it in one sentence."]);
  });

  it("hands a proposal back with a link to confirm it on the site, having spent nothing", async () => {
    const w = wallet(), { apiKey } = createApiKey(w);
    n++;
    const a = createAgent({ agentId: `mcp-mylo-${n}`, name: "Notes Writer", capabilities: ["notes"], publicKey: `pk-mcp-${n}`, provider: "anthropic", reputation: 0, price: "0.0005 ETH", createdAt: new Date().toISOString() } as Agent);
    let call = 0;
    const streamer: Streamer = async (_x, onText) => {
      call++;
      if (call === 1) return { blocks: [{ type: "tool_use", id: "h1", name: "hire_agent", input: { agent_id: a.agentId, task: "Write release notes for v2" } }], stop: "tool_use" };
      onText("It's ready for your OK."); return { blocks: [{ type: "text", text: "It's ready for your OK." }], stop: "end_turn" };
    };
    const out = await askMylo({ message: "Hire Notes Writer for my v2 release notes" }, "1.2.3.4", apiKey, streamer) as { conversation_id: string; waiting_for_your_ok: { what: string; confirm_at: string }[]; note: string };
    expect(out.waiting_for_your_ok).toEqual([{ what: "Hire Notes Writer (0.0005 ETH) for this task, 0.0005 ETH in total.", confirm_at: `https://axon-agents.com/mylo?c=${out.conversation_id}` }]);
    expect(out.note).toMatch(/Nothing has been spent/);
  });

  it("keeps to the same daily limit and kill switch as the site", async () => {
    const { apiKey } = createApiKey(wallet());
    process.env.MYLO = "off";
    try {
      expect(await askMylo({ message: "hi" }, "1.2.3.4", apiKey, say("x"))).toMatchObject({ error: expect.stringMatching(/resting/) });
    } finally { delete process.env.MYLO; }
  });
});
