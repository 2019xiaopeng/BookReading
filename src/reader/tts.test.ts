import { describe, expect, test } from "vitest";

import { pickChineseVoice, splitParagraphs } from "./tts";

// node 环境不 mock speechSynthesis：只测纯逻辑（段落切分与声音挑选），浏览器行为靠 WebView 实测。

describe("TTS 纯逻辑", () => {
  test("splitParagraphs：按换行切、去空白段、trim 段内空白", () => {
    expect(splitParagraphs("第一段\n\n第二段\n第三段")).toEqual(["第一段", "第二段", "第三段"]);
    expect(splitParagraphs("  \n\n  hello world  \n\n\n")).toEqual(["hello world"]);
    expect(splitParagraphs("   ")).toEqual([]);
    expect(splitParagraphs("")).toEqual([]);
  });

  test("pickChineseVoice：zh-CN 优先，其次任意 zh，无中文回 null", () => {
    const voices = [
      { lang: "en-US", name: "English" },
      { lang: "zh-TW", name: "TW" },
      { lang: "zh-CN", name: "CN" },
    ];
    expect(pickChineseVoice(voices)?.name).toBe("CN");
    expect(pickChineseVoice([{ lang: "zh_TW" }, { lang: "en-US" }])?.lang).toBe("zh_TW");
    expect(pickChineseVoice([{ lang: "en-US" }])).toBeNull();
    expect(pickChineseVoice([])).toBeNull();
  });

  test("pickChineseVoice：lang 大小写不敏感", () => {
    expect(pickChineseVoice([{ lang: "ZH-cn" }, { lang: "zh-HK" }])?.lang).toBe("ZH-cn");
  });
});
