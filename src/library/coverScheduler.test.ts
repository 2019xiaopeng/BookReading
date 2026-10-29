import { describe, expect, test } from "vitest";

import { MAX_CONCURRENT_COVER_LOADS, pickNextCoverRequests } from "./coverScheduler";

describe("pickNextCoverRequests", () => {
  const paths = ["a.jpg", "b.jpg", "c.jpg", "d.jpg", "e.jpg", "f.jpg", "g.jpg"];

  test("caps the batch at the free-slot count", () => {
    expect(pickNextCoverRequests(paths, MAX_CONCURRENT_COVER_LOADS, () => false)).toEqual([
      "a.jpg",
      "b.jpg",
      "c.jpg",
      "d.jpg",
      "e.jpg",
      "f.jpg",
    ]);
    expect(pickNextCoverRequests(paths, 0, () => false)).toEqual([]);
    expect(pickNextCoverRequests([], 6, () => false)).toEqual([]);
  });

  test("viewport hits jump the queue, keeping stable order within each group", () => {
    // 视口命中 c/e：先于更早入队的 a/b 出队；命中组内保持入队顺序（c 先于 e）
    const hit = new Set(["c.jpg", "e.jpg"]);
    expect(pickNextCoverRequests(paths, 3, (p) => hit.has(p))).toEqual(["c.jpg", "e.jpg", "a.jpg"]);
  });

  test("everything visible degenerates to plain FIFO", () => {
    expect(pickNextCoverRequests(paths, 7, () => true)).toEqual(paths);
  });
});
