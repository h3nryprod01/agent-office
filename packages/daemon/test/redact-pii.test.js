import { test } from "node:test";
import assert from "node:assert/strict";
import { redactPii } from "../src/redact-pii.js";

// Every number below is made up. Positive = must be masked, negative = must pass through untouched.
const POSITIVE = [
  ["phone, plain 0xxx", "Gọi 0912345678 nhé", "phone"],
  ["phone, spaces", "SĐT 0912 345 678", "phone"],
  ["phone, dots", "SĐT 0912.345.678", "phone"],
  ["phone, dashes", "SĐT 091-234-5678", "phone"],
  ["phone, +84", "Liên hệ +84 912 345 678 ngay", "phone"],
  ["phone, +84 no spaces", "+84912345678", "phone"],
  ["phone, 84 no plus", "zalo 84912345678", "phone"],
  ["phone, (+84)", "tel (+84) 912345678", "phone"],
  ["phone, landline", "văn phòng 02800000000", "phone"],
  ["phone, old 11 digits", "máy cũ 01201234567", "phone"],
  ["phone, at end of sentence", "Số của khách là 0987654321.", "phone"],
  ["phone, no-break space", "0912 345 678", "phone"],
  ["phone, zero-width space", "0912​345​678", "phone"],
  ["id, CCCD 12 digits", "CCCD 001000000000", "id"],
  ["id, CCCD grouped", "CCCD 001 000 000 000", "id"],
  ["id, CMND 9 digits", "CMND 123456789", "id"],
  ["id, CMND after colon", "CMND:123456789", "id"],
  ["phone, followed by a Vietnamese word starting with đ", "0912345678 đã gọi", "phone"],
  ["phone, đ glued", "0912345678đã gọi", "phone"],
  ["phone, followed by Đức", "0912345678 Đức", "phone"],
  ["phone, followed by a name (Tr)", "0912345678 Trần Văn A", "phone"],
  ["phone, followed by k-word", "0912345678 không nghe máy", "phone"],
  ["phone, followed by ms", "0912345678 ms Lan", "phone"],
  ["phone, followed by ty", "0912345678 ty TNHH Sao", "phone"],
  ["phone, followed by tỷ-word", "0912345678 tỷ lệ", "phone"],
  ["phone, +84 followed by đã", "+84912345678 đã gọi", "phone"],
  ["phone, after colon", "SĐT: 0912.345.678", "phone"],
  ["phone, after comma", "a,0912345678", "phone"],
  ["phone, after slash", "liên hệ/0912345678", "phone"],
  ["phone, after dash", "ĐT-0912345678", "phone"],
  ["phone, after dot", "xong.0912345678", "phone"],
  ["phone, glued to letters before", "SĐT0912345678", "phone"],
  ["phone, bare 'k' unit", "0912345678 k", "phone"],
  ["id, CCCD followed by đ-word", "CCCD 001000000000 đã cấp", "id"],
  ["email", "mail khach.hang+bds@example.com.vn nhé", "email"],
  ["email, upper case", "Mail A.B@EXAMPLE.COM", "email"],
];

for (const [name, input, kind] of POSITIVE) {
  test(`masks: ${name}`, () => {
    const out = redactPii(input);
    assert.equal(out.counts[kind], 1, `${kind} not counted in ${JSON.stringify(out)}`);
    assert.notEqual(out.text, input);
    // none of the original digits run survives
    assert.doesNotMatch(out.text, /\d{6}/);
    assert.doesNotMatch(out.text, /@[A-Za-z0-9-]+\./);
  });
}

