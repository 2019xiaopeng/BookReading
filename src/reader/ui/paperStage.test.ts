import { expect, test } from "vitest";

import { calcPaperStage } from "./paperStage";

test("paper stage fills width with margins", () => {
  const r = calcPaperStage({ viewerWidth: 1400, viewerHeight: 900, margin: 18, edgeRatio: 0.2 });
  expect(r.paperWidth).toBe(1400 - 36);
  expect(r.paperHeight).toBe(900 - 36);
  expect(r.leftEdgeWidth).toBe(Math.round((1400 - 36) * 0.2));
  expect(r.rightEdgeWidth).toBe(Math.round((1400 - 36) * 0.2));
});

