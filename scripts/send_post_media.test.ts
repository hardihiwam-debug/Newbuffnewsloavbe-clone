// Tests for the sendPost() media-kind decision tree — imports the REAL
// chooseDeliveryMode() from the pipeline shared module (not a mirror).
//
// What's asserted:
//   - real photo (kind=photo) → photo path
//   - real video               → video path
//   - video_thumb WITHOUT a real .mp4 → NO photo (text-only)
//   - video_thumb WITH a recovered .mp4 → video path
//   - text-only post          → text path

import { test, expect } from "bun:test";
import { chooseDeliveryMode, formatMessage, type Post } from "../supabase/functions/pipeline/_shared.ts";

const basePost: Post = {
  headline: "Iran fires missiles at Tel Aviv overnight",
  summary: "Iran's IRGC launched a wave of ballistic missiles toward Israeli cities, IDF confirms strikes hit two suburban districts.",
  sourceName: "@insiderpaper",
  url: "https://t.me/insiderpaper/12345",
  imageUrl: null,
  videoUrl: null,
  originalPublishedAt: "2026-08-15T01:23:00Z",
  breaking: false,
  timezone: "Asia/Baghdad",
  extraSources: [],
};

test("real photo + photo kind → photo mode", () => {
  expect(chooseDeliveryMode({ ...basePost, imageUrl: "https://cdn.telesco.pe/photo.jpg" }, "photo")).toBe("photo");
});

test("web article with image + null kind → photo mode (no media_kind on RSS/NewsData)", () => {
  const webPost: Post = {
    ...basePost,
    sourceName: "Reuters",
    url: "https://www.reuters.com/world/middle-east/story",
    imageUrl: "https://www.reuters.com/img/story.jpg",
  };
  expect(chooseDeliveryMode(webPost, null)).toBe("photo");
});

test("video_thumb without videoUrl → text mode (no fake photo)", () => {
  expect(chooseDeliveryMode({ ...basePost, imageUrl: "https://cdn.telesco.pe/thumb.jpg" }, "video_thumb")).toBe("text");
});

test("video_thumb with recovered videoUrl → video mode", () => {
  expect(chooseDeliveryMode(
    { ...basePost, imageUrl: "https://cdn.telesco.pe/thumb.jpg", videoUrl: "https://api.telegram.org/file/botXXX/video.mp4" },
    "video_thumb",
  )).toBe("video");
});

test("text-only post → text mode", () => {
  expect(chooseDeliveryMode(basePost, null)).toBe("text");
});

test("real video beats any mediaKind label", () => {
  expect(chooseDeliveryMode({ ...basePost, videoUrl: "https://x/v.mp4", imageUrl: "https://x/thumb.jpg" }, "video_thumb")).toBe("video");
});

test("formatMessage supports a Telegram-post body that has no headline line", () => {
  const out = formatMessage({ ...basePost, headline: "", summary: "Telegram post body only — no headline above it." });
  expect(out).not.toContain("<b>");
  expect(out).toContain("Telegram post body only");
});
