/**
 * UI strings, in English and Vietnamese.
 *
 * English is the default because most people reading this repo do not read
 * Vietnamese. Vietnamese stays first-class because the author uses the office
 * every day and the Vietnamese wording is the original — several labels are
 * deliberately plain-language ("Chờ bạn duyệt", not "waiting_permission") and
 * the English side keeps that intent rather than translating the enum.
 *
 * `t()` reads the language once per call and the app never re-renders on a
 * language change — switching reloads the page instead. That keeps every call
 * site a plain string with no subscription plumbing, which is worth more here
 * than live switching nobody does twice a session.
 */
import { en } from "./en";
import { vi } from "./vi";

export type Lang = "en" | "vi";
export type Key = keyof typeof en;

const STORAGE_KEY = "agent-office.lang";
const DICTS: Record<Lang, Record<string, string>> = { en, vi };

/**
 * Saved choice first, then the browser's languages **in preference order**.
 *
 * Order matters: `navigator.languages` is ranked, and a list like
 * ["en-US", "en-VN", "vi-VN"] belongs to someone in Vietnam who asked for
 * English. Matching "is Vietnamese anywhere in the list" would hand them
 * Vietnamese against their stated preference.
 */
export function detect(langs: readonly string[] = readNavigatorLangs()): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "en" || saved === "vi") return saved;
  } catch {
    // private mode / storage disabled — fall through to the browser's languages
  }
  for (const l of langs) {
    const tag = l?.toLowerCase() ?? "";
    if (tag.startsWith("vi")) return "vi";
    if (tag.startsWith("en")) return "en";
  }
  return "en";
}

function readNavigatorLangs(): readonly string[] {
  if (typeof navigator === "undefined") return [];
  return navigator.languages ?? (navigator.language ? [navigator.language] : []);
}

let current: Lang = detect();

export function getLang(): Lang {
  return current;
}

export function setLang(lang: Lang): void {
  current = lang;
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // not persisting is survivable; the session still switches
  }
}

/**
 * Look up `key`, substituting `{name}` placeholders from `vars`.
 *
 * A missing key falls back to English and then to the key itself, so a typo
 * shows up as a visible token in the UI rather than as an empty label.
 */
export function t(key: Key, vars?: Record<string, string | number>): string {
  const dict = DICTS[current] ?? en;
  let s = dict[key] ?? en[key] ?? String(key);
  if (vars) {
    for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  }
  return s;
}
