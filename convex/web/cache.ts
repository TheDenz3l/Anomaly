import { internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";

export type WebCache = {
  get(key: string): Promise<{ content: string; contentType: string } | null>;
  put(key: string, content: string, contentType: string, ttlMs: number): Promise<void>;
};

export function webCache(ctx: ActionCtx): WebCache {
  return {
    get: (key) => ctx.runQuery(internal.webCache.get, { key }),
    put: async (key, content, contentType, ttl) => {
      await ctx.runMutation(internal.webCache.put, { key, content, contentType, ttl });
    },
  };
}

export const HOUR = 3600_000;
