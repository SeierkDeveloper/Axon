// Agents that build, phase 2: a built site as one document. A sealed page can load nothing, so its own style sheets,
// scripts and pictures are written into it; what is not one of its files is left for the seal to refuse.
import { describe, it, expect } from "vitest";
import { checkFiles, type SiteFile, type SiteFileIn } from "@/lib/agentSites";
import { bundle, pagesOf, resolve } from "@/lib/siteBundle";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(20, 7)]);
function site(files: SiteFileIn[]): SiteFile[] {
  const c = checkFiles(files);
  if (!c.ok) throw new Error(c.problems.join("; "));
  return c.files;
}

describe("a file named from a page", () => {
  it.each([
    ["index.html", "style.css", "style.css"], ["index.html", "./js/app.js", "js/app.js"], ["index.html", "/img/a.png", "img/a.png"],
    ["docs/guide.html", "../style.css", "style.css"], ["docs/guide.html", "pic.png", "docs/pic.png"], ["index.html", "app.js?v=2#x", "app.js"],
  ])("from %s, %s is %s", (from, ref, to) => { expect(resolve(from, ref)).toBe(to); });

  it.each(["https://cdn.example/a.js", "//cdn.example/a.js", "data:image/png;base64,AAAA", "mailto:a@b.c", "javascript:alert(1)", "../../up.css", "", "#top"])("%s is not a file of the site", (ref) => {
    expect(resolve("index.html", ref)).toBeNull();
  });
});

describe("making a page whole", () => {
  it("writes the page's own style sheet and script into it", () => {
    const out = bundle(site([
      { path: "index.html", content: '<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body><h1>Tips</h1><script src="app.js" defer></script></body></html>' },
      { path: "style.css", content: "h1{color:#111}" },
      { path: "app.js", content: 'document.title = "ready";' },
    ]))!;
    expect(out).toContain("<style>h1{color:#111}</style>");
    expect(out).toContain('<script defer>document.title = "ready";</script>');
    expect(out).not.toMatch(/href="style\.css"|src="app\.js"/);
    expect(out).toContain("<h1>Tips</h1>");
  });

  it("writes its pictures into it, wherever they are named: a tag, a style sheet, a style block, a style attribute, the icon", () => {
    const out = bundle(site([
      { path: "index.html", content: '<html><head><link rel="icon" href="img/logo.png"><link rel="stylesheet" href="css/main.css"><style>.a{background:url(img/logo.png)}</style></head><body><img src="img/logo.png" alt=""><div style="background-image:url(\'img/logo.png\')"></div><img src="art.svg"></body></html>' },
      { path: "css/main.css", content: ".b{background:url('../img/logo.png') no-repeat}" },
      { path: "img/logo.png", content: PNG },
      { path: "art.svg", content: "<svg xmlns='http://www.w3.org/2000/svg'><circle r='4'/></svg>" },
    ]))!;
    const data = `data:image/png;base64,${PNG.toString("base64")}`;
    expect(out.split(data).length - 1).toBe(5);
    expect(out).toContain("data:image/svg+xml;base64,");
    expect(out).not.toContain("img/logo.png");
  });

  it("leaves alone what is not one of the site's files, so the seal refuses it", () => {
    const html = '<html><head><link rel="stylesheet" href="https://cdn.example/a.css"><link rel="stylesheet" href="missing.css"></head><body><img src="https://example.com/a.png"><script src="//cdn.example/x.js"></script><script src="missing.js"></script><a href="about.html">About</a></body></html>';
    expect(bundle([{ path: "index.html", mime: "text/html", bytes: html.length, sha256: "x", content: Buffer.from(html) }])).toBe(html);
  });

  it("cannot be broken out of by what a file contains", () => {
    const out = bundle(site([
      { path: "index.html", content: '<html><head><link rel="stylesheet" href="s.css"></head><body><script src="a.js"></script><p id="after">after</p></body></html>' },
      { path: "s.css", content: "p{color:red}/* </style><h1>escaped</h1> */" },
      { path: "a.js", content: 'var s = "</script><h1>escaped</h1>"; // <!-- a comment' },
    ]))!;
    expect(out).not.toContain("</style><h1>escaped");
    expect(out).not.toContain("</script><h1>escaped");
    expect(out).toContain("<\\/script><h1>escaped</h1>");
    expect(out.match(/<\/script>/g)).toHaveLength(1);
    expect(out).toContain('<p id="after">after</p>');
  });

  it("does not take a text file for a script or a picture for a style sheet", () => {
    const out = bundle(site([
      { path: "index.html", content: '<html><head><link rel="stylesheet" href="logo.png"></head><body><script src="notes.txt"></script><img src="style.css"></body></html>' },
      { path: "logo.png", content: PNG }, { path: "notes.txt", content: "alert(1)" }, { path: "style.css", content: "a{}" },
    ]))!;
    expect(out).toContain('href="logo.png"');
    expect(out).toContain('<script src="notes.txt"></script>');
    expect(out).toContain('<img src="style.css">');
  });

  it("makes any page of the site whole, and has nothing for a page that is not there", () => {
    const files = site([
      { path: "index.html", content: '<a href="docs/guide.html">Guide</a>' },
      { path: "docs/guide.html", content: '<link rel="stylesheet" href="../style.css"><h1>Guide</h1>' },
      { path: "style.css", content: "h1{margin:0}" },
    ]);
    expect(bundle(files, "docs/guide.html")).toBe("<style>h1{margin:0}</style><h1>Guide</h1>");
    expect(bundle(files, "nope.html")).toBeNull();
    expect(bundle(files, "style.css")).toBeNull();
    expect(pagesOf(files)).toEqual(["index.html", "docs/guide.html"]);
  });
});
