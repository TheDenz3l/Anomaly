import { ConvexError, v } from "convex/values";
import { mutation } from "./_generated/server";
import { requireUser } from "./lib/auth";

/** Image uploads (PRD §3.10): client downscales, uploads to storage, then registers ownership. */

export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    await requireUser(ctx);
    return await ctx.storage.generateUploadUrl();
  },
});

const MAX_BYTES = 8 * 1024 * 1024;

export const register = mutation({
  args: {
    storageId: v.id("_storage"),
    width: v.optional(v.number()),
    height: v.optional(v.number()),
  },
  handler: async (ctx, { storageId, width, height }) => {
    const userId = await requireUser(ctx);
    const meta = await ctx.db.system.get(storageId);
    if (!meta) throw new ConvexError("Upload not found.");
    const mime = meta.contentType ?? "application/octet-stream";
    if (!/^(image\/(png|jpe?g|webp|gif|heic|heif)|audio\/)/.test(mime)) {
      await ctx.storage.delete(storageId);
      throw new ConvexError("Only images and audio can be attached.");
    }
    if (meta.size > MAX_BYTES) {
      await ctx.storage.delete(storageId);
      throw new ConvexError("That file is over 8 MB. Downscale it before uploading.");
    }
    const existing = await ctx.db
      .query("attachments")
      .withIndex("by_storage", (q) => q.eq("storageId", storageId))
      .first();
    if (existing) {
      if (existing.userId !== userId) throw new ConvexError("Upload not found.");
      return { storageId, mime };
    }
    await ctx.db.insert("attachments", { userId, storageId, mime, width, height });
    return { storageId, mime, url: await ctx.storage.getUrl(storageId) };
  },
});
