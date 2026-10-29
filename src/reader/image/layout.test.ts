import { describe, expect, test } from "vitest";

import {
  autoScrollStep,
  buildSpreads,
  clampPage,
  clampZoomScale,
  defaultImageReaderSettings,
  displayOrder,
  imageCfi,
  maxWidthForStage,
  normalizeImageReaderSettings,
  pagePercent,
  panClamp,
  parseImageCfi,
  slideDirection,
  spreadIndexForPage,
  turnKeyDirection,
  widePagesFromMeta,
} from "./layout";

describe("buildSpreads", () => {
  test("single layout gives every page its own spread", () => {
    expect(buildSpreads(3, [true, false, true], "single")).toEqual([[0], [1], [2]]);
  });

  test("double layout pairs pages and leaves the odd page alone", () => {
    expect(buildSpreads(5, [], "double")).toEqual([[0, 1], [2, 3], [4]]);
  });

  test("wide page claims a full spread in double layout", () => {
    expect(buildSpreads(5, [false, false, true, false, false], "double")).toEqual([[0, 1], [2], [3, 4]]);
  });

  test("wide first page pairs the rest normally", () => {
    expect(buildSpreads(4, [true, false, false, false], "double")).toEqual([[0], [1, 2], [3]]);
  });

  test("pending single flushes before a wide page", () => {
    expect(buildSpreads(3, [false, true, false], "double")).toEqual([[0], [1], [2]]);
  });

  test("zero pages yields no spreads", () => {
    expect(buildSpreads(0, [], "double")).toEqual([]);
  });
});

describe("displayOrder", () => {
  test("rtl swaps the pair, single and ltr stay as-is", () => {
    expect(displayOrder([2, 3], false)).toEqual([2, 3]);
    expect(displayOrder([2, 3], true)).toEqual([3, 2]);
    expect(displayOrder([5], true)).toEqual([5]);
  });
});

describe("turnKeyDirection", () => {
  test("ltr arrows map like the epub reader", () => {
    expect(turnKeyDirection("ArrowLeft", false)).toBe("prev");
    expect(turnKeyDirection("ArrowRight", false)).toBe("next");
  });

  test("rtl arrows reverse, PageUp/PageDown stay semantic", () => {
    expect(turnKeyDirection("ArrowLeft", true)).toBe("next");
    expect(turnKeyDirection("ArrowRight", true)).toBe("prev");
    expect(turnKeyDirection("PageUp", true)).toBe("prev");
    expect(turnKeyDirection("PageDown", true)).toBe("next");
  });

  test("other keys are not turns", () => {
    expect(turnKeyDirection("a", false)).toBeNull();
    expect(turnKeyDirection("Escape", true)).toBeNull();
  });
});

describe("spreadIndexForPage", () => {
  test("finds the spread holding the page", () => {
    const spreads = [[0, 1], [2], [3, 4]];
    expect(spreadIndexForPage(spreads, 2)).toBe(1);
    expect(spreadIndexForPage(spreads, 4)).toBe(2);
    expect(spreadIndexForPage(spreads, 99)).toBe(0);
  });
});

describe("reading state cfi", () => {
  test("imageCfi round-trips through parseImageCfi", () => {
    expect(imageCfi(12)).toBe("img:12");
    expect(parseImageCfi(imageCfi(12))).toBe(12);
  });

  test("non-image cfi and garbage parse to null", () => {
    expect(parseImageCfi("epubcfi(/6/4")).toBeNull();
    expect(parseImageCfi(null)).toBeNull();
    expect(parseImageCfi("img:x")).toBeNull();
    expect(parseImageCfi("img:-1")).toBeNull();
  });
});

describe("pagePercent / clampPage", () => {
  test("percent is page over pageCount per contract", () => {
    expect(pagePercent(0, 128)).toBe(0);
    expect(pagePercent(64, 128)).toBe(0.5);
    expect(pagePercent(200, 128)).toBe(1);
    expect(pagePercent(0, 0)).toBe(0);
  });

  test("clamp keeps the page inside the book", () => {
    expect(clampPage(-3, 10)).toBe(0);
    expect(clampPage(99, 10)).toBe(9);
    expect(clampPage(4.7, 10)).toBe(4);
    expect(clampPage(0, 0)).toBe(0);
  });
});

