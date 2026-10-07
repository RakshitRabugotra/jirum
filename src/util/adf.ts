/**
 * Markdown <-> Atlassian Document Format (ADF).
 *
 * markdownToAdf covers what Claude writes in practice: headings, paragraphs,
 * bullet/ordered lists (nested), fenced code blocks, block quotes, horizontal
 * rules, tables, bold/italic/strike/inline code/links, and hard line breaks.
 *
 * adfToMarkdown is the inverse for reading descriptions and comments; it is
 * lossy for exotic nodes (media, panels, mentions are rendered as plain text).
 */
import { marked, type Token, type Tokens } from "marked";

export type AdfNode = {
  type: string;
  attrs?: Record<string, unknown>;
  content?: AdfNode[];
  text?: string;
  marks?: AdfMark[];
};
export type AdfMark = { type: string; attrs?: Record<string, unknown> };
export interface AdfDoc {
  type: "doc";
  version: 1;
  content: AdfNode[];
}

export function markdownToAdf(markdown: string | undefined | null): AdfDoc | undefined {
  if (markdown === undefined || markdown === null) return undefined;
  const tokens = marked.lexer(markdown, { gfm: true });
  const content = blocks(tokens);
  return { type: "doc", version: 1, content: content.length ? content : [paragraph([])] };
}

export function plainTextToAdf(text: string): AdfDoc {
  return { type: "doc", version: 1, content: [paragraph([{ type: "text", text }])] };
}

function paragraph(content: AdfNode[]): AdfNode {
  return { type: "paragraph", content };
}

function blocks(tokens: Token[]): AdfNode[] {
  const out: AdfNode[] = [];
  for (const t of tokens) {
    switch (t.type) {
      case "heading": {
        const h = t as Tokens.Heading;
        out.push({ type: "heading", attrs: { level: Math.min(6, Math.max(1, h.depth)) }, content: inlines(h.tokens) });
        break;
      }
      case "paragraph": {
        const p = t as Tokens.Paragraph;
        const c = inlines(p.tokens);
        if (c.length) out.push(paragraph(c));
        break;
      }
      case "text": {
        // Loose text at block level (e.g. inside list items).
        const tt = t as Tokens.Text;
        const c = tt.tokens ? inlines(tt.tokens) : textNodes(tt.text, []);
        if (c.length) out.push(paragraph(c));
        break;
      }
      case "code": {
        const c = t as Tokens.Code;
        out.push({
          type: "codeBlock",
          attrs: c.lang ? { language: c.lang.trim().split(/\s+/)[0] } : {},
          content: c.text ? [{ type: "text", text: c.text }] : [],
        });
        break;
      }
      case "blockquote": {
        const b = t as Tokens.Blockquote;
        const inner = blocks(b.tokens).filter((n) => n.type === "paragraph" || n.type === "bulletList" || n.type === "orderedList");
        out.push({ type: "blockquote", content: inner.length ? inner : [paragraph([])] });
        break;
      }
      case "list": {
        const l = t as Tokens.List;
        const items = l.items.map((it) => listItem(it));
        if (l.ordered) {
          const start = typeof l.start === "number" ? l.start : 1;
          out.push({ type: "orderedList", attrs: start !== 1 ? { order: start } : {}, content: items });
        } else {
          out.push({ type: "bulletList", content: items });
        }
        break;
      }
      case "hr":
        out.push({ type: "rule" });
        break;
      case "table": {
        out.push(table(t as Tokens.Table));
        break;
      }
      case "html": {
        const text = (t as Tokens.HTML).text.trim();
        if (text) out.push(paragraph([{ type: "text", text }]));
        break;
      }
      case "space":
        break;
      default: {
        const raw = (t as { raw?: string }).raw?.trim();
        if (raw) out.push(paragraph([{ type: "text", text: raw }]));
      }
    }
  }
  return out;
}

