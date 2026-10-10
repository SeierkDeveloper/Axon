// Work with your agent: starter jobs.
//
// Somebody who lands on an agent's page often does not know what to ask. A starter is a job this agent is good at,
// written out: one tap puts it in the box (and attaches the sample file it works on, where it has one), and the
// person hires as they would with words of their own. A starter is only ever a suggestion: it changes nothing
// about the hire, its price or its receipt.
//
// Which starters an agent is offered follows from what it lists as its abilities and from what it can do here
// (read files, run code, make pictures, make Office files). Off until AGENT_STARTERS=on.

import type { Agent } from "@/sdk/types";

type Env = Record<string, string | undefined>;

export function startersEnabled(env: Env = process.env): boolean {
  return (env.AGENT_STARTERS ?? "off").trim().toLowerCase() === "on";
}

/** What the agent can do on this server, beyond answering in words. */
export interface StarterAbilities { files?: boolean; code?: boolean; pictures?: boolean; office?: boolean }

/** A sample file a starter attaches: served from /starters, uploaded like any file the person picks. */
export interface StarterSample { name: string; path: string; type: string }

export interface StarterJob {
  id: string;
  /** what the button says */
  label: string;
  /** what goes in the box */
  task: string;
  sample?: StarterSample;
}

const SALES: StarterSample = { name: "sales.csv", path: "/starters/sales.csv", type: "text/csv" };
const AGREEMENT: StarterSample = { name: "service-agreement.txt", path: "/starters/service-agreement.txt", type: "text/plain" };

interface Entry extends StarterJob {
  /** offered to an agent that lists an ability this fits. Each ability is looked at on its own, so a plain word
   *  like "writing" can be asked for whole and does not catch "SQL query writing" */
  when: RegExp;
  /** and only where the agent can do this */
  needs?: (keyof StarterAbilities)[];
}

// The more particular a starter is, the earlier it stands: an agent is offered the first few that fit it.
const ALL: Entry[] = [
  { id: "contract-review", label: "Review a contract", when: /contract|legal|compliance|clause|risk assess/i, needs: ["files"], sample: AGREEMENT,
    task: "Review the attached service agreement from the client's side. List the five clauses that put the client at most risk, say why in one line each, and suggest fairer wording for the worst one." },
  { id: "sql-schema", label: "Design a database", when: /sql|schema|database|data modell/i,
    task: "Design a small database for an online shop: customers, products, orders and order lines. Give the tables with their columns and keys, then one query for revenue per month." },
  { id: "translate", label: "Translate a message", when: /translat|localis|localiz|multilingual/i,
    task: "Translate this into Spanish and German and keep the friendly tone: \"Thanks for your order. It ships tomorrow and you will get a tracking link by email.\"" },
  { id: "plan-week", label: "Plan a week", when: /calendar|schedul|meeting|deadline|time zone/i,
    task: "Plan my work week. I have a product demo on Wednesday at 15:00, a report due Friday at noon that needs six hours, three one-hour customer calls to place, and I do not work after 17:00. Give me a day by day plan." },
  { id: "audit", label: "Check a contract for bugs", when: /audit|security|smart.contract/i,
    task: "Check this Solidity function for bugs and say how to fix each one:\n\nfunction withdraw(uint256 amount) external {\n    require(balances[msg.sender] >= amount);\n    (bool ok, ) = msg.sender.call{value: amount}(\"\");\n    require(ok);\n    balances[msg.sender] -= amount;\n}" },
  { id: "release-notes", label: "Write release notes", when: /changelog|release/i,
    task: "Turn these commits into short release notes a customer would read:\n- fix: checkout button stuck on slow connections\n- feat: export invoices as PDF\n- perf: dashboard loads 40% faster\n- chore: bump dependencies\n- fix: wrong time zone on scheduled reports" },
  { id: "reply", label: "Draft a reply", when: /reply|email|inbox|customer.facing|tone match/i,
    task: "Draft a short, calm reply to this customer: \"I was charged twice for my order this month and nobody has answered my two emails. I want my money back today.\" We will refund the second charge within 3 working days." },
  { id: "picture", label: "Make a picture", when: /image generation|picture|illustrat/i, needs: ["pictures"],
    task: "Make a picture: a small lighthouse on a cliff at dusk, in a flat illustration style with a limited palette." },
  { id: "chart", label: "Chart a spreadsheet", when: /^(analysis|research|trading)$|data|sql|report/i, needs: ["files", "code"], sample: SALES,
    task: "Chart revenue per month for each region from the attached spreadsheet, and tell me the three things that stand out." },
  { id: "excel", label: "Make an Excel file", when: /^(analysis|planning)$|data|report|financ/i, needs: ["code", "office"],
    task: "Make an Excel file with a simple monthly budget for a three-person team: salaries, tools, travel and a total for each month of next year, with the totals as formulas." },
  { id: "word", label: "Write a Word brief", when: /^(writing|documents?|editing|summari[sz]ation)$|copywrit/i, needs: ["code", "office"],
    task: "Write a one-page project brief as a Word file for moving a small company's website to a new host: goal, steps, risks and a timeline." },
  { id: "explain", label: "Explain a topic", when: /^(research|summari[sz]ation|search|analysis|crypto|blockchain|trading)$/i,
    task: "Explain how an on-chain escrow works in five short points, for somebody new to it, and name one thing that can go wrong." },
  { id: "compare", label: "Compare two options", when: /^(research|analysis|planning)$|prioriti/i,
    task: "Compare hiring a freelancer with hiring an agency for building a small company website. Give a short table (cost, speed, risk, upkeep) and say which you would pick for a team of five." },
  { id: "post", label: "Write a launch post", when: /^(writing|social|creative)$|copywrit/i,
    task: "Write a short launch post for a note-taking app that works without internet. Three sentences, plain words, no hashtags." },
  { id: "code", label: "Write a function", when: /^(code|coding|programming)$|develop/i,
    task: "Write a TypeScript function that takes a list of orders (id, customer, total, date) and returns the three customers who spent the most in the last 30 days. Add two short tests." },
  { id: "tighten", label: "Tighten a paragraph", when: /^(editing|formatting|writing|clear|short)$/i,
    task: "Make this shorter and clearer without losing anything that matters: \"In order to be able to make sure that all of our customers are able to get the help that they need in a timely manner, we have made the decision to extend the hours during which our support team is available.\"" },
];

/** Offered to an agent nothing above fits: it is asked to show what it does. */
const SHOW: StarterJob = { id: "show", label: "Show me what you do", task: "Show me what you are best at with one short, concrete example, then tell me what to ask you next." };

export const STARTERS = { most: 4 } as const;

/** The starter jobs for an agent, the best fit first. Empty while starters are off. */
export function startersFor(agent: Pick<Agent, "capabilities">, can: StarterAbilities = {}, env: Env = process.env): StarterJob[] {
  if (!startersEnabled(env)) return [];
  const lists = (agent.capabilities ?? []).map((c) => c.trim());
  const fit = ALL.filter((e) => lists.some((c) => e.when.test(c)) && (e.needs ?? []).every((n) => can[n]));
  const out: StarterJob[] = fit.slice(0, STARTERS.most).map(({ id, label, task, sample }) => ({ id, label, task, ...(sample ? { sample } : {}) }));
  return out.length ? out : [SHOW];
}
