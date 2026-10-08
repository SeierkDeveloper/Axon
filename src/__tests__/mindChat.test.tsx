// Talk to the mind, on the token's page: the box to ask, the exchanges under it, and the sign-in line. Rendered to
// static markup, with the wallet stubbed, so the branches a visitor and a signed-in wallet see are both exercised.

import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";

const wallet = { address: null as string | null, apiKey: null as string | null, signIn: vi.fn(), busy: false };
vi.mock("@/components/WalletProvider", () => ({ useWallet: () => wallet }));

const { default: MindChat } = await import("@/app/launch/MindChat");

const NOW = Date.parse("2026-10-08T15:00:00Z");
const chats = [
  { id: 2, asker: "0x1234…abcd", question: "What are you watching?", answer: "The holder count, mostly.", modelLabel: "Claude", standin: false, at: "2026-10-08T14:58:00Z" },
  { id: 1, asker: null, question: "Why did you hold?", answer: "My plan keeps a reserve and the treasury is near it.", modelLabel: "Stand-in", standin: true, at: "2026-10-08T13:00:00Z" },
];

describe("MindChat", () => {
  it("a visitor sees the box, the sign-in line and the exchanges with wallets shortened", () => {
    const html = renderToStaticMarkup(<MindChat token="0xabc" symbol="FERRY" chats={chats} maxChars={300} now={NOW} stopped={false} onAsked={() => {}} />);
    expect(html).toContain("Ask $FERRY");
    expect(html).toContain("Sign in with your wallet to ask as yourself");
    expect(html).toContain("0x1234…abcd asked");
    expect(html).toContain("a visitor asked");
    expect(html).toContain("The holder count, mostly.");
    expect(html).toContain("2m ago · Claude");
    expect(html).toContain("0 / 300");
    expect(html).not.toContain("—");
  });

  it("a signed-in wallet is told it asks as itself", () => {
    wallet.address = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
    wallet.apiKey = "axon_test";
    const html = renderToStaticMarkup(<MindChat token="0xabc" symbol={null} chats={[]} maxChars={300} now={NOW} stopped={false} onAsked={() => {}} />);
    expect(html).toContain("Asking as 0x7099…79c8.");
    expect(html).toContain("Ask its mind");
    expect(html).toContain("Nobody has asked it anything yet.");
    expect(html).not.toContain("Sign in with your wallet");
    wallet.address = null;
    wallet.apiKey = null;
  });

  it("a stopped mind shows what was asked but no box", () => {
    const html = renderToStaticMarkup(<MindChat token="0xabc" symbol="FERRY" chats={chats} maxChars={300} now={NOW} stopped onAsked={() => {}} />);
    expect(html).not.toContain("<textarea");
    expect(html).toContain("Why did you hold?");
  });
});
