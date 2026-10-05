import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import type { Endpoint } from "../ai/openai";
import { decryptSecret } from "./crypto";

/** Decrypts a provider's key and headers inside an action. Never call from a query. */
export async function endpointFor(
  ctx: ActionCtx,
  userId: Id<"users">,
  providerId: string
): Promise<Endpoint | null> {
  const p = await ctx.runQuery(internal.providers.getInternal, { userId, providerId });
  if (!p) return null;
  return {
    baseUrl: p.baseUrl,
    apiKey: p.keyCipher ? await decryptSecret(p.keyCipher) : undefined,
    headers: p.headersCipher
      ? (JSON.parse(await decryptSecret(p.headersCipher)) as Endpoint["headers"])
      : [],
  };
}