// a phone number counted twice would be a bug too: two numbers separated by a comma are TWO values
const NEGATIVE = [
  ["money with dots", "Giá 1.500.000.000 đồng"],
  ["money with commas", "Total $1,234,567,890"],
  ["money, bare 10 digits starting with 1", "Giá 1500000000 VND"],
  ["money, 9 digits with unit", "Phí 500000000 đ"],
  ["amount in triệu", "Giá 500 triệu"],
  ["amount in tỷ", "Giá 1,5 tỷ"],
  ["date short", "Hạn 12/11/2026"],
  ["money, 9 digits then triệu", "Giá 123456789 triệu"],
  ["money, 9 digits with USD", "Budget 123456789 USD"],
  ["decimal", "Tỉ lệ 0.912345678"],
  ["date iso", "Ngày 2026-11-10 lúc 15:30"],
  ["date vn", "Hạn 10/11/2026"],
  ["datetime compact", "build 202611101530 ok"],
  ["git commit short", "commit ff61506 và d3969eb"],
  ["git commit full", "ff61506ab12c34d56e78f901a2b3c4d5e6f70812"],
  ["git commit digits-and-letters", "sha 3340665d1e"],
  ["epoch seconds", "ts 1762771200"],
  ["epoch millis", "ts 1762771200000"],
  ["ip address", "host 203.0.113.20"],
  ["port and pid", "port 8787 pid 41234"],
  ["version", "v2.1.308 build 12345"],
  ["issue ref", "xem #123456789"],
  ["12 digits, province code out of range", "mã 202611101530"],
  ["npm scope", "cài @types/node và @agent-office/daemon"],
  ["short numbers", "có 25 test, 905 pass, 0 fail"],
  ["approval id", "/approve a1b2c3d4"],
  ["duration", "chờ 17 phút 30 giây"],
];

for (const [name, input] of NEGATIVE) {
  test(`leaves alone: ${name}`, () => {
    const out = redactPii(input);
    assert.equal(out.text, input);
    assert.deepEqual(out.counts, { phone: 0, id: 0, email: 0 });
  });
}

test("keeps only the last characters, in a recognisable placeholder", () => {
  assert.equal(redactPii("0912345678").text, "[phone ***678]");
  assert.equal(redactPii("+84 912 345 678").text, "[phone ***678]");
  assert.equal(redactPii("001000000000").text, "[id ***00]");
  assert.equal(redactPii("123456789").text, "[id ***89]");
  assert.equal(redactPii("khach@example.com").text, "[email ***com]");
});

test("several values in one text are all masked and counted", () => {
  const out = redactPii("A 0912345678, B +84 987 654 321, mail a@b.vn, CCCD 001000000000, CMND 123456789.");
  assert.deepEqual(out.counts, { phone: 2, id: 2, email: 1 });
  assert.doesNotMatch(out.text, /\d{6}/);
});

test("a message with nothing to mask comes back unchanged with zero counts", () => {
  const out = redactPii("Đã duyệt Bash: npm test");
  assert.equal(out.text, "Đã duyệt Bash: npm test");
  assert.deepEqual(out.counts, { phone: 0, id: 0, email: 0 });
});

test("non-string input is handled without throwing", () => {
  assert.equal(redactPii(undefined).text, "");
  assert.equal(redactPii(null).text, "");
  assert.equal(redactPii(42).text, "42");
});

test("masking twice changes nothing more", () => {
  const once = redactPii("0912345678 và a@b.vn").text;
  const twice = redactPii(once);
  assert.equal(twice.text, once);
  assert.deepEqual(twice.counts, { phone: 0, id: 0, email: 0 });
});

test("a long text with many digits stays fast (no catastrophic backtracking)", () => {
  const nasty = "0 ".repeat(5000) + "1".repeat(20000) + " 0-".repeat(3000);
  const t0 = Date.now();
  redactPii(nasty);
  assert.ok(Date.now() - t0 < 1000, "redactPii took too long");
});

test("two phone numbers separated by a comma are two values", () => {
  assert.equal(redactPii("0912345678,0987654321").counts.phone, 2);
  assert.doesNotMatch(redactPii("0912345678,0987654321").text, /\d{6}/);
});
