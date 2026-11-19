import { describe, expect, test } from "vitest";

import { formatMediaSize, isVideoExt, mediaMimeFor } from "./MediaPanel";

describe("mediaMimeFor（V-1 扩展名 → MIME）", () => {
  test("B-1 剥离清单内的音视频扩展名", () => {
    expect(mediaMimeFor("mp4")).toBe("video/mp4");
    expect(mediaMimeFor("mp3")).toBe("audio/mpeg");
    expect(mediaMimeFor("m4a")).toBe("audio/mp4");
    expect(mediaMimeFor("ogg")).toBe("audio/ogg");
    expect(mediaMimeFor("wav")).toBe("audio/wav");
    expect(mediaMimeFor("avi")).toBe("video/x-msvideo");
  });

  test("大小写与点前缀归一；未知回 octet-stream", () => {
    expect(mediaMimeFor("MP4")).toBe("video/mp4");
    expect(mediaMimeFor(".mp3")).toBe("audio/mpeg");
    expect(mediaMimeFor("txt")).toBe("application/octet-stream");
    expect(mediaMimeFor("")).toBe("application/octet-stream");
  });
});

describe("isVideoExt（video/audio 元素分流）", () => {
  test("视频扩展名走 <video>，音频与未知走 <audio>", () => {
    expect(isVideoExt("mp4")).toBe(true);
    expect(isVideoExt("avi")).toBe(true);
    expect(isVideoExt("MP4")).toBe(true);
    expect(isVideoExt("mp3")).toBe(false);
    expect(isVideoExt("m4a")).toBe(false);
    expect(isVideoExt("txt")).toBe(false);
  });
});

describe("formatMediaSize", () => {
  test("MB 一位小数；非法/非正数回空串", () => {
    expect(formatMediaSize(28 * 1024 * 1024)).toBe("28.0 MB");
    expect(formatMediaSize(1024 * 1024 + 0.04 * 1024 * 1024)).toBe("1.0 MB");
    expect(formatMediaSize(0)).toBe("");
    expect(formatMediaSize(Number.NaN)).toBe("");
  });
});