describe("normalizeImageReaderSettings", () => {
  test("unknown input falls back to defaults", () => {
    expect(normalizeImageReaderSettings(undefined)).toEqual(defaultImageReaderSettings);
    expect(normalizeImageReaderSettings("not json")).toEqual(defaultImageReaderSettings);
    expect(normalizeImageReaderSettings({ fit: "huge", layout: "auto", rtl: "yes", mode: "scroll" })).toEqual(
      defaultImageReaderSettings,
    );
  });

  test("parses the persisted JSON payload", () => {
    expect(normalizeImageReaderSettings('{"fit":"width","layout":"double","rtl":true,"mode":"webtoon"}')).toEqual({
      fit: "width",
      layout: "double",
      rtl: true,
      mode: "webtoon",
      pageAnimation: "slide",
      webtoonWidth: 75,
      autoScrollSpeed: 60,
    });
  });

  test("batch5: pageAnimation keeps only none/slide, missing falls back to slide", () => {
    expect(normalizeImageReaderSettings({ pageAnimation: "none" }).pageAnimation).toBe("none");
    expect(normalizeImageReaderSettings({ pageAnimation: "fade" }).pageAnimation).toBe("slide");
    expect(normalizeImageReaderSettings({}).pageAnimation).toBe("slide");
  });

  test("batch5: webtoonWidth clamps to 40-100, non-numbers fall back to 75", () => {
    expect(normalizeImageReaderSettings({ webtoonWidth: 30 }).webtoonWidth).toBe(40);
    expect(normalizeImageReaderSettings({ webtoonWidth: 120 }).webtoonWidth).toBe(100);
    expect(normalizeImageReaderSettings({ webtoonWidth: "80" }).webtoonWidth).toBe(75);
    expect(normalizeImageReaderSettings({ webtoonWidth: 62 }).webtoonWidth).toBe(62);
  });

  test("batch11: autoScrollSpeed clamps to 20-240, non-numbers fall back to 60", () => {
    expect(normalizeImageReaderSettings({ autoScrollSpeed: 5 }).autoScrollSpeed).toBe(20);
    expect(normalizeImageReaderSettings({ autoScrollSpeed: 999 }).autoScrollSpeed).toBe(240);
    expect(normalizeImageReaderSettings({ autoScrollSpeed: "90" }).autoScrollSpeed).toBe(60);
    expect(normalizeImageReaderSettings({ autoScrollSpeed: 120 }).autoScrollSpeed).toBe(120);
  });
});

describe("zoom helpers", () => {
  test("clampZoomScale holds the 0.5-4x range", () => {
    expect(clampZoomScale(1)).toBe(1);
    expect(clampZoomScale(0.3)).toBe(0.5);
    expect(clampZoomScale(4.5)).toBe(4);
    expect(clampZoomScale(0.5)).toBe(0.5);
    expect(clampZoomScale(4)).toBe(4);
  });

  test("panClamp locks fitting axes at 0 and clamps to grown content edges", () => {
    expect(panClamp(30, 40, 800, 600, 800, 600, 1)).toEqual({ tx: 0, ty: 0 });
    expect(panClamp(999, 999, 800, 600, 800, 600, 2)).toEqual({ tx: 400, ty: 300 });
    expect(panClamp(-999, -999, 800, 600, 800, 600, 2)).toEqual({ tx: -400, ty: -300 });
    // tall strip (webtoon): vertical slack grows with the content, not the viewport
    expect(panClamp(0, 99999, 800, 600, 800, 6000, 2)).toEqual({ tx: 0, ty: 5700 });
    expect(panClamp(0, 999, 800, 600, 800, 6000, 2)).toEqual({ tx: 0, ty: 999 });
  });
});