function listItem(item: Tokens.ListItem): AdfNode {
  // marked emits a block-level "checkbox" token for task items; the prefix is added below instead.
  let content = blocks(item.tokens.filter((t) => t.type !== "checkbox"));
  if (item.task) {
    // ADF task lists need taskList/taskItem with localIds; render as text checkbox to keep it simple and valid.
    const box = item.checked ? "[x] " : "[ ] ";
    const first = content[0];
    if (first?.type === "paragraph") {
      first.content = [{ type: "text", text: box }, ...(first.content ?? [])];
    } else {
      content = [paragraph([{ type: "text", text: box.trim() }]), ...content];
    }
  }
  // listItem must start with a paragraph in ADF.
  if (!content.length || content[0]!.type !== "paragraph") content = [paragraph([]), ...content];
  return { type: "listItem", content };
}

function table(t: Tokens.Table): AdfNode {
  const headerRow: AdfNode = {
    type: "tableRow",
    content: t.header.map((cell) => ({ type: "tableHeader", attrs: {}, content: [paragraph(inlines(cell.tokens))] })),
  };
  const rows = t.rows.map((row) => ({
    type: "tableRow",
    content: row.map((cell) => ({ type: "tableCell", attrs: {}, content: [paragraph(inlines(cell.tokens))] })),
  }));
  return { type: "table", attrs: { isNumberColumnEnabled: false, layout: "default" }, content: [headerRow, ...rows] };
}

function inlines(tokens: Token[] | undefined, marks: AdfMark[] = []): AdfNode[] {
  if (!tokens) return [];
  const out: AdfNode[] = [];
  for (const t of tokens) {
    switch (t.type) {
      case "text": {
        const tt = t as Tokens.Text;
        if (tt.tokens && tt.tokens.length) out.push(...inlines(tt.tokens, marks));
        else out.push(...textNodes(tt.text, marks));
        break;
      }
      case "escape":
        out.push(...textNodes((t as Tokens.Escape).text, marks));
        break;
      case "strong":
        out.push(...inlines((t as Tokens.Strong).tokens, [...marks, { type: "strong" }]));
        break;
      case "em":
        out.push(...inlines((t as Tokens.Em).tokens, [...marks, { type: "em" }]));
        break;
      case "del":
        out.push(...inlines((t as Tokens.Del).tokens, [...marks, { type: "strike" }]));
        break;
      case "codespan": {
        // Code marks cannot combine with other formatting marks in ADF.
        out.push({ type: "text", text: unescapeHtml((t as Tokens.Codespan).text), marks: [{ type: "code" }] });
        break;
      }
      case "link": {
        const l = t as Tokens.Link;
        const href = l.href;
        const linkMark: AdfMark = { type: "link", attrs: { href } };
        const inner = inlines(l.tokens, [...marks, linkMark]);
        out.push(...(inner.length ? inner : textNodes(href, [...marks, linkMark])));
        break;
      }
      case "image": {
        const im = t as Tokens.Image;
        out.push(...textNodes(im.text || im.href, [...marks, { type: "link", attrs: { href: im.href } }]));
        break;
      }
      case "br":
        out.push({ type: "hardBreak" });
        break;
      case "html":
        out.push(...textNodes((t as Tokens.HTML).text, marks));
        break;
      default: {
        const raw = (t as { raw?: string }).raw;
        if (raw) out.push(...textNodes(raw, marks));
      }
    }
  }
  return out;
}

function textNodes(text: string, marks: AdfMark[]): AdfNode[] {
  const s = unescapeHtml(text);
  if (!s) return [];
  // Keep single newlines inside a paragraph as hard breaks.
  const parts = s.split("\n");
  const out: AdfNode[] = [];
  parts.forEach((p, i) => {
    if (p) out.push(marks.length ? { type: "text", text: p, marks } : { type: "text", text: p });
    if (i < parts.length - 1) out.push({ type: "hardBreak" });
  });
  return out;
}

