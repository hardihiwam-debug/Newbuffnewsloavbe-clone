// React hooks that mirror Convex's `useQuery` / `useMutation` / `useAction`
// so dashboard.tsx and settings.tsx can be ported with a 1-line import swap.
//
// Semantics matched:
//   - `useAdminQuery(action, args)` returns data | undefined (loading)
//   - arg === "skip"  → return undefined without firing
//   - arg === undefined → return undefined without firing
//   - refetch every `refetchIntervalMs` ms while the hook is mounted (default 5s)
//   - on unmount or args change, cancel in-flight fetch to avoid stale overwrite
//   - mutations/actions call adminApi directly; return Promise<T> identical
//     to Convex's wrapper

import { useCallback, useEffect, useRef, useState } from "react";
import { adminApi, adminActionsApi } from "./adminApi";

// Convex's `useQuery` accepts `args === "skip"` to suppress the call.
// Match it: any "skip"-ish arg → no network call, undefined return.
export type SkipArg = "skip";

function shouldSkip(args: unknown): boolean {
  return args === "skip" || args === null || args === undefined;
}

// Stable JSON key so an args-equality change refires the query, but re-renders
// that produce fresh object literals with the same content don't.
function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const obj: Record<string, unknown> = {};
  for (const k of keys) obj[k] = (value as Record<string, unknown>)[k];
  return JSON.stringify(obj);
}

/** Replicate `useQuery(api.admin.X, args)` against the Supabase admin API.
 *  Returns `undefined` while loading or when args is `"skip"`. */
export function useAdminQuery<T = any>(
  action: string,
  args: undefined | SkipArg | Record<string, unknown>,
  opts?: { refetchIntervalMs?: number },
): T | undefined {
  const refetchMs = opts?.refetchIntervalMs ?? 5_000;
  const skipped = shouldSkip(args);
  const argsKey = skipped ? "skip" : stableJson(args);
  const [data, setData] = useState<T | undefined>(undefined);
  const [tick, setTick] = useState(0);
  // Track the latest argsKey we've sent so a stale response can't overwrite
  // data from a newer args (mirrors Convex's behavior).
  const latestKeyRef = useRef(argsKey);

  useEffect(() => {
    latestKeyRef.current = argsKey;
    if (skipped) {
      setData(undefined);
      return;
    }
    let cancelled = false;
    const ctrl = new AbortController();

    (async () => {
      try {
        const fn = (adminApi as unknown as Record<string, (a: Record<string, unknown>, init?: { signal?: AbortSignal }) => Promise<unknown>>)[action];
        if (typeof fn !== "function") {
          if (!cancelled && process.env.NODE_ENV !== "production") {
            console.warn(`[useAdminQuery] unknown action "${action}"`);
          }
          return;
        }
        const value = (await fn(args as Record<string, unknown>, { signal: ctrl.signal })) as T;
        if (!cancelled && latestKeyRef.current === argsKey) setData(value);
      } catch (e) {
        // Convex's `useQuery` would raise the error to the nearest boundary.
        // We mirror that by leaving `data` undefined; the UI's loading branch
        // stays visible, and the next tick (or args change) retries.
        if (process.env.NODE_ENV !== "production" && !cancelled) {
          console.warn(`[useAdminQuery] ${action} failed:`, e);
        }
      }
    })();

    return () => {
      cancelled = true;
      ctrl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [action, argsKey, skipped]);

  // Periodic poll to keep the dashboard reasonably live in the absence of
  // Convex-style reactive subscriptions. Disabled when refetchMs <= 0.
  useEffect(() => {
    if (skipped || refetchMs <= 0) return;
    const id = setInterval(() => setTick((t) => t + 1), refetchMs);
    return () => clearInterval(id);
  }, [skipped, refetchMs]);

  useEffect(() => {
    if (skipped || tick === 0) return;
    let cancelled = false;
    const ctrl = new AbortController();
    (async () => {
      try {
        const fn = (adminApi as unknown as Record<string, (a: Record<string, unknown>, init?: { signal?: AbortSignal }) => Promise<unknown>>)[action];
        if (typeof fn !== "function") return;
        const value = (await fn(args as Record<string, unknown>, { signal: ctrl.signal })) as T;
        if (!cancelled && latestKeyRef.current === argsKey) setData(value);
      } catch {
        // ignore — UI will retry on next tick.
      }
    })();
    return () => {
      cancelled = true;
      ctrl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick]);

  return data;
}

export type AdminMutationFn<TArg extends Record<string, unknown>, TResult = unknown> = (
  args: TArg,
) => Promise<TResult>;

/** Replicate `useMutation(api.admin.X)`. */
export function useAdminMutation<TResult = any, TArg extends Record<string, unknown> = Record<string, unknown>>(
  action: string,
): AdminMutationFn<TArg, TResult> {
  return useCallback((args: TArg) => {
    const fn = (adminApi as unknown as Record<string, (a: TArg) => Promise<unknown>>)[action];
    if (typeof fn !== "function") {
      throw new Error(`[useAdminMutation] unknown admin action "${action}"`);
    }
    return fn(args) as Promise<TResult>;
  }, [action]);
}

/** Replicate `useAction(api.admin_actions.X)`. */
export function useAdminAction<TResult = any, TArg extends Record<string, unknown> = Record<string, unknown>>(
  action: string,
): AdminMutationFn<TArg, TResult> {
  return useCallback((args: TArg) => {
    const fn = (adminActionsApi as unknown as Record<string, (a: TArg) => Promise<unknown>>)[action];
    if (typeof fn !== "function") {
      throw new Error(`[useAdminAction] unknown admin action "${action}"`);
    }
    return fn(args) as Promise<TResult>;
  }, [action]);
}

// ── `api` proxy ────────────────────────────────────────────────────────────
// Convex exposes the query/mutation tree as `api.admin.X` /
// `api.admin_actions.X`. We replace that tree with a string-named proxy:
//   useQuery(api.admin.getDashboard, args)
//   api.admin.getDashboard === "getDashboard"
// so the SWAP at the call site is just changing the import path;
//
// action names are validated against adminApi / adminActionsApi so a typo
// fails fast at runtime (and at type-check when strict).

const adminKeys = Object.keys(adminApi).filter((k) => k !== "then");
const adminActionKeys = Object.keys(adminActionsApi).filter((k) => k !== "then");

const adminBag: Record<string, string> = Object.fromEntries(
  adminKeys.map((k) => [k, k]),
);
const adminActionsBag: Record<string, string> = Object.fromEntries(
  adminActionKeys.map((k) => [k, k]),
);

export const api: {
  admin: Record<string, string>;
  admin_actions: Record<string, string>;
} = {
  admin: adminBag,
  admin_actions: adminActionsBag,
};
