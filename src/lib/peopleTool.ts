// Agents that hire people: the tool an agent running its own business uses during a job.
//
// When the job needs something only a person can do (a call to a business, a photo of a place, a look at something in
// the real world, a person's judgement), the agent posts a task for people with what it needs and what the proof must
// show. It is paid from the agent's earnings, inside its business's limits (./businessLimits, kind "people"): above
// the amount its owner approves themselves, the task waits for their OK in the approvals inbox before it is locked and
// goes on the board. The task does not hold the job up: a person may take hours. Its owner follows it on the dashboard,
// and the job's receipt shows it was posted and how it ended.
//
// Only for an agent Axon runs on Claude, whose business is running and lets it hire people, while AGENT_PEOPLE is on.

import type { LocalTool, ResolvedTools } from "./agentTools";
import { getAgentById } from "./agents";
import { formatEth } from "./money";
import { requestSpendApproval } from "./appPermissions";
import { businessEnabled } from "./businessPolicy";
import { businessOfAgent, decide, type Business } from "./business";
import { checkSpend } from "./businessLimits";
import { record } from "./businessLedger";
import { PEOPLE, PROOF_KINDS, peopleCaps, peopleEnabled } from "./peoplePolicy";
import { postPeopleTask, readTask, type RulesJudge } from "./people";
import { realRulesJudge } from "./peopleCheck";

export const PEOPLE_TOOL = "hire_a_person";

/** The business that lets this agent hire people in this job, or null. */
export function peopleBusiness(agent: { agentId: string; provider?: string | null; orchestrator?: unknown; endpoint?: string | null }, o: { viaMcp?: boolean } = {}): Business | null {
  if (!peopleEnabled() || !businessEnabled()) return null;
  if (o.viaMcp || agent.orchestrator || agent.endpoint || (agent.provider ?? "anthropic") !== "anthropic") return null;
  const b = businessOfAgent(agent.agentId);
  return b && b.status === "active" && b.limits.kinds.includes("people") ? b : null;
}

export function peopleTool(ctx: { agentId: string; taskId: string; business: Business; judge?: RulesJudge; say?: (line: string) => void }): LocalTool {
  const caps = peopleCaps();
  return {
    name: PEOPLE_TOOL,
    label: "people/hire",
    description:
      "Post a task for a person when this job needs something only a person can do: call a business and ask a question, take a photo of a public place or a thing, " +
      "check something in the real world, or judge whether something looks right to a person. It is paid from your earnings, inside your business's limits, and the " +
      "person is paid only when their proof meets every line you list in `checks`. It does not hold this job up: a person may take hours, so finish the job with what you " +
      "have and say in your answer that you posted it. Never ask for anything about a private person, anything unsafe or illegal, or for anyone to pay or receive money. " +
      `Pay between ${formatEth(caps.minPriceWei)} and ${formatEth(caps.maxPriceWei)}.`,
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: `What the task is, ${PEOPLE.titleMinChars} to ${PEOPLE.titleChars} characters` },
        details: { type: "string", description: "What to do, step by step, in plain words" },
        place: { type: "string", description: "An area or a public place, if it matters. Never a private address" },
        proof: { type: "string", enum: [...PROOF_KINDS], description: "What to hand in" },
        checks: { type: "array", items: { type: "string" }, description: `1 to ${PEOPLE.checksMax} lines the proof must show. Only these can be a reason to reject it` },
        pay_eth: { type: "string", description: "The pay in ETH, for example 0.0005" },
        hours: { type: "number", description: `Hours the person has once they take it, ${PEOPLE.takeHoursMin} to ${PEOPLE.takeHoursMax}` },
      },
      required: ["title", "details", "proof", "checks", "pay_eth"],
    },
    run: async (args) => {
      const owner = getAgentById(ctx.agentId)?.walletAddress;
      if (!owner) return "Error: this agent has no owner wallet.";
      const input = { agentId: ctx.agentId, title: args.title, details: args.details, place: args.place, proof: args.proof, checks: args.checks, priceEth: args.pay_eth, takeHours: args.hours, funding: "earnings" };
      const read = readTask(input, caps);
      if (!read.ok) return `Error: ${read.why}`;
      const wei = read.value.priceWei;
      const b = businessOfAgent(ctx.agentId) ?? ctx.business;
      const verdict = checkSpend(b, { kind: "people", wei, jobRef: ctx.taskId });
      let approvalId: string | null = null;
      if (!verdict.ok && verdict.ask) {
        try {
          approvalId = requestSpendApproval({
            ownerWallet: b.ownerWallet, agentId: ctx.agentId, taskId: ctx.taskId,
            title: `Hire a person for ${formatEth(wei)}: ${read.value.title}`,
            preview: `${getAgentById(ctx.agentId)?.name ?? ctx.agentId} wants to post a task for people for a job it is doing for its business, paying ${formatEth(wei)} from its earnings.\n\n${read.value.title}\n\n${read.value.details}\n\nThe proof must show:\n${read.value.checks.map((c) => `- ${c}`).join("\n")}`,
            payload: { kind: "people", businessId: b.businessId, parentTaskId: ctx.taskId, wei: wei.toString(), title: read.value.title },
          }).approvalId;
        } catch (err) {
          return `Error: could not ask your owner: ${err instanceof Error ? err.message : String(err)}`;
        }
      } else if (!verdict.ok) {
        decide(b.businessId, "refuse", `Did not hire a person: ${verdict.why}`, { subject: ctx.taskId });
        return `Error: ${verdict.why}.`;
      }
      const r = await postPeopleTask(input, { wallet: owner, postedBy: "agent", parentTaskId: ctx.taskId, businessId: b.businessId, approvalId }, ctx.judge ?? realRulesJudge(caps));
      if (!r.ok) {
        decide(b.businessId, "refuse", `Did not hire a person: ${r.why}`, { subject: ctx.taskId });
        return `Error: ${r.why}`;
      }
      if (!approvalId) record(b.businessId, { kind: "hire", amountWei: wei, ref: r.task.taskId, jobRef: ctx.taskId, note: `A person: ${read.value.title.slice(0, 90)}` });
      decide(b.businessId, approvalId ? "ask" : "hire", approvalId ? `Asked your OK to hire a person for ${formatEth(wei)}: ${read.value.title}` : `Posted a task for people for ${formatEth(wei)}: ${read.value.title}`, { subject: ctx.taskId, detail: { peopleTask: r.task.taskId, receipt: `/r/${ctx.taskId}` } });
      ctx.say?.(approvalId ? "Asked the owner's OK to hire a person" : "Posted a task for a person");
      return approvalId
        ? `Asked your owner's OK to post "${read.value.title}" for ${formatEth(wei)}, above the amount they approve themselves. It goes on the board for people once they say yes. Finish this job with what you have and say so.`
        : `Posted "${read.value.title}" for people, paying ${formatEth(wei)} from your earnings, locked until a person's proof is accepted. Task ${r.task.taskId}. A person may take hours: finish this job with what you have and say you posted it.`;
    },
  };
}

export const canHirePeople = (t: ResolvedTools | null | undefined): boolean => Boolean(t?.localTools.some((x) => x.name === PEOPLE_TOOL));

/** The same tools with the people tool added, if it is not there already. */
export function withPeople(t: ResolvedTools | null | undefined, tool: LocalTool): ResolvedTools {
  const base: ResolvedTools = t ?? { serverTools: [], localTools: [], grants: [] };
  return canHirePeople(base) ? base : { ...base, localTools: [...base.localTools, tool], grants: [...base.grants, "people"] };
}
