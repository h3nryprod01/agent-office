import { describe, expect, it } from "vitest";
import { detect, getLang, setLang, t } from "../src/i18n";
import { en } from "../src/i18n/en";
import { vi } from "../src/i18n/vi";

describe("detect", () => {
  it("respects preference order, not mere presence", () => {
    // Someone in Vietnam whose browser is set to English. Matching "vi appears
    // anywhere" would override the preference they actually stated.
    expect(detect(["en-US", "en-VN", "vi-VN"])).toBe("en");
    expect(detect(["vi-VN", "en-US"])).toBe("vi");
  });

  it("skips languages it has no dictionary for", () => {
    expect(detect(["fr-FR", "de-DE", "vi-VN"])).toBe("vi");
  });

  it("falls back to English when nothing matches or the list is empty", () => {
    expect(detect(["fr-FR"])).toBe("en");
    expect(detect([])).toBe("en");
  });
});

describe("t", () => {
  it("substitutes every occurrence of a placeholder", () => {
    const before = getLang();
    try {
      setLang("en");
      expect(t("chat.sendFailed", { status: 503 })).toBe("Send failed (HTTP 503)");
      expect(t("panel.showMore", { n: 100 })).toBe("Show more (100)");
    } finally {
      setLang(before);
    }
  });

  it("leaves an unknown key visible instead of rendering an empty label", () => {
    expect(t("no.such.key" as never)).toBe("no.such.key");
  });
});

describe("dictionaries", () => {
  it("define exactly the same keys, so switching never blanks a label", () => {
    const enKeys = Object.keys(en).sort();
    const viKeys = Object.keys(vi).sort();
    expect(viKeys).toEqual(enKeys);
  });

  it("agree on the placeholders each string uses", () => {
    const holders = (s: string): string[] => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      expect({ key, vars: holders(vi[key] ?? "") }).toEqual({ key, vars: holders(en[key]) });
    }
  });
});
