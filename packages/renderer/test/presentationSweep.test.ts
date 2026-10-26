// @vitest-environment happy-dom
// @vitest-environment-options {"url": "http://localhost:5173/"}
import { expect, it } from "vitest";
import { SENSITIVE } from "./fixtures/sensitiveDaemon";
import { bootApp, sweepEveryView } from "./fixtures/sweepHarness";

// Positive test for presentation mode: boot the REAL app (main.ts, every view)
// against a daemon whose data is full of names, switch the mask on, visit every
// view, and demand that none of those names appears in any rendered text or
// text-bearing attribute. The sibling file presentationSweepControl.test.ts
// proves the same fixture does leak with the switch off.
it("with the switch ON no sensitive name survives in any view", async () => {
  await bootApp("?present=1");
  const surface = await sweepEveryView();
  const leaked = SENSITIVE.filter((s) => surface.toLowerCase().includes(s.toLowerCase()));
  expect(leaked).toEqual([]);
  // ...and the app is genuinely populated, not just empty
  expect(surface).toMatch(/project-\d/);
  expect(surface).toMatch(/dir-\d|file-\d/);
  expect(surface).toContain("\u2592"); // blurred free text
  expect(surface).toMatch(/~\/[^\s]*project-\d/); // a real-looking working directory survives as an alias, not as ••••
  expect(surface).toMatch(/mcp__server-\d/);
  expect(document.body.dataset.presentation).toBe("on");
  expect(document.getElementById("present-badge")).not.toBeNull();
});
