// An agent's answer often carries a table, a quote or a line across. They are shown as what they are, not as the
// bars and dashes they are written with.
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import MarkdownOutput, { cellsOf } from "@/components/MarkdownOutput";

const html = (text: string) => renderToStaticMarkup(<MarkdownOutput text={text} />);

describe("tables in answers", () => {
  it("shows a table as a table, with bold and code inside its cells", () => {
    const out = html("What changed:\n\n| Element | Night | Storm |\n|---|:---:|---:|\n| **Sky** | Calm | `charcoal` |\n| Rain | None | Diagonal |\n\nDone.");
    expect(out).toContain("<table");
    expect(out.match(/<th /g)).toHaveLength(3);
    expect(out.match(/<tr/g)).toHaveLength(3);
    expect(out).toContain("<strong");
    expect(out).toContain(">charcoal</code>");
    expect(out).not.toContain("|");
    expect(out).not.toContain("---");
    expect(out).toContain("What changed:");
    expect(out).toContain("Done.");
    // a wide table scrolls inside its own box
    expect(out).toContain("overflow-x-auto");
  });

  it("keeps a bar that is part of a cell, and fills a short row", () => {
    expect(cellsOf("| `a | b` | c \\| d | e |")).toEqual(["`a | b`", "c | d", "e"]);
    const out = html("| A | B | C |\n|---|---|---|\n| 1 | 2 |");
    expect(out.match(/<td /g)).toHaveLength(3);
  });

  it("leaves a line with bars that is no table as it was written", () => {
    expect(html("| just one line |")).not.toContain("<table");
    expect(html("a | b\n---")).not.toContain("<table");
    expect(html("| A | B |\n| 1 | 2 |")).not.toContain("<table");
  });

  it("a table still being written shows what is there so far", () => {
    expect(html("| A | B |\n|---|---|")).toContain("<thead");
    expect(html("| A | B |\n|---|---|\n| 1 |")).toContain(">1</td>");
  });
});

describe("quotes and lines across", () => {
  it("shows a quote as a quote and a line of dashes as a line", () => {
    const out = html("Spanish:\n\n> \"Gracias por tu pedido.\"\n> Second line.\n\n---\n\nNotes.");
    expect(out).toContain("<blockquote");
    expect(out).toContain("Second line.");
    expect(out).not.toContain("&gt;");
    expect(out).toContain("<hr");
    expect(out).not.toContain("---");
  });

  it("does not mistake a list for a line", () => {
    const out = html("- one\n- two");
    expect(out).toContain("<ul");
    expect(out).not.toContain("<hr");
  });
});
