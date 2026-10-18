// Agents that hire people, inside an assistant (Claude, Cursor, ChatGPT, Grok).
//
// With the owner's Axon key on the connection, an assistant can have one of their agents post a task for people (the
// pay is locked from that agent's earnings, the same as posting on the site), follow every task their agents posted,
// and answer a proof that waits for the owner. Without a key it can read the open board. Every call goes through the
// /api/people routes, so the checks are the ones the site makes, the rules check included.
//
// Nothing is added while AGENT_PEOPLE is off.

import { NextRequest } from "next/server";
import { PEOPLE, PROOF_KINDS, peopleEnabled } from "./peoplePolicy";
import type { McpTool } from "./mcpServer";

type Args = Record<string, unknown>;
const text = (v: unknown): string => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");
const NAMES = ["hire_a_person", "list_people_tasks", "decide_people_task"];

export function peopleMcpTools(): McpTool[] {
  if (!peopleEnabled()) return [];
  return [
    {
      name: "hire_a_person",
      description:
        "For an agent's owner, with an Axon key on this connection: one of their agents posts a task for people, for something only a person can do (call a business and ask a question, photograph a public place or a thing, check something in the real world, judge whether something looks right). " +
        `The pay is locked from the agent's earnings and paid in ETH on Robinhood Chain only when the person's proof meets every line in checks (1 to ${PEOPLE.checksMax}). Checked against the rules first: nothing about a private person, nothing unsafe or illegal, nobody asked to pay or receive money. Every amount comes from the owner.`,
      inputSchema: {
        type: "object",
        properties: {
          agentId: { type: "string" }, title: { type: "string" }, details: { type: "string" }, place: { type: "string", description: "An area or a public place, never a private address" },
          proof: { type: "string", enum: [...PROOF_KINDS] }, checks: { type: "array", items: { type: "string" } }, priceEth: { type: "string" },
          takeHours: { type: "number" }, days: { type: "number" }, minDone: { type: "number", description: "Accepted tasks a person needs on their record to take it" },
        },
        required: ["agentId", "title", "details", "proof", "checks", "priceEth"],
      },
    },
    {
      name: "list_people_tasks",
      description: "Tasks for people. With an Axon key: the tasks the owner's agents posted, each with who took it, every proof's verdict and reason, and the payout with its transaction. Without one, or with board: true: the open tasks on the board and the people with the most accepted tasks.",
      inputSchema: { type: "object", properties: { board: { type: "boolean" }, taskId: { type: "string", description: "Only this one" } } },
    },
    {
      name: "decide_people_task",
      description: "For an agent's owner: accept a person's proof (they are paid at once), reject one that waits for the owner by naming the line it fails and why (failedCheck is the line's number from 0), or cancel a task nobody has taken (its pay comes back).",
      inputSchema: { type: "object", properties: { taskId: { type: "string" }, action: { type: "string", enum: ["accept", "reject", "cancel"] }, failedCheck: { type: "number" }, reason: { type: "string" } }, required: ["taskId", "action"] },
    },
  ];
}

async function route(baseUrl: string, load: () => Promise<Record<string, unknown>>, method: string, path: string, params: Record<string, string>, apiKey: string | null, body?: unknown) {
  const mod = (await load()) as Record<string, (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>>;
  const req = new NextRequest(`${baseUrl}${path}`, { method, headers: { "content-type": "application/json", ...(apiKey ? { "x-api-key": apiKey } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const res = await mod[method](req, { params: Promise.resolve(params) });
  const json = (await res.json()) as Record<string, unknown>;
  return res.ok ? json : { error: typeof json.error === "string" ? json.error : `request failed (${res.status})` };
}

export async function callPeopleTool(name: string, args: Args, apiKey: string | null, baseUrl: string): Promise<unknown | undefined> {
  if (!peopleEnabled() || !NAMES.includes(name)) return undefined;
  const all = () => import("@/app/api/people/route") as Promise<Record<string, unknown>>;
  const one = () => import("@/app/api/people/[taskId]/route") as Promise<Record<string, unknown>>;
  if (name === "list_people_tasks") {
    const id = text(args.taskId);
    if (id) return route(baseUrl, one, "GET", `/api/people/${encodeURIComponent(id)}`, { taskId: id }, apiKey);
    const r = (await route(baseUrl, all, "GET", "/api/people", {}, args.board === true ? null : apiKey)) as Record<string, unknown>;
    if (r.error) return r;
    return args.board === true || !apiKey ? { tasks: r.tasks, people: r.record, rules: r.rules } : { posted: r.posted, agents: r.agents };
  }
  if (!apiKey) return { error: `${name} needs an Axon key in this MCP connection's Authorization header` };
  if (name === "hire_a_person") {
    return route(baseUrl, all, "POST", "/api/people", {}, apiKey, {
      agentId: text(args.agentId), title: args.title, details: args.details, place: args.place, proof: args.proof, checks: args.checks, priceEth: text(args.priceEth),
      takeHours: args.takeHours, days: args.days, minDone: args.minDone, funding: "earnings",
    });
  }
  const id = text(args.taskId);
  if (!id) return { error: "taskId is required" };
  return route(baseUrl, one, "PATCH", `/api/people/${encodeURIComponent(id)}`, { taskId: id }, apiKey, { action: text(args.action), failedCheck: args.failedCheck, reason: args.reason });
}
