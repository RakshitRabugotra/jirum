import { markdownToAdf, adfToMarkdown } from "../src/util/adf.js";

const md = `# Problem

Users on **Safari 17** see a *blank* page after login. See ~~old note~~ and \`AuthProvider\`.

## Steps
1. Open https://app.example.com
2. Log in with SSO
   - nested bullet
3. Observe

> Quote with [a link](https://example.com)

\`\`\`ts
const x: number = 1;
\`\`\`

| Col A | Col B |
| --- | --- |
| 1 | two |

- [ ] AC one
- [x] AC two

---
Line one
Line two`;

const adf = markdownToAdf(md)!;
const types = adf.content.map((n) => n.type);
console.log("block types:", types.join(", "));
const back = adfToMarkdown(adf);
console.log("--- round trip ---\n" + back);
// Structural assertions
const assert = (cond: boolean, msg: string) => { if (!cond) { console.error("FAIL:", msg); process.exitCode = 1; } };
assert(types[0] === "heading" && adf.content[0]!.attrs?.level === 1, "h1");
const p = adf.content[1]!;
assert(p.type === "paragraph" && p.content!.some((n) => n.marks?.some((m) => m.type === "strong")), "strong mark");
assert(p.content!.some((n) => n.marks?.some((m) => m.type === "code")), "code mark");
assert(p.content!.some((n) => n.marks?.some((m) => m.type === "strike")), "strike mark");
const ol = adf.content.find((n) => n.type === "orderedList")!;
assert(ol.content!.length === 3, "3 ordered items");
assert(ol.content![1]!.content!.some((n) => n.type === "bulletList"), "nested bullet list inside item 2");
assert(ol.content!.every((li) => li.content![0]!.type === "paragraph"), "list items start with paragraph");
const bq = adf.content.find((n) => n.type === "blockquote")!;
assert(bq.content![0]!.content!.some((n) => n.marks?.some((m) => m.type === "link" && (m.attrs as {href:string}).href === "https://example.com")), "link in quote");
const cb = adf.content.find((n) => n.type === "codeBlock")!;
assert(cb.attrs?.language === "ts" && cb.content![0]!.text === "const x: number = 1;", "code block");
const tb = adf.content.find((n) => n.type === "table")!;
assert(tb.content!.length === 2 && tb.content![0]!.content![0]!.type === "tableHeader", "table header row");
assert(adf.content.some((n) => n.type === "rule"), "rule");
const last = adf.content[adf.content.length - 1]!;
assert(last.type === "paragraph" && last.content!.some((n) => n.type === "hardBreak"), "hard break in last paragraph");
assert(JSON.stringify(adf).includes('"text":"[ ] "') && back.includes("- [ ] AC one") && back.includes("- [x] AC two"), "task checkbox rendered as text");
console.log(process.exitCode ? "ADF CHECK FAILED" : "ADF CHECK OK");