function unescapeHtml(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/* ---------------------------------- ADF -> Markdown ---------------------------------- */

export function adfToMarkdown(doc: AdfNode | AdfDoc | string | null | undefined): string {
  if (!doc) return "";
  if (typeof doc === "string") return doc;
  return renderBlocks((doc as AdfNode).content ?? [], 0).trim();
}

function renderBlocks(nodes: AdfNode[], depth: number): string {
  return nodes.map((n) => renderBlock(n, depth)).filter((s) => s !== "").join("\n\n");
}

function renderBlock(n: AdfNode, depth: number): string {
  switch (n.type) {
    case "paragraph":
      return renderInlines(n.content ?? []);
    case "heading":
      return `${"#".repeat(Number(n.attrs?.level ?? 1))} ${renderInlines(n.content ?? [])}`;
    case "codeBlock":
      return `\`\`\`${String(n.attrs?.language ?? "")}\n${(n.content ?? []).map((c) => c.text ?? "").join("")}\n\`\`\``;
    case "blockquote":
      return renderBlocks(n.content ?? [], depth)
        .split("\n")
        .map((l) => `> ${l}`)
        .join("\n");
    case "bulletList":
      return (n.content ?? []).map((li) => renderListItem(li, "-", depth)).join("\n");
    case "orderedList": {
      const start = Number(n.attrs?.order ?? 1);
      return (n.content ?? []).map((li, i) => renderListItem(li, `${start + i}.`, depth)).join("\n");
    }
    case "taskList":
      return (n.content ?? [])
        .map((ti) => `${"  ".repeat(depth)}- [${ti.attrs?.state === "DONE" ? "x" : " "}] ${renderInlines(ti.content ?? [])}`)
        .join("\n");
    case "rule":
      return "---";
    case "table":
      return renderTable(n);
    case "panel":
      return renderBlocks(n.content ?? [], depth)
        .split("\n")
        .map((l) => `> ${l}`)
        .join("\n");
    case "expand":
    case "nestedExpand":
      return `**${String(n.attrs?.title ?? "Details")}**\n\n${renderBlocks(n.content ?? [], depth)}`;
    case "mediaSingle":
    case "mediaGroup":
      return (n.content ?? [])
        .map((m) => `[attachment: ${String(m.attrs?.alt ?? m.attrs?.id ?? "media")}]`)
        .join(" ");
    default:
      if (n.content) return renderBlocks(n.content, depth);
      return n.text ?? "";
  }
}

function renderListItem(li: AdfNode, bullet: string, depth: number): string {
  const indent = "  ".repeat(depth);
  const [first, ...rest] = li.content ?? [];
  const head = first ? renderBlock(first, depth) : "";
  const tail = rest.map((b) => renderBlock(b, depth + 1)).map((s) => s.split("\n").map((l) => (l ? `${indent}  ${l}` : l)).join("\n"));
  return [`${indent}${bullet} ${head}`, ...tail].join("\n");
}

function renderTable(n: AdfNode): string {
  const rows = (n.content ?? []).map((r) => (r.content ?? []).map((c) => renderBlocks(c.content ?? [], 0).replace(/\n+/g, " ").replace(/\|/g, "\\|")));
  if (!rows.length) return "";
  const width = Math.max(...rows.map((r) => r.length));
  const line = (cells: string[]) => `| ${Array.from({ length: width }, (_, i) => cells[i] ?? "").join(" | ")} |`;
  const [head, ...body] = rows;
  return [line(head!), `|${" --- |".repeat(width)}`, ...body.map(line)].join("\n");
}

function renderInlines(nodes: AdfNode[]): string {
  return nodes
    .map((n) => {
      switch (n.type) {
        case "text":
          return applyMarks(n.text ?? "", n.marks ?? []);
        case "hardBreak":
          return "\n";
        case "mention":
          return `@${String(n.attrs?.text ?? n.attrs?.id ?? "user").replace(/^@/, "")}`;
        case "emoji":
          return String(n.attrs?.text ?? n.attrs?.shortName ?? "");
        case "inlineCard":
          return String(n.attrs?.url ?? "");
        case "date":
          return n.attrs?.timestamp ? new Date(Number(n.attrs.timestamp)).toISOString().slice(0, 10) : "";
        case "status":
          return `[${String(n.attrs?.text ?? "")}]`;
        default:
          return n.content ? renderInlines(n.content) : (n.text ?? "");
      }
    })
    .join("");
}

function applyMarks(text: string, marks: AdfMark[]): string {
  let s = text;
  for (const m of marks) {
    switch (m.type) {
      case "code":
        s = `\`${s}\``;
        break;
      case "strong":
        s = `**${s}**`;
        break;
      case "em":
        s = `*${s}*`;
        break;
      case "strike":
        s = `~~${s}~~`;
        break;
      case "link":
        s = `[${s}](${String(m.attrs?.href ?? "")})`;
        break;
    }
  }
  return s;
}
