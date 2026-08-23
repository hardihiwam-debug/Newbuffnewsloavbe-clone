// Tests for the client half of state-hash conditional polling — imports the
// REAL applyStatefulEnvelope used by useAdminQuery, so this guards the exact
// shipped envelope handling: store the string fingerprint, keep previous data
// on `__unchanged`, and strip `__fingerprint`/`__unchanged` so the envelope
// never leaks into the shared store payload.
import { test, expect } from "bun:test";
import { applyStatefulEnvelope } from "../src/lib/stateEnvelope.ts";

test("full payload with fresh fingerprint → replace data, remember the fingerprint", () => {
  const r = applyStatefulEnvelope<{ queue: unknown[] }>({
    queue: [{ id: 1 }],
    __fingerprint: '{"queue":"39|2026-08-19T13:20:15Z"}',
  });
  expect(r.enveloped).toBe(true);
  expect(r.unchanged).toBe(false);
  expect(r.fingerprint).toBe('{"queue":"39|2026-08-19T13:20:15Z"}');
  expect(r.data).toEqual({ queue: [{ id: 1 }] }); // envelope stripped
});

test("__unchanged → keep previous data (data undefined), remember the echoed fingerprint", () => {
  const r = applyStatefulEnvelope<{ queue: unknown[] }>({
    __unchanged: true,
    __fingerprint: '{"queue":"39|2026-08-19T13:20:15Z"}',
  });
  expect(r.enveloped).toBe(true);
  expect(r.unchanged).toBe(true);
  expect(r.fingerprint).toBe('{"queue":"39|2026-08-19T13:20:15Z"}');
  expect(r.data).toBeUndefined();
});

test("non-enveloped responses pass through untouched (action not stateful)", () => {
  const r = applyStatefulEnvelope<{ entries: unknown[] }>({ entries: [{ a: 1 }] });
  expect(r.enveloped).toBe(false);
  expect(r.unchanged).toBe(false);
  expect(r.fingerprint).toBeUndefined();
  expect(r.data).toEqual({ entries: [{ a: 1 }] });
});

test("non-string (legacy object) fingerprint → treated as absent so the next poll refetches", () => {
  const r = applyStatefulEnvelope<Record<string, unknown>>({
    queue: [],
    __fingerprint: { bots: "1|x" }, // legacy shape — never sent by the fixed server
  });
  expect(r.enveloped).toBe(true);
  expect(r.fingerprint).toBeUndefined();
  expect(r.data).toEqual({ queue: [] });
});

test("null/undefined responses pass through without envelope handling", () => {
  expect(applyStatefulEnvelope(null).enveloped).toBe(false);
  expect(applyStatefulEnvelope(undefined).enveloped).toBe(false);
  expect(applyStatefulEnvelope("plain").data).toBe("plain");
});

test("empty-string fingerprint is kept (server may send empty count|max)", () => {
  const r = applyStatefulEnvelope<Record<string, unknown>>({
    __unchanged: true,
    __fingerprint: "",
  });
  expect(r.fingerprint).toBe("");
});
