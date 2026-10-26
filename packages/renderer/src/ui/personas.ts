// lane L6: persona cards and the SOP view, shared by the Hiring Hall (the applied roster)
// and the Templates panel (a template before it is applied).
//
// Everything that originates in a roster or an SOP file is escaped before it becomes HTML.
// `avatar` is only a slug in a data attribute here: lane L8 maps it to a drawn character.

import { t } from "../i18n";

export interface Persona {
  name: string | null;
  role: string | null;
  avatar: string | null;
  voice: string | null;
  tone: string | null;
  prompt?: string | null;
  promptFile?: string | null;
}

export interface Sop {
  title: string;
  role: string | null;
  inputs: string[];
  steps: string[];
  done: string[];
  handoff: { to: string; what: string }[];
  escalate: string[];
  body: string;
}

export interface SopPayload {
  member: string;
  path: string;
  sop: Sop;
  problems: string[];
}

/** The members of a roster that carry a persona (a subset of RosterMember). */
export interface PersonaMember {
  name: string;
  role?: string | null;
  persona?: Persona | null;
  sop?: string | null;
}

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Stable 0-359 hue from a slug, so each avatar slug gets its own color until L8 draws the real thing. */
function hueOf(slug: string): number {
  let h = 0;
  for (const ch of slug) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

/** One persona card. Empty string for a member without a persona. */
export function personaCardHtml(member: PersonaMember): string {
  const p = member.persona;
  if (!p) return "";
  const shown = p.name ?? member.name;
  const avatar = p.avatar ?? "default";
  const sopButton = member.sop
    ? `<button type="button" class="persona-sop" data-sop="${esc(member.name)}">${t("persona.viewSop")}</button>`
    : "";
  const line = (label: string, value: string | null): string =>
    value ? `<div class="persona-line"><span>${label}</span> ${esc(value)}</div>` : "";
  return `<div class="persona-card">
    <span class="persona-avatar" data-avatar="${esc(avatar)}" style="--hue:${hueOf(avatar)}" aria-hidden="true">${esc(shown.slice(0, 1).toUpperCase())}</span>
    <div class="persona-body">
      <div class="persona-head"><strong>${esc(shown)}</strong>${p.role ? ` · ${esc(p.role)}` : ""}</div>
      ${line(t("persona.voice"), p.voice)}${line(t("persona.tone"), p.tone)}
    </div>
    ${sopButton}
  </div>`;
}

/** "9 personas · 11 SOPs", or null when the template ships none. */
export function personaMeta(tpl: { personaCount?: number; sopCount?: number }): string | null {
  const personas = tpl.personaCount ?? 0;
  const sops = tpl.sopCount ?? 0;
  if (personas === 0 && sops === 0) return null;
  return t("templates.personaMeta", { personas, sops });
}

const inline = (escaped: string): string =>
  escaped.replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");

/**
 * Just enough markdown for an SOP's notes: headings, bullet lists, fenced code, pipe tables, paragraphs,
 * **bold** and `code`. Input is escaped first, so raw HTML in a file can never reach the DOM.
 * ponytail: L7's document viewer is the full renderer; this exists so a panel can show a procedure today.
 */
export function mdToHtml(md: string): string {
  const out: string[] = [];
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;

    if (line.startsWith("```")) {
      const code: string[] = [];
      for (i++; i < lines.length && !lines[i].startsWith("```"); i++) code.push(lines[i]);
      out.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`);
      continue;
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      out.push(`<h4>${inline(esc(heading[1]))}</h4>`);
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      for (; i < lines.length && /^\s*[-*]\s+/.test(lines[i]); i++) {
        items.push(`<li>${inline(esc(lines[i].replace(/^\s*[-*]\s+/, "")))}</li>`);
      }
      i--;
      out.push(`<ul>${items.join("")}</ul>`);
      continue;
    }
    if (line.trim().startsWith("|") && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? "")) {
      const cells = (row: string): string[] => row.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const head = cells(line).map((c) => `<th>${inline(esc(c))}</th>`).join("");
      const rows: string[] = [];
      for (i += 2; i < lines.length && lines[i].trim().startsWith("|"); i++) {
        rows.push(`<tr>${cells(lines[i]).map((c) => `<td>${inline(esc(c))}</td>`).join("")}</tr>`);
      }
      i--;
      out.push(`<table class="sop-table"><tr>${head}</tr>${rows.join("")}</table>`);
      continue;
    }
    const para: string[] = [];
    for (; i < lines.length && lines[i].trim() !== "" && !/^(#|```|\s*[-*]\s|\|)/.test(lines[i]); i++) para.push(lines[i]);
    i--;
    out.push(`<p>${inline(esc(para.join(" ")))}</p>`);
  }
  return out.join("\n");
}

const list = (tag: "ul" | "ol", items: string[]): string =>
  `<${tag}>${items.map((i) => `<li>${inline(esc(i))}</li>`).join("")}</${tag}>`;

/** The whole SOP: its five sections, then the free-form notes. */
export function sopHtml(sop: Sop): string {
  const section = (title: string, body: string): string => `<section class="sop-section"><h4>${title}</h4>${body}</section>`;
  const handoff = list("ul", sop.handoff.map((h) => `${h.to}: ${h.what}`));
  const done = `<ul class="sop-done">${sop.done.map((d) => `<li>${inline(esc(d))}</li>`).join("")}</ul>`;
  return `<div class="sop">
    <h3>${esc(sop.title)}</h3>
    ${sop.role ? `<p class="sop-role">${esc(sop.role)}</p>` : ""}
    ${section(t("sop.inputs"), list("ul", sop.inputs))}
    ${section(t("sop.steps"), list("ol", sop.steps))}
    ${section(t("sop.done"), done)}
    ${section(t("sop.handoff"), handoff)}
    ${section(t("sop.escalate"), list("ul", sop.escalate))}
    ${sop.body ? `<section class="sop-section sop-notes">${mdToHtml(sop.body)}</section>` : ""}
  </div>`;
}

/** GET /sop for a member of the company roster (`name` null) or of a template / project. */
export async function fetchSop(source: "company" | "template" | "project", name: string | null, member: string): Promise<SopPayload> {
  const q = new URLSearchParams({ source, member });
  if (name) q.set("name", name);
  const res = await fetch(`/sop?${q}`);
  const body = (await res.json().catch(() => null)) as (SopPayload & { error?: string }) | null;
  if (!res.ok || !body) throw new Error(body?.error ?? `HTTP ${res.status}`);
  return body;
}

/** Fill `box` with the SOP `load` resolves to (loading → content, or the error), with a close button. */
export function showSop(box: HTMLElement, load: () => Promise<SopPayload>): void {
  box.hidden = false;
  box.innerHTML = `<p class="placeholder">${t("sop.loading")}</p>`;
  load()
    .then((payload) => {
      box.innerHTML = `<button type="button" class="sop-close">${t("sop.close")}</button>${sopHtml(payload.sop)}`;
      box.querySelector(".sop-close")?.addEventListener("click", () => {
        box.hidden = true;
        box.replaceChildren();
      });
    })
    .catch((error: unknown) => {
      box.textContent = t("sop.failed", { error: error instanceof Error ? error.message : String(error) });
    });
}
