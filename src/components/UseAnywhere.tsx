"use client";

import { useState, useSyncExternalStore } from "react";

// "Use it anywhere": one agent's own link, set up for each assistant. Claude Code, Claude Desktop and Cursor speak MCP
// and add /mcp/agents/:id as a server whose one tool is this agent; ChatGPT, Grok and anything else with function
// calling read the same tool from /api/tools?agent=:id. Copy, paste, done.

const noop = () => () => {};

type Client = "claude-code" | "claude" | "cursor" | "functions";
const TABS: { key: Client; label: string }[] = [
  { key: "claude-code", label: "Claude Code" },
  { key: "claude", label: "Claude Desktop" },
  { key: "cursor", label: "Cursor" },
  { key: "functions", label: "ChatGPT · Grok" },
];

export default function UseAnywhere({ agentId, name, compact = false }: { agentId: string; name: string; compact?: boolean }) {
  const [tab, setTab] = useState<Client>("claude-code");
  const [copied, setCopied] = useState(false);
  // the link points at the site you are on, so the private site's panel points at the private site; the server, and
  // the first render in the browser, use the public address so the two match
  const origin = useSyncExternalStore(noop, () => window.location.origin, () => "https://axon-agents.com");

  const key = `axon-${agentId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 58)}`;
  const mcp = `${origin}/mcp/agents/${agentId}`;
  const snippet: Record<Client, { file: string; text: string }> = {
    "claude-code": { file: "in your terminal", text: `claude mcp add --transport http ${key} ${mcp}` },
    claude: { file: "claude_desktop_config.json", text: JSON.stringify({ mcpServers: { [key]: { command: "npx", args: ["-y", "mcp-remote", mcp] } } }, null, 2) },
    cursor: { file: "~/.cursor/mcp.json", text: JSON.stringify({ mcpServers: { [key]: { url: mcp } } }, null, 2) },
    functions: { file: "your app", text: `# the tool, in OpenAI's shape (Grok takes the same)\nGET  ${origin}/api/tools?agent=${agentId}&format=openai\n\n# when the model calls it\nPOST ${origin}/api/tools/call?agent=${agentId}\n{ "name": "<tool name>", "arguments": { "task": "..." } }` },
  };
  const s = snippet[tab];
  const copy = async () => {
    try { await navigator.clipboard.writeText(s.text); setCopied(true); setTimeout(() => setCopied(false), 1_500); } catch { /* the text is selectable all the same */ }
  };

  return (
    <div className={`rounded-2xl border border-gray-200 bg-white/80 backdrop-blur dark:border-gray-800 dark:bg-gray-950/70 ${compact ? "p-4" : "p-5"}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-semibold text-gray-900 dark:text-white">Use {name} anywhere</p>
        <p className="text-xs text-gray-400">It becomes a tool in your assistant. Paid tasks pay as they do here.</p>
      </div>
      <div className="mt-3 flex flex-wrap gap-1" role="tablist">
        {TABS.map((t) => (
          <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)}
            className={`rounded-full px-3 py-1 text-xs transition ${tab === t.key ? "bg-gray-900 text-white dark:bg-white dark:text-gray-900" : "text-gray-500 hover:text-gray-900 dark:hover:text-white"}`}>
            {t.label}
          </button>
        ))}
      </div>
      <div className="mt-3 overflow-hidden rounded-xl border border-gray-900 bg-gray-950 dark:border-gray-800">
        <div className="flex items-center justify-between border-b border-white/10 px-4 py-2">
          <p className="font-mono text-[11px] text-gray-400">{s.file}</p>
          <button type="button" onClick={() => void copy()} className="rounded-md bg-white/10 px-2.5 py-1 text-xs text-white transition hover:bg-white/20">{copied ? "Copied" : "Copy"}</button>
        </div>
        <pre className="overflow-x-auto p-4 font-mono text-xs leading-relaxed text-gray-100">{s.text}</pre>
      </div>
    </div>
  );
}
