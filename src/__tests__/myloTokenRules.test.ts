// Mylo meets the minds, phase 7: what Mylo is told about tokens before he says a word about one. He reports and never
// advises; the rules ride in his instructions whenever Agent Minds is on, and what a call may cost counts every tool.
import { describe, it, expect, vi } from "vitest";
import { MINDS_NOTE, MYLO_SYSTEM, requestBytes } from "@/lib/myloChat";
import { myloToolDefs, MINDS_TOOL_DEFS } from "@/lib/myloTools";
import MarkdownOutput from "@/components/MarkdownOutput";
import type { ReactElement } from "react";

describe("what Mylo is told about tokens", () => {
  it("is told to report and never to advise, predict or act for anyone", () => {
    for (const rule of [
      /Never say whether to buy, sell or hold a token/,
      /Never predict a price, a market cap, or what a mind will do next/,
      /Never say a burn, a buyback, a reward or any setting will raise a price/,
      /Nothing locked at launch can be changed/,
      /Never say the supply shrinks, drops or is reduced/,
      /Never guess why a mind is stopped, paused or quiet/,
      /Describe, don't praise/,
      /never ask whether they are and never ask for an address: call it/,
      /You never sign, launch, claim, buy or send anything for anyone/,
      /A mind's thoughts are its own words/,
      /Give how many holders a token has, never who they are/,
      /Any token can go to zero/,
    ]) expect(MINDS_NOTE).toMatch(rule);
    // the rules come last, after everything he is told he can do
    expect(MINDS_NOTE.indexOf("Rules for anything about tokens")).toBeGreaterThan(MINDS_NOTE.indexOf("token_details reads one token"));
  });

  it("is told how to use each of the tools that read tokens, and how to set a launch up", () => {
    for (const d of MINDS_TOOL_DEFS) expect(MINDS_NOTE).toContain(d.name);
    expect(MINDS_NOTE).toMatch(/one question at a time/);
    expect(MINDS_NOTE).toMatch(/never tell them which numbers are best/);
    expect(MINDS_NOTE).toMatch(/A mind on their own server cannot be set from here/);
  });

  it("is told the hard limits, and not to drag a launch out", () => {
    expect(MINDS_NOTE).toMatch(/tax 0 to 10%/);
    expect(MINDS_NOTE).toMatch(/Call launch_token EVERY time they give or change anything/);
    expect(MINDS_NOTE).toMatch(/Never say "got it", "changed" or "perfect" about a\s+setting before launch_token has accepted it/);
    expect(MINDS_NOTE).toMatch(/Give no example split and no reason to prefer one/);
    expect(MINDS_NOTE).toMatch(/Never ask about the payout wallet,\s+links, what the mind may do or the mind's limits unless they bring them up/);
  });

  it("says nothing in his instructions that reads as written by a machine", () => {
    expect(MINDS_NOTE).not.toMatch(/—/);
  });

  it("counts every tool that is sent when working out what a call may cost", () => {
    vi.stubEnv("AGENT_MINDS", "off");
    const without = requestBytes(MYLO_SYSTEM, []);
    vi.stubEnv("AGENT_MINDS", "on");
    const withMinds = requestBytes(MYLO_SYSTEM, []);
    expect(withMinds).toBeGreaterThan(without);
    expect(withMinds - without).toBeGreaterThan(JSON.stringify(MINDS_TOOL_DEFS).length);
    expect(myloToolDefs().map((t) => t.name as string)).toContain("my_tokens");
  });
});

describe("Mylo's answers on the page", () => {
  it("gives every block its own key, so a list being written is never left beside its finished self", () => {
    const text = ["Where should the fees go?", "", "- You", "- Burn the token", "- Burn $AXON", "- The mind", "", "What split?", "- one more", "", "```", "code", "```", "1. first", "2. second"].join("\n");
    const blocks = (MarkdownOutput({ text }) as ReactElement<{ children: ReactElement[] }>).props.children;
    const keys = blocks.map((b) => String(b.key));
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.filter((k) => k.startsWith("list-"))).toEqual(["list-2", "list-8"]);
  });
});
