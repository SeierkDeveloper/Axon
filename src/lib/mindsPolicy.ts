// Agent Minds: the decisions every other part of it reads.
//
// Axon as the launchpad where every token has a working agent and a mind behind it. A token is launched in one step
// (its starter agent comes with it), its creator chooses the tax and where the fees go once, at launch, and nothing
// about that can be changed afterwards. A share of the fees is the mind's treasury: the mind watches the token and its
// agent's work, thinks, and decides when to buy back and burn or reward holders, inside fixed rules, in public.
//
// The rules that keep that safe live here, in one place, so a check and the action that follows it never disagree:
//   - the whole of it is OFF until it is switched on (AGENT_MINDS=on): merged code shows nothing and starts nothing,
//     and the agent tokens launched before it keep working exactly as they did
//   - a launch's settings are fixed at launch, on chain: nobody, creator or Axon, can change a tax or a split later
//   - Axon takes no cut of these tokens
//   - a mind never holds a key: a separate signer sends only what the rule check approved, and the treasury's own
//     contract enforces the same limits again
//   - a mind's thinking is paid at cost from its own treasury share, so no mind can cost more than its token brought in

// ── On and off ────────────────────────────────────────────────────────────────

/**
 * The switch. Unlike Studio's and Mylo's it is off unless set: with anything but AGENT_MINDS=on no page shows Agent
 * Minds, no launch goes through its contracts and no mind thinks. The tokens launched the earlier way are not behind it.
 */
export function agentMindsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.AGENT_MINDS ?? "off").trim().toLowerCase() === "on";
}
