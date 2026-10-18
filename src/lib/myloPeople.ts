// Agents that hire people, through Mylo.
//
// A person can ask Mylo to have one of their agents hire a person (a call, a photo, a look at a place, a judgement), and
// to say how their tasks for people are going. Posting one locks the pay from the agent's earnings, so Mylo only writes
// it down: the card shows the task, what the proof must show and the pay, and nothing is posted until the person taps
// Post (./myloActions proposePeople). Mylo never picks the pay for them. Reading spends nothing.
//
// Nothing here is offered while AGENT_PEOPLE is off.

import { PEOPLE, PROOF_KINDS, peopleCaps, peopleEnabled } from "./peoplePolicy";
import { ownerView, tasksOfOwner } from "./people";
import { proposePeople } from "./myloActions";
import { formatEth } from "./money";

type Input = Record<string, unknown>;
const text = (v: unknown): string => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");

export function myloPeopleTools(): { name: string; description: string; input_schema: Record<string, unknown> }[] {
  if (!peopleEnabled()) return [];
  const caps = peopleCaps();
  return [
    {
      name: "hire_a_person",
      description:
        "Write down one of the person's own agents posting a task for people, for them to confirm on a card: something only a person can do, like calling a business to ask a question, photographing a public place or a thing, checking something in the real world, or judging whether something looks right. " +
        `Needs the agent, a title, what to do, the proof (photo, file or answer), 1 to ${PEOPLE.checksMax} lines the proof must show (the only grounds to reject it), and the pay in ETH from them (${formatEth(caps.minPriceWei)} to ${formatEth(caps.maxPriceWei)}), paid from the agent's earnings. ` +
        "Never pick the pay for them: ask. Refuse anything about a private person, anything unsafe or illegal, or any task that has someone pay or receive money. Nothing is posted until they tap Post.",
      input_schema: {
        type: "object",
        properties: {
          agent_id: { type: "string" }, title: { type: "string" }, details: { type: "string" },
          place: { type: "string", description: "An area or a public place, if it matters. Never a private address" },
          proof: { type: "string", enum: [...PROOF_KINDS] }, checks: { type: "array", items: { type: "string" } },
          pay_eth: { type: "string" }, hours: { type: "number", description: `Hours the person has once they take it, ${PEOPLE.takeHoursMin} to ${PEOPLE.takeHoursMax}` },
        },
        required: ["agent_id", "title", "details", "proof", "checks", "pay_eth"],
      },
    },
    { name: "my_people_tasks", description: "How the tasks for people that the person's agents posted are going: open, taken, being checked, waiting for their answer (with when the person is paid if they do not answer), accepted and paid, or closed, with the verdict's reason.", input_schema: { type: "object", properties: {} } },
  ];
}

export const MYLO_PEOPLE_LABELS: Record<string, string> = { hire_a_person: "Writing the task for people", my_people_tasks: "Looking at your tasks for people" };

export function myloPeopleNote(): string {
  if (!peopleEnabled()) return "";
  return `\n\nAgents that hire people:
- When an agent needs something only a person can do (a call to a business, a photo of a place, a check in the real
  world, a judgement), it can post a task for people. Anyone signed in with a wallet takes it on the board
  (/agents?view=people) and hands in proof; the agent checks it against the lines the task listed, and an accepted task
  is paid in ETH on Robinhood Chain from the agent's earnings, locked when it is posted.
- hire_a_person only writes it down for them to confirm on a card. Ask for the pay; never choose it. my_people_tasks says
  how theirs are going, using only what it returns. Proofs that wait for their answer are on the Dashboard.
- Never present doing tasks for people as income or a way to make money.`;
}

export async function runMyloPeopleTool(name: string, input: Input, ctx: { wallet: string | null; owner: string; conversationId: string }): Promise<{ result: unknown; actionId?: string } | undefined> {
  if (!peopleEnabled() || !(name in MYLO_PEOPLE_LABELS)) return undefined;
  if (!ctx.wallet) return { result: { error: "Sign in with your wallet first." } };
  if (name === "hire_a_person") {
    const p = proposePeople(ctx, {
      agentId: text(input.agent_id), title: input.title, details: input.details, place: input.place, proof: input.proof,
      checks: Array.isArray(input.checks) ? input.checks.map(String) : input.checks, priceEth: text(input.pay_eth), takeHours: input.hours,
    });
    if (typeof p === "string") return { result: { error: p } };
    return { result: { proposed: true, actionId: p.id, summary: p.summary, note: "Proposed only. Nothing is posted until the person taps Post on the card. Say what you wrote down in a sentence." }, actionId: p.id };
  }
  const mine = tasksOfOwner(ctx.wallet, 15).map(ownerView);
  return {
    result: {
      tasks: mine.map((t) => ({
        title: t.title, agent: t.agent.name, pay: t.pay, status: t.status, taken_by: t.takenBy, paid_from: t.funding === "wallet" ? "your wallet" : "the agent's earnings",
        waiting_for_you_until: t.status === "review" ? t.reviewUntil : null, last_verdict: t.deliveries.at(-1) ? { verdict: t.deliveries.at(-1)!.verdict, reason: t.deliveries.at(-1)!.reason } : null,
        paid: t.payouts.find((p) => p.kind === "pay" && p.status === "sent") ? true : false,
      })),
      dashboard: "/dashboard#people", board: "/agents?view=people",
      note: mine.length ? "Use only these." : "None of their agents has posted a task for people yet.",
    },
  };
}
