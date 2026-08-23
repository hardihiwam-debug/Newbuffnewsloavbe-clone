// Pure client half of state-hash conditional polling (egress fast-win).
//
// The server answers unchanged polls with a ~100-byte envelope instead of the
// full payload:
//   { __unchanged: true, __fingerprint: "<string>" }   → keep previous data
//   { ...data, __fingerprint: "<string>" }             → replace data
// A plain (non-enveloped) response means the action does not participate in
// state-hash polling — pass the value through untouched.
//
// Extracted from the useAdminQuery hook so the envelope contract is
// unit-testable without a React renderer.

export type StatefulEnvelopeResult<T> = {
  /** The data to store (undefined on `__unchanged` — keep previous). */
  data: T | undefined;
  /** The fingerprint to remember for the next poll (undefined = none). */
  fingerprint: string | undefined;
  /** True when the response carried the stateful envelope. */
  enveloped: boolean;
  /** True when the server said nothing changed. */
  unchanged: boolean;
};

export function applyStatefulEnvelope<T>(value: unknown): StatefulEnvelopeResult<T> {
  const v = value as Record<string, unknown> | null | undefined;
  if (!v || typeof v !== "object" || !("__fingerprint" in v)) {
    return { data: value as T, fingerprint: undefined, enveloped: false, unchanged: false };
  }
  // Only strings can round-trip through ifState; a non-string fingerprint
  // (legacy/object) is treated as absent so the next poll refetches.
  const fp = typeof v.__fingerprint === "string" ? v.__fingerprint : undefined;
  if (v.__unchanged === true) {
    return { data: undefined, fingerprint: fp, enveloped: true, unchanged: true };
  }
  const { __fingerprint: _f, __unchanged: _u, ...rest } = v;
  return { data: rest as T, fingerprint: fp, enveloped: true, unchanged: false };
}
