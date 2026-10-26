// @vitest-environment happy-dom
// @vitest-environment-options {"url": "http://localhost:5173/"}
import { expect, it } from "vitest";
import { SENSITIVE } from "./fixtures/sensitiveDaemon";
import { bootApp, sweepEveryView } from "./fixtures/sweepHarness";

// Control for presentationSweep.test.ts: same fixture, switch OFF — the names
// must be visible, otherwise the positive test above proves nothing.
it("with the switch OFF the fixture's names are on screen", async () => {
  await bootApp("?present=0");
  const surface = await sweepEveryView();
  const hits = SENSITIVE.filter((s) => surface.includes(s));
  expect(hits).toEqual(expect.arrayContaining(SENSITIVE.filter((x) => x !== "secret-merger")));
  expect(document.body.dataset.presentation).toBeUndefined();
});
