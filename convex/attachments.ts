import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation, internalQuery, mutation } from "./_generated/server";
import { requireUser } from "./lib/auth";

/**
 * Uploads (PRD §3.10): the client uploads to storage, then registers ownership. Photos the model
 * can see go in as images; anything else is a file whose text convex/files.ts reads right away,
 * so it's ready by the time the reply needs it.
 */

export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    await requireUser(ctx);
    return await ctx.storage.generateUploadUrl();
  },
});

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const PHOTO = /^image\/(png|jpe?g|webp|gif|heic|heif)$/;

export const register = mutation({
  args: {
    storageId: v.id("_storage"),
    width: v.optional(v.number()),
    height: v.optional(v.number()),
    /** The file's name; files carry one, photos from the library don't. */
    name: v.optional(v.string()),
    /** The type the picker reported, when the upload's own is generic. */
    mime: v.optional(v.string()),
  },
  handler: async (ctx, { storageId, width, height, name, mime: given }) => {
    const userId = await requireUser(ctx);
    // Ownership first: nobody else's registered upload can be inspected or deleted through here.
    const existing = await ctx.db
      .query("attachments")
      .withIndex("by_storage", (q) => q.eq("storageId", storageId))
      .first();
    if (existing) {
      if (existing.userId !== userId) throw new ConvexError("Upload not found.");
      return { storageId, mime: existing.mime, kind: existing.kind ?? "image" };
    }
    const meta = await ctx.db.system.get(storageId);
    if (!meta) throw new ConvexError("Upload not found.");
    const stored = meta.contentType ?? "";
    const mime = (
      stored && stored !== "application/octet-stream"
        ? stored
        : given || stored || "application/octet-stream"
    ).toLowerCase();
    const kind = PHOTO.test(mime) && meta.size <= MAX_IMAGE_BYTES ? "image" : "file";
    if (kind === "file" && meta.size > MAX_FILE_BYTES) {
      await ctx.storage.delete(storageId);
      throw new ConvexError("That file is over 25 MB.");
    }
    const fileName = (name ?? "").trim().slice(0, 200) || (kind === "file" ? "File" : undefined);
    await ctx.db.insert("attachments", {
      userId,
      storageId,
      mime,
      width,
      height,
      kind,
      name: fileName,
      size: meta.size,
      ...(kind === "file" ? { extract: "pending" as const } : {}),
    });
    if (kind === "file") await ctx.scheduler.runAfter(0, internal.files.extract, { storageId });
    return { storageId, mime, kind };
  },
});

export const byStorage = internalQuery({
  args: { storageId: v.id("_storage") },
  handler: async (ctx, { storageId }) =>
    await ctx.db
      .query("attachments")
      .withIndex("by_storage", (q) => q.eq("storageId", storageId))
      .first(),
});

export const setExtract = internalMutation({
  args: {
    storageId: v.id("_storage"),
    extract: v.union(
      v.literal("ok"),
      v.literal("empty"),
      v.literal("unsupported"),
      v.literal("error")
    ),
    textStorageId: v.optional(v.id("_storage")),
    textChars: v.optional(v.number()),
    pages: v.optional(v.number()),
    note: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    const row = await ctx.db
      .query("attachments")
      .withIndex("by_storage", (q) => q.eq("storageId", a.storageId))
      .first();
    // A second read that lost the race (the turn and the scheduled read both ran) drops its copy.
    if (!row || (row.extract && row.extract !== "pending")) {
      if (a.textStorageId) await ctx.storage.delete(a.textStorageId);
      return;
    }
    await ctx.db.patch(row._id, {
      extract: a.extract,
      textStorageId: a.textStorageId,
      textChars: a.textChars,
      pages: a.pages,
      extractNote: a.note,
    });
  },
});
