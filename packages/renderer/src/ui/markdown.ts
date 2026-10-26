// lane L7: a small, safe markdown renderer for the Documents tab, plus a CSV parser.
//
// Safe by construction: every piece of source text is HTML-escaped before any markup is added, and
// URLs are allow-listed (http/https/mailto for links, a caller-supplied resolver for relative links
// and images) — a `javascript:` or `data:` target never becomes an href/src. It covers what agents
// and people actually write in reports (headings, paragraphs, lists, quotes, code, tables, emphasis,
// links, images); anything else falls through as an escaped paragraph, never as raw HTML.

export interface MdBlock {
  index: number;
  /** Text of the nearest heading above (null before the first one) — the comment anchor. */
  heading: string | null;
  /** First ~120 characters of the block's own text — narrows a comment to one paragraph. */
  quote: string;
}

export interface MdOptions {
  /** Add a comment button to every block and heading. */
  commentable?: boolean;
  /** Map an image `src` from the document to a servable URL; null → the image is dropped. */
  resolveImage?: (src: string) => string | null;
  /** Map a relative link to a workspace document path; null → rendered as plain text. */
  resolveDocLink?: (href: string) => string | null;
  /** Label for the comment button (localised by the caller). */
  commentLabel?: string;
}

export interface MdResult {
  html: string;
  blocks: MdBlock[];
}

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const QUOTE_MAX = 120;

/** Inline markup: code spans, images, links, bold, italic, strikethrough — on already-plain text. */
export function renderInline(text: string, opts: MdOptions = {}): string {
  const stash: string[] = [];
  const hold = (html: string): string => `\u0000${stash.push(html) - 1}\u0000`;

  // code spans first so their contents are never touched by the rules below
  let s = text.replace(/`([^`]+)`/g, (_m, code: string) => hold(`<code>${esc(code)}</code>`));

  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_m, alt: string, src: string) => {
    const url = /^https?:\/\//i.test(src) ? src : opts.resolveImage?.(src) ?? null;
    return hold(url ? `<img src="${esc(url)}" alt="${esc(alt)}" loading="lazy">` : esc(alt));
  });

  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_m, label: string, href: string) => {
    if (/^(https?:\/\/|mailto:)/i.test(href)) {
      return hold(`<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`);
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return hold(esc(label)); // javascript:, data:, file: … — text only
    const doc = opts.resolveDocLink?.(href) ?? null;
    return hold(doc ? `<a href="#" data-doc-path="${esc(doc)}">${esc(label)}</a>` : esc(label));
  });

  s = esc(s)
    // the stash markers survive escaping (NUL is not an HTML special)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?!\w)/g, "$1<em>$2</em>")
    .replace(/(^|[^_\w])_([^_\s][^_]*)_(?!\w)/g, "$1<em>$2</em>")
    .replace(/~~([^~]+)~~/g, "<del>$1</del>");

  return s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => stash[Number(i)] ?? "");
}

/** Plain text of a markdown fragment, for headings' anchors and quotes. */
export function plainText(md: string): string {
  return md
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[`*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^(```|~~~)/;
const HR = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

export function renderMarkdown(src: string, opts: MdOptions = {}): MdResult {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MdBlock[] = [];
  const out: string[] = [];
  let heading: string | null = null;
  const label = esc(opts.commentLabel ?? "Comment");

  const wrap = (tag: string, inner: string, text: string, cls = ""): void => {
    const block: MdBlock = { index: blocks.length, heading, quote: plainText(text).slice(0, QUOTE_MAX) };
    blocks.push(block);
    const button = opts.commentable
      ? `<button type="button" class="md-cmt" data-n="0" aria-label="${label}" title="${label}">💬</button>`
      : "";
    out.push(`<${tag} class="md-block ${cls}" data-block="${block.index}">${button}${inner}</${tag}>`);
  };

  for (let i = 0; i < lines.length; ) {
    const line = lines[i]!;
    if (line.trim() === "") {
      i++;
      continue;
    }

    const fence = line.match(FENCE);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith(fence[1]!)) body.push(lines[i++]!);
      i++; // closing fence
      wrap("div", `<pre><code>${esc(body.join("\n"))}</code></pre>`, body.join(" "), "md-code");
      continue;
    }

    const h = line.match(HEADING);
    if (h) {
      const level = h[1]!.length;
      const text = plainText(h[2]!);
      heading = text;
      wrap(`h${level}`, renderInline(h[2]!, opts), text, "md-heading");
      i++;
      continue;
    }

    if (HR.test(line)) {
      out.push("<hr>");
      i++;
      continue;
    }

    if (line.startsWith(">")) {
      const body: string[] = [];
      while (i < lines.length && lines[i]!.startsWith(">")) body.push(lines[i++]!.replace(/^>\s?/, ""));
      wrap("blockquote", body.map((l) => renderInline(l, opts)).join("<br>"), body.join(" "));
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]!)) {
      const head = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.trim() !== "" && lines[i]!.includes("|")) rows.push(splitRow(lines[i++]!));
      const cell = (tag: string, c: string): string => `<${tag}>${renderInline(c, opts)}</${tag}>`;
      const html =
        `<div class="md-table-wrap"><table><thead><tr>${head.map((c) => cell("th", c)).join("")}</tr></thead>` +
        `<tbody>${rows.map((r) => `<tr>${r.map((c) => cell("td", c)).join("")}</tr>`).join("")}</tbody></table></div>`;
      wrap("div", html, [head, ...rows].flat().join(" "), "md-table");
      continue;
    }

    const item = line.match(LIST_ITEM);
    if (item) {
      const ordered = /\d/.test(item[2]!);
      const items: string[] = [];
      const texts: string[] = [];
      while (i < lines.length) {
        const m = lines[i]!.match(LIST_ITEM);
        if (!m) break;
        const depth = Math.min(3, Math.floor(m[1]!.replace(/\t/g, "  ").length / 2));
        items.push(`<li class="md-l${depth}">${renderInline(m[3]!, opts)}</li>`);
        texts.push(m[3]!);
        i++;
      }
      const tag = ordered ? "ol" : "ul";
      wrap("div", `<${tag}>${items.join("")}</${tag}>`, texts.join(" "), "md-list");
      continue;
    }

    // paragraph: consecutive plain lines
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() !== "" &&
      !FENCE.test(lines[i]!) &&
      !HEADING.test(lines[i]!) &&
      !lines[i]!.startsWith(">") &&
      !LIST_ITEM.test(lines[i]!) &&
      !HR.test(lines[i]!)
    ) {
      para.push(lines[i++]!);
    }
    wrap("p", para.map((l) => renderInline(l, opts)).join("<br>"), para.join(" "));
  }

  return { html: out.join("\n"), blocks };
}

/** Parse CSV (quotes, doubled quotes, embedded newlines); `;` is picked when the header has more of them. */
export function parseCsv(text: string, maxRows = 500, maxCols = 50): { rows: string[][]; truncated: boolean } {
  const first = text.split("\n", 1)[0] ?? "";
  const delimiter = (first.match(/;/g)?.length ?? 0) > (first.match(/,/g)?.length ?? 0) ? ";" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let truncated = false;

  const endRow = (): void => {
    row.push(field);
    field = "";
    if (row.length > 1 || row[0] !== "") {
      if (rows.length < maxRows) rows.push(row.slice(0, maxCols));
      else truncated = true;
    }
    row = [];
  };

  for (let i = 0; i < text.length && !truncated; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === delimiter) {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      endRow();
    } else field += c;
  }
  if (!truncated && (field !== "" || row.length > 0)) endRow();
  return { rows, truncated };
}