describe("slideDirection", () => {
  test("next slides from the right, prev from the left, rtl mirrors, no move is 0", () => {
    expect(slideDirection(1, false)).toBe(1);
    expect(slideDirection(-1, false)).toBe(-1);
    expect(slideDirection(1, true)).toBe(-1);
    expect(slideDirection(-1, true)).toBe(1);
    expect(slideDirection(0, true)).toBe(0);
  });
});

describe("batch12 autoScrollStep", () => {
  const FRAMES = (speed: number, dt: number, n: number) => {
    let accum = 0;
    let px = 0;
    for (let i = 0; i < n; i++) {
      const s = autoScrollStep(accum, speed, dt);
      accum = s.accum;
      px += s.px;
    }
    return px;
  };

  test("20/60/120/240 px/s 全程线性：60 帧 1/60s 的整像素写入合计≈速度（±1px 浮点容差，余数不丢）", () => {
    const dt = 1 / 60;
    for (const speed of [20, 60, 120, 240]) {
      expect(Math.abs(FRAMES(speed, dt, 60) - speed)).toBeLessThanOrEqual(1);
    }
  });

  test("低速 <1px/帧也能起步（旧 scrollTop += 写法在整数化下恒为 0）且余数跨帧保留", () => {
    expect(Math.abs(FRAMES(20, 1 / 144, 144) - 20)).toBeLessThanOrEqual(1); // 0.139px/帧：144Hz 下同样线性
    const slow = autoScrollStep(0, 20, 1 / 60);
    expect(slow.px).toBe(0);
    expect(slow.accum).toBeCloseTo(20 / 60, 10);
    const fast = autoScrollStep(slow.accum, 240, 1 / 60);
    expect(fast.px).toBe(4); // 0.333+4=4.33 → 4px 写入、余数留存
    expect(fast.accum).toBeGreaterThan(0);
  });
});

describe("v2.5 widePagesFromMeta（宽页预判 from 页元数据）", () => {
  const meta = [
    { width: 3000, height: 2000 }, // 1.5 > 1.2 → wide
    { width: 1000, height: 1500 }, // 0.67 → 窄页
    { width: 2400, height: 2000 }, // 1.2 = 阈值，不大于 → 窄页
  ];

  test("宽/高 > 1.2 判 wide，其余窄页", () => {
    expect(widePagesFromMeta(meta, 3)).toEqual([true, false, false]);
  });

  test("元数据缺失/长度不足的页回 false（解码后探测兜底）", () => {
    expect(widePagesFromMeta(null, 2)).toEqual([false, false]);
    expect(widePagesFromMeta([meta[0]], 3)).toEqual([true, false, false]);
    expect(widePagesFromMeta([{ width: 0, height: 0 }, { width: 100, height: 0 }, { width: 800, height: 600 }], 3)).toEqual([
      false,
      false,
      true,
    ]);
  });

  test("spreads 构建直接消费元数据判定（宽页占整组，不靠解码后重建）", () => {
    expect(buildSpreads(3, widePagesFromMeta(meta, 3), "double")).toEqual([[0], [1, 2]]);
    expect(buildSpreads(3, widePagesFromMeta(null, 3), "double")).toEqual([[0, 1], [2]]);
  });
});

describe("v2.5 maxWidthForStage（大页降采样上限）", () => {
  test("显示宽*1.5*DPR 后按 256 分桶；非法宽返回 null", () => {
    expect(maxWidthForStage(0, 2)).toBeNull();
    expect(maxWidthForStage(800, 1)).toBe(Math.round((800 * 1.5) / 256) * 256); // 1200 → 1280
    expect(maxWidthForStage(800, 2)).toBe(Math.round((800 * 3) / 256) * 256); // 2400 → 2304
    // 同桶内的小幅宽度变化不换档（窗口拖拽/锁定切栏不触发整窗重取）
    const a = maxWidthForStage(800, 1);
    const b = maxWidthForStage(830, 1);
    expect(a).toBe(b);
  });
});
