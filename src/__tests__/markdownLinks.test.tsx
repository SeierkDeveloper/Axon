// Mylo's answers link to Axon's own pages, and only those; an agent's output shown elsewhere stays plain text.
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import MarkdownOutput from "@/components/MarkdownOutput";

describe("links in answers", () => {
  it("links markdown links and bare section paths to Axon's own pages, keeping a sentence's full stop outside", () => {
    const html = renderToStaticMarkup(<MarkdownOutput links text={"Ask me, or [open it in Studio](/studio?build=1f0). Live at /agents/notes-3. See /burn, or /etc/passwd."} />);
    expect(html).toContain('<a class="underline');
    expect(html).toContain('href="/studio?build=1f0"');
    expect(html).toContain(">open it in Studio</a>");
    expect(html).toContain('href="/agents/notes-3">/agents/notes-3</a>.');
    expect(html).toContain('href="/burn">/burn</a>,');
    expect(html).not.toContain('href="/etc');
  });

  it("never links anywhere else, and links nothing unless asked", () => {
    const outside = renderToStaticMarkup(<MarkdownOutput links text={"[claim your prize](https://evil.example) and [x](javascript:alert(1))"} />);
    expect(outside).not.toContain("<a ");
    expect(renderToStaticMarkup(<MarkdownOutput text={"[open](/studio) and /agents/x"} />)).not.toContain("<a ");
  });
});
