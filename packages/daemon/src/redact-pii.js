// Personal-data shield (lane A, N5): a PURE function that masks what looks like a Vietnamese
// phone number, a CCCD/CMND number or an e-mail address, keeping only the last 2-3 characters.
//
// It matches SHAPES, not meaning. It cannot know a person's name or street address, it does not
// see digits spelled out in words ("không chín một hai…"), and it can mask a harmless number that
// happens to look like an ID (a plain 9-digit counter). See docs/approval-policy.md "Limits".

const SEP = "[ \\u00a0\\u200b-\\u200d\\u2060\\ufeff.\\-]"; // what people put between digit groups

// Principle: when in doubt, MASK. Hiding a harmless number costs a little readability; letting a phone
// number through costs the shield. So the phone and CCCD shapes (strong prefixes) have no "looks like an
// amount" exemption and only refuse to start in the middle of a digit run (a long decimal such as 1.0912345678 is masked: harmless).
// The bare 9-digit CMND shape is weak (any counter has 9 digits), so only that one is stricter.
const STRONG_START = "(?<![0-9_+@#$₫])";
const STRONG_END = "(?![0-9])";
const WEAK_START = "(?<![A-Za-z0-9_.,/\\-+$₫#@])";
const WEAK_END = "(?![0-9A-Za-z]|[.,][0-9])";
const UNIT = "(?!\\s?(?:đ|₫|vnd|vnđ|usd|đồng|dong|k|tr|triệu|tỷ|ty|%|mb|kb|gb|ms)(?![\\p{L}\\p{N}]))"; // an amount, a size, a duration — whole word only

// 0 + 9 digits (mobile/landline) or 84 + 9 digits, with optional single separators between digits.
const PHONE_RE = new RegExp(`${STRONG_START}(?:\\(?\\+84\\)?|84|0)(?:${SEP}?\\d){9}${STRONG_END}`, "giu");
// 11-digit numbers: the pre-2018 mobiles (01xx) and 2-digit area-code landlines (028 3812 3456)
const LONG_PHONE_RE = new RegExp(`${STRONG_START}0[12](?:${SEP}?\\d){9}${STRONG_END}`, "giu");
// CCCD: 12 digits whose first three are a province code (001-096)
const CCCD_RE = new RegExp(`${STRONG_START}0(?:0[1-9]|[1-8]\\d|9[0-6])(?:${SEP}?\\d){9}${STRONG_END}`, "giu");
// CMND: exactly 9 plain digits
const CMND_RE = new RegExp(`${WEAK_START}\\d{9}${WEAK_END}${UNIT}`, "giu");
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

const digitsOf = (s) => s.replace(/\D/g, "");
const tail = (s, n) => s.slice(-n);

/** After the leading 0 / 84 the next digit of a Vietnamese number is 2,3,5,7,8 or 9. */
function plausiblePhone(raw) {
  if (/^0\.\d{9}$/.test(raw)) return false; // 0.912345678 is a decimal, not a number someone dials
  let d = digitsOf(raw);
  if (d.startsWith("84")) d = d.slice(2);
  else if (d.startsWith("0")) d = d.slice(1);
  return d.length === 9 && /^[235789]/.test(d);
}

/**
 * @param {unknown} input
 * @returns {{text: string, counts: {phone: number, id: number, email: number}}}
 */
export function redactPii(input) {
  let text = input == null ? "" : String(input);
  const counts = { phone: 0, id: 0, email: 0 };

  text = text.replace(EMAIL_RE, (m) => {
    counts.email += 1;
    return `[email ***${tail(m, 3)}]`;
  });
  text = text.replace(PHONE_RE, (m) => {
    if (!plausiblePhone(m)) return m;
    counts.phone += 1;
    return `[phone ***${tail(digitsOf(m), 3)}]`;
  });
  text = text.replace(LONG_PHONE_RE, (m) => {
    counts.phone += 1;
    return `[phone ***${tail(digitsOf(m), 3)}]`;
  });
  const id = (m) => {
    counts.id += 1;
    return `[id ***${tail(digitsOf(m), 2)}]`;
  };
  text = text.replace(CCCD_RE, id);
  text = text.replace(CMND_RE, id);
  return { text, counts };
}

export const emptyCounts = () => ({ phone: 0, id: 0, email: 0 });
export const totalCount = (c) => c.phone + c.id + c.email;

/**
 * A string that was cut at a fixed length (a 200-character preview) can end halfway through a number:
 * "…call 09123" has no complete phone number for redactPii to find. Drop such a trailing run of digits
 * (3 or more) so a fragment of a number does not travel. Used only on text known to have been truncated.
 */
export function dropDigitTail(text) {
  return String(text ?? "").replace(/[+(]?\d[\d ()\u00a0.\-]*\d$/, (tailRun) => (tailRun.replace(/\D/g, "").length >= 3 ? "…" : tailRun));
}
