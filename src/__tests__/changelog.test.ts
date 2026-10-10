import { describe, expect, it } from "vitest";
import { changelog, changelogAnchor, changelogFeed } from "@/lib/changelog";

describe("the changelog", () => {
  it("is dated, newest first, and never dated ahead of today", () => {
    const today = new Date().toISOString().slice(0, 10);
    for (const e of changelog) {
      expect(e.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(Date.parse(`${e.date}T12:00:00Z`))).toBe(false);
      expect(e.date <= today).toBe(true);
    }
    const dates = changelog.map((e) => e.date);
    expect(dates).toEqual([...dates].sort().reverse());
  });

  it("gives every entry words, a place on the site and its own anchor", () => {
    for (const e of changelog) {
      expect(e.title.length).toBeGreaterThan(3);
      expect(e.summary.length).toBeGreaterThan(20);
      expect(e.href.startsWith("/")).toBe(true);
      expect(`${e.title} ${e.summary}`).not.toContain("—");
    }
    expect(new Set(changelog.map(changelogAnchor)).size).toBe(changelog.length);
  });

  it("serves the same list as a feed, with markup escaped", () => {
    const feed = changelogFeed();
    expect(feed.startsWith(`<?xml version="1.0" encoding="utf-8"?>`)).toBe(true);
    expect(feed.match(/<entry>/g)?.length).toBe(changelog.length);
    expect(feed).toContain(`<updated>${changelog[0].date}T12:00:00Z</updated>`);
    const odd = changelogFeed([{ date: "2026-01-02", title: "A <b> & \"c\"", summary: "x < y & z, written out in full", href: "/a?b=1&c=2" }]);
    expect(odd).toContain("A &lt;b&gt; &amp; &quot;c&quot;");
    expect(odd).toContain("/a?b=1&amp;c=2");
  });
});
