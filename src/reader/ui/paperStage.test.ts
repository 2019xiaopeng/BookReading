import { expect, test } from "vitest";

import { calcPaperStage } from "./paperStage";

test("paper stage fills width with margins", () => {
  const r = calcPaperStage({ viewerWidth: 1400, viewerHeight: 900, margin: 18, edgeRatio: 0.2 });
  expect(r.leftEdgeWidth).toBe(220);
  expect(r.rightEdgeWidth).toBe(220);
});

test("edge width clamps to min", () => {
  const r = calcPaperStage({ viewerWidth: 520, viewerHeight: 900, margin: 18, edgeRatio: 0.2 });
  expect(r.leftEdgeWidth).toBe(120);
});
