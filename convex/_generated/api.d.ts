/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as agents from "../agents.js";
import type * as ai_anthropic from "../ai/anthropic.js";
import type * as ai_balance from "../ai/balance.js";
import type * as ai_blocks from "../ai/blocks.js";
import type * as ai_catalog from "../ai/catalog.js";
import type * as ai_decisions from "../ai/decisions.js";
import type * as ai_jev from "../ai/jev.js";
import type * as ai_openai from "../ai/openai.js";
import type * as ai_reasoning from "../ai/reasoning.js";
import type * as ai_registry from "../ai/registry.js";
import type * as attachments from "../attachments.js";
import type * as auth from "../auth.js";
import type * as chat from "../chat.js";
import type * as crons from "../crons.js";
import type * as data_geo from "../data/geo.js";
import type * as data_movies from "../data/movies.js";
import type * as data_weather from "../data/weather.js";
import type * as decisionLog from "../decisionLog.js";
import type * as engine_agents from "../engine/agents.js";
import type * as engine_context from "../engine/context.js";
import type * as engine_data from "../engine/data.js";
import type * as engine_finish from "../engine/finish.js";
import type * as engine_history from "../engine/history.js";
import type * as engine_loop from "../engine/loop.js";
import type * as engine_memory from "../engine/memory.js";
import type * as engine_prompt from "../engine/prompt.js";
import type * as engine_research from "../engine/research.js";
import type * as engine_tools from "../engine/tools.js";
import type * as engine_turn from "../engine/turn.js";
import type * as engine_writer from "../engine/writer.js";
import type * as evals from "../evals.js";
import type * as http from "../http.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_crypto from "../lib/crypto.js";
import type * as lib_endpoint from "../lib/endpoint.js";
import type * as lib_messages from "../lib/messages.js";
import type * as lib_partialJson from "../lib/partialJson.js";
import type * as lib_settings from "../lib/settings.js";
import type * as lib_util from "../lib/util.js";
import type * as lib_validators from "../lib/validators.js";
import type * as lib_vectors from "../lib/vectors.js";
import type * as links from "../links.js";
import type * as memories from "../memories.js";
import type * as messages from "../messages.js";
import type * as models from "../models.js";
import type * as notifications from "../notifications.js";
import type * as probes from "../probes.js";
import type * as providers from "../providers.js";
import type * as research from "../research.js";
import type * as settings from "../settings.js";
import type * as threads from "../threads.js";
import type * as users from "../users.js";
import type * as voice from "../voice.js";
import type * as web_access from "../web/access.js";
import type * as web_cache from "../web/cache.js";
import type * as web_exa from "../web/exa.js";
import type * as web_firecrawl from "../web/firecrawl.js";
import type * as web_guard from "../web/guard.js";
import type * as web_providers from "../web/providers.js";
import type * as web_read from "../web/read.js";
import type * as web_relevance from "../web/relevance.js";
import type * as web_sources from "../web/sources.js";
import type * as webCache from "../webCache.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  agents: typeof agents;
  "ai/anthropic": typeof ai_anthropic;
  "ai/balance": typeof ai_balance;
  "ai/blocks": typeof ai_blocks;
  "ai/catalog": typeof ai_catalog;
  "ai/decisions": typeof ai_decisions;
  "ai/jev": typeof ai_jev;
  "ai/openai": typeof ai_openai;
  "ai/reasoning": typeof ai_reasoning;
  "ai/registry": typeof ai_registry;
  attachments: typeof attachments;
  auth: typeof auth;
  chat: typeof chat;
  crons: typeof crons;
  "data/geo": typeof data_geo;
  "data/movies": typeof data_movies;
  "data/weather": typeof data_weather;
  decisionLog: typeof decisionLog;
  "engine/agents": typeof engine_agents;
  "engine/context": typeof engine_context;
  "engine/data": typeof engine_data;
  "engine/finish": typeof engine_finish;
  "engine/history": typeof engine_history;
  "engine/loop": typeof engine_loop;
  "engine/memory": typeof engine_memory;
  "engine/prompt": typeof engine_prompt;
  "engine/research": typeof engine_research;
  "engine/tools": typeof engine_tools;
  "engine/turn": typeof engine_turn;
  "engine/writer": typeof engine_writer;
  evals: typeof evals;
  http: typeof http;
  "lib/auth": typeof lib_auth;
  "lib/crypto": typeof lib_crypto;
  "lib/endpoint": typeof lib_endpoint;
  "lib/messages": typeof lib_messages;
  "lib/partialJson": typeof lib_partialJson;
  "lib/settings": typeof lib_settings;
  "lib/util": typeof lib_util;
  "lib/validators": typeof lib_validators;
  "lib/vectors": typeof lib_vectors;
  links: typeof links;
  memories: typeof memories;
  messages: typeof messages;
  models: typeof models;
  notifications: typeof notifications;
  probes: typeof probes;
  providers: typeof providers;
  research: typeof research;
  settings: typeof settings;
  threads: typeof threads;
  users: typeof users;
  voice: typeof voice;
  "web/access": typeof web_access;
  "web/cache": typeof web_cache;
  "web/exa": typeof web_exa;
  "web/firecrawl": typeof web_firecrawl;
  "web/guard": typeof web_guard;
  "web/providers": typeof web_providers;
  "web/read": typeof web_read;
  "web/relevance": typeof web_relevance;
  "web/sources": typeof web_sources;
  webCache: typeof webCache;
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
