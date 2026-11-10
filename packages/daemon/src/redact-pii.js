// Personal-data shield (lane A, N5): a PURE function that masks what looks like a Vietnamese
// phone number, a CCCD/CMND number or an e-mail address, keeping only the last 2-3 characters.
//
// It matches SHAPES, not meaning. It cannot know a person's name or street address, it does not
// see digits spelled out in words ("không chín một hai…"), and it can mask a harmless number that
// happens to look like an ID (a plain 9-digit counter). See docs/approval-policy.md "Limits".
//
// How text is searched: a DETECTION COPY of the text is made (NFKC, so full-width digits "０９１２…"
// read as digits, and zero-width/soft-hyphen characters dropped), the patterns run on that copy, and each
// match is mapped back to the ORIGINAL text, which is the one that is returned. So only the matched value
// is replaced: nothing else in the text is rewritten (an ellipsis stays an ellipsis).

// what people put between digit groups: whitespace (tab, newline, NBSP, thin space), any dash, dot, slash, brackets
const SEP_CHARS = "\\s\\p{Pd}./()";
const SEP = `(?:[${SEP_CHARS}]{1,3})`; // bounded, so the scan stays linear

// Principle: when in doubt, MASK. Hiding a harmless number costs a little readability; letting a phone
// number through costs the shield. So the phone and CCCD shapes (strong prefixes) have no "looks like an
// amount" exemption and only refuse to start in the middle of a digit run (a long decimal such as
// 1.0912345678 is masked: harmless). The bare 9-digit CMND shape is weak (any counter has 9 digits), so only
// that one is stricter.
const STRONG_START = "(?<!\\d)";
const STRONG_END = "(?!\\d)";
const WEAK_START = "(?<![A-Za-z0-9_.,/\\-+$₫#@])";
const WEAK_END = "(?![0-9A-Za-z]|[.,][0-9])";
const UNIT = "(?!\\s?(?:đ|₫|vnd|vnđ|usd|đồng|dong|k|tr|triệu|tỷ|ty|%|mb|kb|gb|ms)(?![\\p{L}\\p{N}]))"; // an amount, a size, a duration: whole word only

// +84 / 0084 / (+84) / 84, optionally followed by the trunk "(0)" as in "+84 (0) 912 345 678"
const INTL = `(?:(?:\\+|00)\\s?84|\\(\\+84\\)|84)(?:${SEP}?\\(0\\))?`;
// 0 + 9 digits (mobile/landline) or the international form + 9 digits, optional separators between digits
const PHONE_RE = new RegExp(`${STRONG_START}(?:${INTL}|0)(?:${SEP}?\\d){9}${STRONG_END}`, "giu");
// 11-digit numbers: the pre-2018 mobiles (01xx) and 2-digit area-code landlines (028 3812 3456)
const LONG_PHONE_RE = new RegExp(`${STRONG_START}0[12](?:${SEP}?\\d){9}${STRONG_END}`, "giu");
// CCCD: 12 digits whose first three are a province code (001-096)
const CCCD_RE = new RegExp(`${STRONG_START}0(?:0[1-9]|[1-8]\\d|9[0-6])(?:${SEP}?\\d){9}${STRONG_END}`, "giu");
// CMND: 9 digits, plain or grouped 3-3-3
const CMND_RE = new RegExp(`${WEAK_START}(?:\\d{9}|\\d{3}(?:[ .\\-]\\d{3}){2})${WEAK_END}${UNIT}`, "giu");
// lengths are bounded (RFC 5321: local part 64, label 63) so a huge run of letters/digits cannot make the scan quadratic
const EMAIL_RE = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24}/giu;

const INVISIBLE = /[­᠎​-‏‪-‮⁠-⁤﻿]/u;
const NON_ASCII = /[^\x00-\x7f]/;

const digitsOf = (s) => s.replace(/\D/g, "");
const tail = (s, n) => s.slice(-n);

/**
 * The detection copy plus, for every character of it, where it came from in the original (UTF-16 offsets).
 * Printable ASCII needs no copy.
 */
function detection(text) {
  if (!NON_ASCII.test(text)) return { det: text, from: null, to: null };
  const out = [];
  const from = [];
  const to = [];
  let i = 0;
  for (const ch of text) {
    const len = ch.length;
    if (!INVISIBLE.test(ch)) {
      const n = ch.codePointAt(0) < 128 ? ch : ch.normalize("NFKC");
      for (let k = 0; k < n.length; k++) {
        out.push(n[k]);
        from.push(i);
        to.push(i + len);
      }
    }
    i += len;
  }
  return { det: out.join(""), from, to };
}

