// Word, Excel and PowerPoint.
//
// The files people really work in. Each is a ZIP archive of XML parts. This module tells which of the three a file
// is and reads the words and numbers out of it, so every agent can read one, not only an agent with a sandbox. An
// agent that runs code is handed the file itself as well, opens it there with the usual libraries, and hands back a
// real Office file.
//
// Read from the bytes alone, like every other kind. A file that carries macros is not taken, and neither are the
// old binary formats (.doc, .xls, .ppt). Unpacking has a ceiling, so an archive built to blow up is turned away.
//
// Off until AGENT_OFFICE=on, and only while files are on.

import { looksZip, zipEntries, zipRead, type ZipEntry } from "./zip";

type Env = Record<string, string | undefined>;

export function officeEnabled(env: Env = process.env): boolean {
  return (env.AGENT_FILES ?? "off").trim().toLowerCase() === "on" && (env.AGENT_OFFICE ?? "off").trim().toLowerCase() === "on";
}

export type OfficeType = "docx" | "xlsx" | "pptx";
export const OFFICE: Record<OfficeType, { mime: string; label: string; main: string }> = {
  docx: { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", label: "Word document", main: "word/document.xml" },
  xlsx: { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", label: "Excel workbook", main: "xl/workbook.xml" },
  pptx: { mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", label: "PowerPoint presentation", main: "ppt/presentation.xml" },
};
export const officeTypeOf = (mime: string): OfficeType | null => (Object.keys(OFFICE) as OfficeType[]).find((t) => OFFICE[t].mime === mime) ?? null;

/** The most one XML part may unpack to, and the most that is unpacked from one file in all. */
const PART_MAX = 24 * 1024 * 1024, FILE_MAX = 64 * 1024 * 1024;

/** Which Office file these bytes are, or null: not one of the three, damaged, or carrying macros. */
export function officeType(bytes: Buffer): OfficeType | null {
  if (!looksZip(bytes)) return null;
  const entries = zipEntries(bytes);
  if (!entries || !entries.some((e) => e.name === "[Content_Types].xml")) return null;
  // macros are code that runs when the file is opened: such a file is not handed on to anybody
  if (entries.some((e) => /vbaProject\.bin$/i.test(e.name))) return null;
  return (Object.keys(OFFICE) as OfficeType[]).find((t) => entries.some((e) => e.name === OFFICE[t].main)) ?? null;
}

const unescape = (s: string): string => s
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
  .replace(/&amp;/g, "&");

/** Every piece of text inside elements of this name, in order: `<w:t>…</w:t>` for "w:t". */
function texts(xml: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g");
  for (let m = re.exec(xml); m; m = re.exec(xml)) out.push(unescape(m[1]));
  return out;
}
/** The blocks between an element's opening and closing tag: paragraphs, rows, cells. */
function blocks(xml: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g");
  for (let m = re.exec(xml); m; m = re.exec(xml)) out.push(m[1]);
  return out;
}

function reader(bytes: Buffer, entries: ZipEntry[]) {
  let spent = 0;
  return (name: string): string | null => {
    const part = zipRead(bytes, entries, name, Math.min(PART_MAX, FILE_MAX - spent));
    if (!part) return null;
    spent += part.length;
    return part.toString("utf8");
  };
}

// ── Word ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

function wordText(read: (n: string) => string | null): string | null {
  const xml = read("word/document.xml");
  if (xml === null) return null;
  const body = xml.slice(Math.max(0, xml.indexOf("<w:body")));
  const paragraph = (p: string): string => p.replace(/<w:tab\b[^>]*\/>/g, "<w:t>\t</w:t>").replace(/<w:br\b[^>]*\/>/g, "<w:t>\n</w:t>").match(/<w:t(?:\s[^>]*)?>[\s\S]*?<\/w:t>/g)?.map((t) => unescape(t.replace(/<[^>]+>/g, ""))).join("") ?? "";
  const out: string[] = [];
  // paragraphs and tables in the order they stand; a table is put down a row a line, its cells apart
  const re = /<w:tbl(?:\s[^>]*)?>[\s\S]*?<\/w:tbl>|<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g;
  for (let m = re.exec(body); m; m = re.exec(body)) {
    if (m[0].startsWith("<w:tbl")) {
      for (const row of blocks(m[0], "w:tr")) out.push(blocks(row, "w:tc").map((c) => blocks(c, "w:p").map(paragraph).join(" ").trim()).join(" | "));
      out.push("");
    } else {
      const heading = /<w:pStyle w:val="(?:Heading|Title)(\d?)/i.exec(m[0]);
      const line = paragraph(m[0]);
      out.push(heading && line.trim() ? `${"#".repeat(Math.min(6, Number(heading[1]) || 1))} ${line}` : line);
    }
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// ── Excel ────────────────────────────────────────────────────────────────────────────────────────────────────────────

const colOf = (ref: string): number => { let n = 0; for (const ch of ref.replace(/\d+/g, "")) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };
/** A number format that shows a date or a time: the built-in ones, or a custom one with day, month, year or hour marks. */
const isDateFormat = (id: number, custom: Map<number, string>): boolean => (id >= 14 && id <= 22) || (id >= 45 && id <= 47) || /[dmyh]/i.test((custom.get(id) ?? "").replace(/\[[^\]]*\]|"[^"]*"|\\./g, ""));
/** A day counted from 1900, as Excel keeps dates, as a date people read. */
function serialToDate(serial: number): string {
  const ms = Math.round((serial - 25569) * 86_400_000), d = new Date(ms);
  if (Number.isNaN(d.getTime())) return String(serial);
  const iso = d.toISOString();
  return serial % 1 === 0 ? iso.slice(0, 10) : serial < 1 ? iso.slice(11, 16) : `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

export const SHEET = { rows: 2_000, cols: 60 } as const;

function excelText(read: (n: string) => string | null): string | null {
  const book = read("xl/workbook.xml");
  if (book === null) return null;
  const strings = (read("xl/sharedStrings.xml") ?? "").match(/<si(?:\s[^>]*)?>[\s\S]*?<\/si>/g)?.map((si) => texts(si.replace(/<rPh[\s\S]*?<\/rPh>/g, ""), "t").join("")) ?? [];
  const styles = read("xl/styles.xml") ?? "";
  const custom = new Map<number, string>([...styles.matchAll(/<numFmt\b[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g)].map((m) => [Number(m[1]), unescape(m[2])]));
  const xfs = [...(/<cellXfs\b[\s\S]*?<\/cellXfs>/.exec(styles)?.[0] ?? "").matchAll(/<xf\b[^>]*?numFmtId="(\d+)"/g)].map((m) => Number(m[1]));
  const rels = new Map([...(read("xl/_rels/workbook.xml.rels") ?? "").matchAll(/<Relationship\b[^>]*?>/g)].map((m) => [/Id="([^"]+)"/.exec(m[0])?.[1] ?? "", /Target="([^"]+)"/.exec(m[0])?.[1] ?? ""]));
  const sheets = [...book.matchAll(/<sheet\b[^>]*?>/g)].map((m) => ({ name: unescape(/name="([^"]*)"/.exec(m[0])?.[1] ?? "Sheet"), rid: /r:id="([^"]+)"/.exec(m[0])?.[1] ?? "" }));
  const out: string[] = [];
  sheets.forEach((sheet, i) => {
    const target = rels.get(sheet.rid) ?? `worksheets/sheet${i + 1}.xml`;
    const xml = read(target.startsWith("/") ? target.slice(1) : `xl/${target}`);
    if (xml === null) return;
    const lines: string[] = [];
    let more = 0;
    for (const row of xml.match(/<row\b[^>]*>[\s\S]*?<\/row>/g) ?? []) {
      if (lines.length >= SHEET.rows) { more++; continue; }
      const cells: string[] = [];
      for (const c of row.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1], inner = c[2] ?? "", at = colOf(/r="([A-Z]+)\d+"/.exec(attrs)?.[1] ?? "");
        const col = at >= 0 ? at : cells.length;
        if (col >= SHEET.cols) continue;
        const type = /\bt="([^"]+)"/.exec(attrs)?.[1] ?? "n", raw = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? "";
        let value = "";
        if (type === "s") value = strings[Number(raw)] ?? "";
        else if (type === "inlineStr") value = texts(inner, "t").join("");
        else if (type === "b") value = raw === "1" ? "TRUE" : "FALSE";
        else if (type === "str" || type === "e") value = unescape(raw);
        else if (raw !== "") {
          const style = Number(/\bs="(\d+)"/.exec(attrs)?.[1] ?? -1), n = Number(raw);
          // a date is kept as a day count; a number as stored can carry a tail of float noise (98221.10000000001)
          value = !Number.isFinite(n) ? raw : style >= 0 && isDateFormat(xfs[style] ?? 0, custom) ? serialToDate(n) : String(parseFloat(n.toPrecision(15)));
        } else {
          // a formula nobody has worked out yet (the file was written by a program, not saved from Excel)
          const formula = /<f(?:\s[^>]*)?>([\s\S]*?)<\/f>/.exec(inner)?.[1];
          if (formula) value = `=${unescape(formula)}`;
        }
        while (cells.length < col) cells.push("");
        cells[col] = /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
      }
      if (cells.some((v) => v !== "")) lines.push(cells.join(","));
    }
    out.push(`Sheet "${sheet.name}"${lines.length ? "" : " (empty)"}:\n${lines.join("\n")}${more ? `\n[${more} more rows are left out here.]` : ""}`);
  });
  return out.join("\n\n").trim();
}

// ── PowerPoint ───────────────────────────────────────────────────────────────────────────────────────────────────────

function slidesText(read: (n: string) => string | null, entries: ZipEntry[]): string | null {
  const deck = read("ppt/presentation.xml");
  if (deck === null) return null;
  const relsOf = (xml: string | null): Map<string, string> =>
    new Map([...(xml ?? "").matchAll(/<Relationship\b[^>]*?>/g)].map((m) => [/Id="([^"]+)"/.exec(m[0])?.[1] ?? "", /Target="([^"]+)"/.exec(m[0])?.[1] ?? ""]));
  // the slides in the order the deck shows them, which is not always the order of their file names
  const deckRels = relsOf(read("ppt/_rels/presentation.xml.rels"));
  let files = [...deck.matchAll(/<p:sldId\b[^>]*?r:id="([^"]+)"/g)].map((m) => deckRels.get(m[1]) ?? "").filter(Boolean).map((t) => (t.startsWith("/") ? t.slice(1) : `ppt/${t}`));
  if (!files.length) {
    files = entries.map((e) => /^ppt\/slides\/slide(\d+)\.xml$/.exec(e.name)).filter((m): m is RegExpExecArray => Boolean(m)).sort((a, b) => Number(a[1]) - Number(b[1])).map((m) => m[0]);
  }
  const paragraphs = (xml: string): string[] => blocks(xml, "a:p").map((p) => texts(p, "a:t").join("")).map((t) => t.trim()).filter(Boolean);
  const out: string[] = [];
  files.forEach((file, i) => {
    const xml = read(file);
    if (xml === null) return;
    // a slide's notes are whichever notes part the slide itself points to
    const name = file.split("/").pop() ?? "";
    const notesAt = [...relsOf(read(`ppt/slides/_rels/${name}.rels`)).values()].find((t) => /notesSlide\d+\.xml$/.test(t));
    const notes = notesAt ? read(`ppt/notesSlides/${notesAt.split("/").pop()}`) : null;
    const said = notes ? paragraphs(notes).filter((t) => !/^\d+$/.test(t)) : [];
    out.push(`Slide ${i + 1}:\n${paragraphs(xml).map((t) => `- ${t}`).join("\n") || "(no text)"}${said.length ? `\nSpeaker notes: ${said.join(" ")}` : ""}`);
  });
  return out.join("\n\n").trim();
}

/**
 * The words and numbers in an Office file, as text an agent can read: a document's paragraphs and tables, a
 * workbook's sheets as rows of values, a presentation's slides. Null when the file cannot be read.
 */
export function officeText(bytes: Buffer, type: OfficeType): string | null {
  const entries = zipEntries(bytes);
  if (!entries) return null;
  const read = reader(bytes, entries);
  try {
    return type === "docx" ? wordText(read) : type === "xlsx" ? excelText(read) : slidesText(read, entries);
  } catch {
    return null;
  }
}

/** A hire that asks for a Word, Excel or PowerPoint file by its own words. */
const ASKS = /\b(?:word (?:doc(?:ument)?|file)|\.?docx|\.?xlsx|spreadsheet|workbook|power ?point|\.?pptx|slide ?deck|slides|presentation)\b/i;
// "Excel" the program, not "excel" the verb: written with its capital, or said in a way only the program is
const EXCEL = /\bExcel\b|\b(?:in|into|an|as an?) excel\b|\bexcel (?:sheet|file|workbook|table|spreadsheet)\b/;
export const wantsOffice = (job: string): boolean => ASKS.test(job) || EXCEL.test(job) || EXCEL.test(job.toLowerCase());

/**
 * How much an agent may write in one turn on an Office job. The code that builds a document, a workbook or a deck is
 * far longer than an answer in words: at an agent's usual ceiling it is cut off half way through, and the job fails
 * with nothing made. A ceiling, not a spend: a turn costs what it writes.
 */
export const OFFICE_MAX_TOKENS = 8_000;

/** What an agent with a sandbox is told when Office files are in play. */
export const OFFICE_NOTE = "\n\nWord, Excel and PowerPoint files are real files in your sandbox. Open and save them there with python-docx, openpyxl and python-pptx. When the person wants a document, a workbook or a deck, make that file, keep its formatting where you change an existing one, and save it in the output directory.";
