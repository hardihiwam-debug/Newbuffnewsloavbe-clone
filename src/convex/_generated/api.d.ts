/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as admin from "../admin.js";
import type * as admin_actions from "../admin_actions.js";
import type * as auth from "../auth.js";
import type * as crons from "../crons.js";
import type * as db from "../db.js";
import type * as http from "../http.js";
import type * as pipeline from "../pipeline.js";
import type * as pipeline_ai from "../pipeline/ai.js";
import type * as pipeline_fetchers from "../pipeline/fetchers.js";
import type * as pipeline_filters from "../pipeline/filters.js";
import type * as pipeline_telegram from "../pipeline/telegram.js";
import type * as pipeline_telegram_channels from "../pipeline/telegram_channels.js";
import type * as pipeline_types from "../pipeline/types.js";
import type * as secrets from "../secrets.js";
import type * as seed from "../seed.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  admin: typeof admin;
  admin_actions: typeof admin_actions;
  auth: typeof auth;
  crons: typeof crons;
  db: typeof db;
  http: typeof http;
  pipeline: typeof pipeline;
  "pipeline/ai": typeof pipeline_ai;
  "pipeline/fetchers": typeof pipeline_fetchers;
  "pipeline/filters": typeof pipeline_filters;
  "pipeline/telegram": typeof pipeline_telegram;
  "pipeline/telegram_channels": typeof pipeline_telegram_channels;
  "pipeline/types": typeof pipeline_types;
  secrets: typeof secrets;
  seed: typeof seed;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