/** Replace what `re` finds in the detection copy, in the original text. `replacer(match)` returns the new text or null to skip. */
function stage(text, re, replacer) {
  const { det, from, to } = detection(text);
  let result = "";
  let last = 0;
  let replaced = false;
  for (const m of det.matchAll(re)) {
    const rep = replacer(m[0]);
    if (rep === null) continue;
    const s = from ? from[m.index] : m.index;
    const e = from ? to[m.index + m[0].length - 1] : m.index + m[0].length;
    if (s < last) continue;
    result += text.slice(last, s) + rep;
    last = e;
    replaced = true;
  }
  return replaced ? result + text.slice(last) : text;
}

/** After the 0 / 84 / 0084 the next digit of a Vietnamese number is 2,3,5,7,8 or 9, and 9 digits follow. */
function plausiblePhone(raw) {
  if (/^0\.\d{9}$/.test(raw)) return false; // 0.912345678 is a decimal, not a number someone dials
  let d = digitsOf(raw);
  if (d.startsWith("0084")) d = d.slice(4);
  else if (d.startsWith("84")) d = d.slice(2);
  if (d.startsWith("0")) d = d.slice(1);
  return d.length === 9 && /^[235789]/.test(d);
}

/**
 * @param {unknown} input
 * @returns {{text: string, counts: {phone: number, id: number, email: number}}}
 */
export function redactPii(input) {
  let text = input == null ? "" : String(input);
  const counts = { phone: 0, id: 0, email: 0 };
  const phone = (m) => {
    counts.phone += 1;
    return `[phone ***${tail(digitsOf(m), 3)}]`;
  };
  const id = (m) => {
    counts.id += 1;
    return `[id ***${tail(digitsOf(m), 2)}]`;
  };
  text = stage(text, EMAIL_RE, (m) => {
    counts.email += 1;
    return `[email ***${tail(m, 3)}]`;
  });
  text = stage(text, PHONE_RE, (m) => (plausiblePhone(m) ? phone(m) : null));
  text = stage(text, LONG_PHONE_RE, phone);
  text = stage(text, CCCD_RE, id);
  text = stage(text, CMND_RE, id);
  return { text, counts };
}

export const emptyCounts = () => ({ phone: 0, id: 0, email: 0 });
export const totalCount = (c) => c.phone + c.id + c.email;

// ── text that has been CUT ───────────────────────────────────────────────────────────────
const WINDOW = 256; // only the end of a text can hold a half value; also bounds the work
const DIGIT_TAIL_RE = new RegExp(`[+(]?\\d[\\d${SEP_CHARS}]*$`, "u");
const WORDISH_TAIL_RE = /[A-Za-z0-9._%+\-@]*$/;
const MAX_LAST_WORD = 40;

/**
 * Text that has been CUT to a length can end halfway through a value ("0912 345 6", "nguyen.van.a@gma"),
 * and a half value no longer matches any pattern. So after a cut: drop the last (possibly half) word, or,
 * when there is no word break to rely on (compact JSON), the trailing run of letters/digits/@/./-; then drop
 * any run of digits and separators left at the end (3+ digits). Looks at the last 256 characters only.
 */
export function dropCutTail(text) {
  const t = String(text ?? "").replace(/…+\s*$/u, "");
  const head = t.length > WINDOW ? t.slice(0, -WINDOW) : "";
  let end = t.length > WINDOW ? t.slice(-WINDOW) : t;
  let i = end.length;
  while (i > 0 && !/\s/.test(end[i - 1])) i -= 1; // the last word starts after the last whitespace
  if (i > 0 && end.length - i <= MAX_LAST_WORD) end = end.slice(0, i);
  else end = end.replace(WORDISH_TAIL_RE, "");
  end = end.replace(DIGIT_TAIL_RE, (run) => (run.replace(/\D/g, "").length >= 3 ? "" : run));
  return (head + end).trimEnd();
}

/**
 * Every adapter and the broker mark a cut with a trailing "…". Any LINE that ends with one is a cut text:
 * drop its half-cut tail. Applied to all text in a masked chat, whatever its source.
 */
export function dropMarkedCuts(text) {
  const s = String(text ?? "");
  if (!s.includes("…")) return s;
  return s.split("\n").map((line) => (/…\s*$/u.test(line) ? dropCutTail(line) : line)).join("\n");
}

/**
 * The one way to shorten text that is about to leave the machine: MASK THE WHOLE TEXT FIRST, then cut, so a
 * value can never straddle the cut. If a cut happened (or the text arrives already cut by an earlier step,
 * `alreadyCut`) the tail is dropped as above.
 */
export function safePreview(text, max, { alreadyCut = false } = {}) {
  const masked = dropMarkedCuts(redactPii(text).text);
  const cut = masked.length > max;
  const out = cut ? masked.slice(0, max) : masked;
  return cut || alreadyCut ? dropCutTail(out) : out;
}
