import { test, expect } from "bun:test";
import {
  classifySourceTrust,
  derivePipelineControlCenter,
} from "../supabase/functions/admin/_shared.ts";

test("classifies a productive source as trusted", () => {
  const result = classifySourceTrust({
    name: "Reliable wire",
    published_count: 12,
    rejected_count: 2,
    enabled: true,
  });

  expect(result.status).toBe("trusted");
  expect(result.acceptanceRate).toBe(86);
  expect(result.usefulArticles).toBe(12);
  expect(result.unavailableMetrics).toContain("translationFailureRate");
  expect(result.translationFailureRate).toBeNull();
});

test("classifies a source with repeated health or editorial failures as degraded", () => {
  const result = classifySourceTrust({
    name: "Noisy feed",
    published_count: 3,
    rejected_count: 12,
    consecutive_failures: 3,
    consecutive_rejects: 4,
    enabled: true,
  });

  expect(result.status).toBe("degraded");
  expect(result.fetchFailures).toBe(3);
  expect(result.rejectStreak).toBe(4);
  expect(result.acceptanceRate).toBe(20);
});

test("classifies auto-paused sources as temporarily muted", () => {
  const result = classifySourceTrust({
    name: "Muted feed",
    enabled: false,
    auto_paused: true,
    consecutive_failures: 8,
  });

  expect(result.status).toBe("temporarily_muted");
  expect(result.autoPaused).toBe(true);
});

test("keeps low-volume sources normal instead of overstating trust", () => {
  const result = classifySourceTrust({
    name: "New feed",
    published_count: 2,
    rejected_count: 0,
  });

  expect(result.status).toBe("normal");
  expect(result.acceptanceRate).toBe(100);
});

test("stops every control-center stage while paused", () => {
  const result = derivePipelineControlCenter({
    paused: true,
    lastIngestAt: "2026-08-23T09:00:00.000Z",
    lastPublishAt: "2026-08-23T09:05:00.000Z",
  });

  expect(result.stages).toEqual({
    ingest: "stopped",
    rewrite: "stopped",
    translation: "stopped",
    publish: "paused",
  });
});

test("reports active ingest rewrite and quota-limited translation", () => {
  const result = derivePipelineControlCenter({
    paused: false,
    pipelineRun: {
      action: "ingest",
      message: "Rewriting 1/2 batches...",
      done: false,
      at: "2026-08-23T09:05:00.000Z",
    },
    translationQuotaLimited: true,
    now: Date.parse("2026-08-23T09:05:10.000Z"),
  });

  expect(result.stages).toEqual({
    ingest: "running",
    rewrite: "running",
    translation: "quota-limited",
    publish: "waiting",
  });
});
