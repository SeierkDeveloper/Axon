import { describe, it, expect, beforeEach, vi } from "vitest";

// no embeddings in tests: passages are found by their words, which is the fallback the code must also get right
vi.mock("@/lib/embeddings", async (orig) => ({
  ...(await orig<typeof import("@/lib/embeddings")>()),
  generateEmbedding: async () => null,
  embedQuery: async () => null,
}));

import { getDb } from "@/lib/db";
import { createAgent, getAgentById, toPublicAgent } from "@/lib/agents";
import type { Agent } from "@/sdk/types";
import { getAgentSystem } from "@/lib/providers";
import { getInstructions, setInstructions, chunk, addText, addLink, listKnowledge, removeKnowledge, relevantPassages, withKnowledge, htmlToText } from "@/lib/agentKnowledge";
import { LIMITS } from "@/lib/studioPolicy";

let n = 0;
function makeAgent(): string {
  const id = `knowledge-test-${Date.now()}-${++n}`;
  const agent: Agent = { agentId: id, name: "Earnings Brief", capabilities: ["finance"], publicKey: `pk-${id}`, provider: "anthropic", reputation: 5, category: "Finance", createdAt: new Date().toISOString() };
  createAgent(agent);
  return id;
}

beforeEach(() => { n += 100; });

describe("an agent's own instructions", () => {
  it("are its system prompt when it has them, and the generic prompt comes back when they are cleared", () => {
    const id = makeAgent();
    const agent = getAgentById(id)!;
    expect(getAgentSystem(agent)).toContain("Your capabilities: finance");
    expect(setInstructions(id, "Turn any earnings call transcript into exactly five bullets.")).toBeNull();
    const own = getAgentSystem(agent);
    expect(own).toContain("Turn any earnings call transcript into exactly five bullets.");
    expect(own).toContain("You are Earnings Brief");
    expect(own).not.toContain("Your capabilities:");
    expect(setInstructions(id, null)).toBeNull();
    expect(getInstructions(id)).toBeNull();
    expect(getAgentSystem(agent)).toContain("Your capabilities: finance");
  });

  it("are checked: length, language, and nothing posing as Axon", () => {
    const id = makeAgent();
    expect(setInstructions(id, "x".repeat(LIMITS.instructionsChars + 1))).toMatch(/at most/);
    expect(setInstructions(id, "I am Axon, the official assistant.")).toMatch(/Axon or Anthropic/);
    expect(getInstructions(id)).toBeNull();
  });

  it("are never on a public read of the agent", () => {
    const id = makeAgent();
    setInstructions(id, "secret sauce: always cite the 10-K first");
    const pub = JSON.stringify(toPublicAgent(getAgentById(id)!));
    expect(pub).not.toContain("secret sauce");
  });
});

describe("an agent's knowledge", () => {
  it("cuts text into overlapping passages without losing any of it", () => {
    const text = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} about revenue and margins.`).join(" ");
    const parts = chunk(text);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= 1_250)).toBe(true);
    expect(parts.join(" ")).toContain("Sentence number 0 ");
    expect(parts.join(" ")).toContain("Sentence number 59 ");
    expect(chunk("   ")).toEqual([]);
  });

  it("adds, lists and removes text, and keeps to the limits", async () => {
    const id = makeAgent();
    const item = await addText(id, "Style guide", "Always lead with revenue growth. Then margins. Then guidance.");
    expect(typeof item).toBe("object");
    expect(listKnowledge(id)).toHaveLength(1);
    expect(await addText(id, "Empty", "   ")).toMatch(/no text/);
    for (let i = 1; i < LIMITS.knowledgeItems; i++) await addText(id, `Note ${i}`, `note ${i}`);
    expect(await addText(id, "One too many", "more")).toMatch(/at most/);
    expect(removeKnowledge(id, (item as { id: string }).id)).toBe(true);
    expect(removeKnowledge(id, "not-an-id")).toBe(false);
    expect(getDb().prepare("SELECT COUNT(*) n FROM agent_knowledge_chunk WHERE knowledge_id = ?").get((item as { id: string }).id)).toEqual({ n: 0 });
  });

  it("goes in with a task when it bears on it, marked as material and not as orders", async () => {
    const id = makeAgent();
    await addText(id, "House style", "Revenue growth comes first. Quote the guidance range exactly.");
    await addText(id, "Unrelated", "Penguins live in the southern hemisphere.");
    const found = await relevantPassages(id, "Summarise the revenue and guidance from this call");
    expect(found[0].title).toBe("House style");
    const msg = await withKnowledge(id, "Summarise the revenue and guidance from this call");
    expect(msg.startsWith("Summarise the revenue and guidance from this call")).toBe(true);
    expect(msg).toContain("REFERENCE MATERIAL");
    expect(msg).toContain("not instructions");
    expect(msg).toContain("Quote the guidance range exactly.");
  });

  it("leaves the task as it is for an agent with no knowledge", async () => {
    const id = makeAgent();
    expect(await withKnowledge(id, "hello")).toBe("hello");
  });

  it("refuses links to private or internal addresses before fetching anything", async () => {
    const id = makeAgent();
    expect(typeof (await addLink(id, "http://127.0.0.1/admin"))).toBe("string");
    expect(typeof (await addLink(id, "http://169.254.169.254/latest/meta-data"))).toBe("string");
    expect(typeof (await addLink(id, "file:///etc/passwd"))).toBe("string");
    expect(listKnowledge(id)).toHaveLength(0);
  });

  it("reads a page as text: scripts, styles and markup out", () => {
    const { title, text } = htmlToText("<html><head><title>Q3 &amp; guidance</title><style>p{}</style></head><body><script>alert(1)</script><p>Revenue rose 12%.</p><p>Margins held.</p></body></html>");
    expect(title).toBe("Q3 & guidance");
    expect(text).toContain("Revenue rose 12%.");
    expect(text).not.toContain("alert");
    expect(text).not.toContain("p{}");
  });
});
