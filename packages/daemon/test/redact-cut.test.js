import { test } from "node:test";
import assert from "node:assert/strict";
import { safePreview, redactPii } from "../src/redact-pii.js";

const PHONES = ["0912345678", "0912 345 678", "0912​345​678", "+84 912 345 678", "(+84) 912.345.678", "091-234-5678", "0912 345 678"];
const EMAIL = "nguyen.van.a@example.com";
const digitsOf = (s) => s.replace(/\D/g, "");
/** no run of 4+ digits of the original number survives in `out` (after dropping separators) */
function leaksDigits(out, phone) {
  const d = digitsOf(phone);
  const o = digitsOf(out);
  for (let i = 0; i + 4 <= d.length; i++) if (o.includes(d.slice(i, i + 4))) return true;
  return false;
}

for (const phone of PHONES) {
  const label = JSON.stringify(phone);
  test(`mask first, then cut: a cut at ANY position through ${label} leaks no digits`, () => {
    const text = `Khách gọi ${phone} hôm qua`;
    for (let max = 1; max <= text.length; max++) {
      const out = safePreview(text, max);
      assert.equal(leaksDigits(out, phone), false, `max=${max}: ${JSON.stringify(out)}`);
      assert.ok(out.length <= max, `max=${max} but ${out.length} chars`);
    }
  });
  test(`text ALREADY cut upstream through ${label}: no digits leak at any cut position`, () => {
    const text = `Khách gọi ${phone} hôm qua`;
    for (let k = 1; k <= text.length; k++) {
      const out = safePreview(text.slice(0, k), 1000, { alreadyCut: true });
      assert.equal(leaksDigits(out, phone), false, `cut=${k}: ${JSON.stringify(out)}`);
    }
  });
}

test("mask first, then cut: a cut at any position through an e-mail leaks no part of it", () => {
  const text = `gửi tới ${EMAIL} nhé`;
  for (let max = 1; max <= text.length; max++) {
    const out = safePreview(text, max);
    assert.doesNotMatch(out, /nguyen|van\.a|@|example/i, `max=${max}: ${JSON.stringify(out)}`);
  }
});

test("e-mail ALREADY cut upstream at any position leaks neither the local part nor the @", () => {
  const text = `gửi tới ${EMAIL}`;
  for (let k = 1; k <= text.length; k++) {
    const out = safePreview(text.slice(0, k), 1000, { alreadyCut: true });
    assert.doesNotMatch(out, /nguyen|@|exam/i, `cut=${k}: ${JSON.stringify(out)}`);
  }
});

test("safePreview leaves a short, clean text exactly as redactPii would", () => {
  assert.equal(safePreview("Đã duyệt Bash: npm test", 300), "Đã duyệt Bash: npm test");
  assert.equal(safePreview("0912345678", 300), redactPii("0912345678").text);
});

test("a cut that happens to fall at a word boundary keeps the words before it", () => {
  assert.equal(safePreview("npm run build and then deploy", 13), "npm run");
});

test("a very long input is handled quickly", () => {
  const t0 = Date.now();
  safePreview("0 ".repeat(50000), 400);
  safePreview("1".repeat(100000), 400, { alreadyCut: true });
  assert.ok(Date.now() - t0 < 1000);
});
