// Review M1: the many ways a person (or a PM) actually writes a number. Made-up values throughout.
import { test } from "node:test";
import assert from "node:assert/strict";
import { redactPii } from "../src/redact-pii.js";
import { assertLinear } from "./helpers/linear.js";


const FORMS = [
  ["plain spaces", "0912 345 678", "phone"],
  ["thin space U+2009", "0912 345 678", "phone"],
  ["en dash", "0912–345–678", "phone"],
  ["non-breaking hyphen U+2011", "0912‑345‑678", "phone"],
  ["soft hyphen", "0912­345­678", "phone"],
  ["tab", "0912\t345\t678", "phone"],
  ["newline", "0912\n345\n678", "phone"],
  ["two spaces", "0912  345  678", "phone"],
  ["spaced dashes", "0912 - 345 - 678", "phone"],
  ["slashes", "0912/345/678", "phone"],
  ["area code in brackets", "(091) 234 5678", "phone"],
  ["+84 with (0)", "+84 (0) 912 345 678", "phone"],
  ["0084 prefix", "0084912345678", "phone"],
  ["0084 with space", "00 84 912 345 678", "phone"],
  ["plus before the 0", "+0912345678", "phone"],
  ["at sign before", "@0912345678", "phone"],
  ["hash before", "#0912345678", "phone"],
  ["full-width digits", "０９１２３４５６７８", "phone"],
  ["full-width digits with full-width space", "０９１２　３４５　６７８", "phone"],
  ["zero-width inside", "09​12‌345‍678", "phone"],
  ["BOM and word joiner inside", "0912﻿345⁠678", "phone"],
  ["landline", "028 0000 0000", "phone"],
  ["CMND grouped by dots", "CMND 123.456.789", "id"],
  ["CMND grouped by spaces", "CMND 123 456 789", "id"],
  ["CCCD", "CCCD 001000000000", "id"],
  ["e-mail with zero-width inside", "an​.nguyen@exam​ple.com", "email"],
  ["e-mail full-width at sign", "an.nguyen＠example.com", "email"],
];

for (const [name, input, kind] of FORMS) {
  test(`masks: ${name}`, () => {
    const out = redactPii(`Khách: ${input} nhé`);
    assert.equal(out.counts[kind], 1, JSON.stringify(out));
    const digits = out.text.replace(/\D/g, "");
    assert.ok(digits.length <= 3, `digits left: ${JSON.stringify(out.text)}`);
    assert.doesNotMatch(out.text, /nguyen|example/i);
    assert.match(out.text, /^Khách: .*nhé$/s); // the text around it is untouched
  });
}

test("text around a masked value keeps its own characters (full-width and invisible ones elsewhere survive)", () => {
  const out = redactPii("Ｘin​chào 0912 345 678 …");
  assert.equal(out.text, "Ｘin​chào [phone ***678] …");
});

test("the ellipsis is not rewritten as three dots", () => {
  assert.ok(redactPii("đang chạy…").text.endsWith("…"));
});

const KEEP = [
  "Giá 1.234.567.890 đồng",
  "Hạn 12/11/2026 lúc 09:30",
  "sha 3340665d1e và ff61506ab12c34d56e78",
  "ip 203.0.113.20 port 8787",
  "Phí 123.456.789 đ",
  "v2.1.308 build 12345",
  "tổng 45 test, 1046 pass",
];
for (const text of KEEP) {
  test(`still leaves alone: ${text}`, () => {
    assert.equal(redactPii(text).text, text);
  });
}

test("time grows linearly with length, for mixed ASCII, Vietnamese, digit and separator text", () => {
  const makers = {
    ascii: (n) => "lorem ipsum dolor sit amet ".repeat(Math.ceil(n / 27)),
    vietnamese: (n) => "Khách hàng đã gọi lại để hỏi giá căn hộ ".repeat(Math.ceil(n / 40)),
    digits: (n) => "1".repeat(n),
    zeros: (n) => "0 ".repeat(n / 2),
    dashes: (n) => "0912-".repeat(n / 5),
    dots: (n) => "a.".repeat(n / 2),
    invisible: (n) => "\u200b".repeat(n),
    fullwidth: (n) => "\uff10\uff11\uff12\uff13".repeat(n / 4),
  };
  for (const [name, make] of Object.entries(makers)) assertLinear(name, make, redactPii);
});
