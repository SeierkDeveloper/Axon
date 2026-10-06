import type React from "react";
import Link from "next/link";

// Lightweight markdown renderer for agent output — headings, bullets, numbered
// lists, code blocks, and inline bold/code. No dependency. Shared so every place an
// agent's result is shown (TestAgent, HirePanel, the /hire page) renders it the same
// way instead of dumping raw "**text**" markdown as plain text.

// Links, only where asked for (Mylo's answers) and only to Axon's own pages: a markdown link to a path, or a bare
// path to one of the site's sections. Anything pointing elsewhere stays plain text, so an answer can never send
// someone off the site.
const LINK = /(\[[^\]\n]+\]\(\/[^\s)]*\)|(?<![\w/.])\/(?:agents|studio|dashboard|burn|autonomy|docs|mylo|feed|analytics|launch|r)(?:\/[\w\-.%]+)*(?:\?[\w\-=&%.]+)?)/g;
const linkClass = "underline underline-offset-2 decoration-gray-300 hover:decoration-current dark:decoration-gray-600";

const SECTION = /^\/(?:agents|studio|dashboard|burn|autonomy|docs|mylo|feed|analytics|launch|r)(?:[/?]|$)/;

function renderLinks(text: string, key: string): React.ReactNode[] {
  return text.split(LINK).flatMap((part, i): React.ReactNode[] => {
    const md = part.match(/^\[([^\]\n]+)\]\((\/[^\s)]*)\)$/);
    if (md) return [<Link key={`${key}-${i}`} href={md[2]} className={linkClass}>{md[1]}</Link>];
    if (SECTION.test(part)) {
      // a sentence's full stop or comma after a path is the sentence's, not the link's
      const tail = part.match(/[.,]+$/)?.[0] ?? "";
      const href = part.slice(0, part.length - tail.length);
      return [<Link key={`${key}-${i}`} href={href} className={linkClass}>{href}</Link>, tail];
    }
    return [part];
  });
}

function renderInline(text: string, links = false): React.ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={i} className="font-semibold text-gray-900 dark:text-white">{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("`") && part.endsWith("`")) {
      return <code key={i} className="bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200 px-1 py-0.5 rounded text-xs font-mono">{part.slice(1, -1)}</code>;
    }
    return links ? renderLinks(part, String(i)) : part;
  });
}

export default function MarkdownOutput({ text, links = false }: { text: string; links?: boolean }) {
  const lines = text.split("\n");
  const elements: React.ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Code block
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      elements.push(
        <pre key={i} className="bg-gray-900 dark:bg-gray-800 text-gray-100 rounded-md p-3 text-xs overflow-x-auto my-3 font-mono">
          {lang && <div className="text-gray-500 text-[10px] mb-2 uppercase tracking-wider">{lang}</div>}
          <code>{codeLines.join("\n")}</code>
        </pre>
      );
      i++;
      continue;
    }

    // Headings
    if (line.startsWith("### ")) {
      elements.push(<h3 key={i} className="font-semibold text-gray-800 dark:text-gray-200 text-sm mt-4 mb-1">{renderInline(line.slice(4), links)}</h3>);
    } else if (line.startsWith("## ")) {
      elements.push(<h2 key={i} className="font-semibold text-gray-900 dark:text-white text-base mt-5 mb-1">{renderInline(line.slice(3), links)}</h2>);
    } else if (line.startsWith("# ")) {
      elements.push(<h1 key={i} className="font-bold text-gray-900 dark:text-white text-lg mt-5 mb-2">{renderInline(line.slice(2), links)}</h1>);
    }
    // Bullet
    else if (line.match(/^[-*] /)) {
      const items: string[] = [];
      // keyed by where the list starts: keyed by where it ends, it shared a key with the line after it, and a list
      // still being written was left on the page beside its finished self
      const start = i;
      while (i < lines.length && lines[i].match(/^[-*] /)) {
        items.push(lines[i].slice(2));
        i++;
      }
      elements.push(
        <ul key={`list-${start}`} className="list-disc space-y-0.5 my-2 pl-5 text-gray-700 marker:text-gray-400 dark:text-gray-300">
          {items.map((item, idx) => <li key={idx} className="text-sm">{renderInline(item, links)}</li>)}
        </ul>
      );
      continue;
    }
    // Numbered list item, rendered individually to preserve original numbers
    else if (line.match(/^\d+\. /)) {
      const num = line.match(/^(\d+)\. /)?.[1] ?? "1";
      const content = line.replace(/^\d+\. /, "");
      elements.push(
        <div key={i} className="flex gap-2 my-1">
          <span className="text-sm font-semibold text-gray-500 dark:text-gray-400 shrink-0 w-5 text-right">{num}.</span>
          <span className="text-sm text-gray-700 dark:text-gray-300">{renderInline(content, links)}</span>
        </div>
      );
    }
    // Blank line
    else if (line.trim() === "") {
      elements.push(<div key={i} className="h-2" />);
    }
    // Paragraph
    else {
      elements.push(<p key={i} className="text-sm text-gray-700 dark:text-gray-300 leading-relaxed">{renderInline(line, links)}</p>);
    }

    i++;
  }

  return <div>{elements}</div>;
}
