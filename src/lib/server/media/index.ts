import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { eq, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import * as schema from "../content/schema";
import type {
  MediaService,
  MediaRecord,
  MediaUploadInput,
  MediaListFilter,
  MediaFolderRecord,
} from "./types";

export class R2MediaService implements MediaService {
  private db: DrizzleD1Database<typeof schema>;

  constructor(
    d1: D1Database,
    private bucket: R2Bucket,
    private publicBaseUrl: string, // e.g. https://cdn.example.com or /api/media
  ) {
    this.db = drizzle(d1, { schema });
  }

  async get(id: string): Promise<MediaRecord | null> {
    const row = await this.db
      .select()
      .from(schema.media)
      .where(eq(schema.media.id, id))
      .get();

    if (!row) return null;
    return this.toRecord(row);
  }

  async list(filter?: MediaListFilter): Promise<MediaRecord[]> {
    // folderId === undefined → list everything (legacy behavior used
    // by the dashboard counter and the article cover-image picker).
    // folderId === null      → root only (no parent).
    // folderId === '<id>'    → that folder only.
    if (filter?.folderId === undefined) {
      const rows = await this.db.select().from(schema.media).all();
      return rows.map((r) => this.toRecord(r));
    }
    const where =
      filter.folderId === null
        ? isNull(schema.media.folderId)
        : eq(schema.media.folderId, filter.folderId);
    const rows = await this.db.select().from(schema.media).where(where).all();
    return rows.map((r) => this.toRecord(r));
  }

  async upload(input: MediaUploadInput): Promise<MediaRecord> {
    const id = nanoid();
    const r2Key = `media/${id}/${input.filename}`;

    // Upload to R2
    await this.bucket.put(r2Key, input.data, {
      httpMetadata: { contentType: input.mimeType },
    });

    // Save metadata to D1
    await this.db.insert(schema.media).values({
      id,
      filename: input.filename,
      r2Key,
      mimeType: input.mimeType,
      size: input.data.byteLength,
      altText: input.altText ?? null,
      folderId: input.folderId ?? null,
      uploadedBy: input.uploadedBy ?? null,
    });

    return (await this.get(id))!;
  }

  async delete(id: string): Promise<void> {
    const record = await this.get(id);
    if (!record) return;

    // Delete from R2
    await this.bucket.delete(record.r2Key);

    // Delete from D1
    await this.db.delete(schema.media).where(eq(schema.media.id, id));
  }

  async move(id: string, folderId: string | null): Promise<MediaRecord> {
    await this.db
      .update(schema.media)
      .set({ folderId })
      .where(eq(schema.media.id, id));
    return (await this.get(id))!;
  }

  getPublicUrl(r2Key: string): string {
    return `${this.publicBaseUrl}/${r2Key}`;
  }

  async getFile(r2Key: string): Promise<ReadableStream | null> {
    const object = await this.bucket.get(r2Key);
    if (!object) return null;
    return object.body;
  }

  // ─── Folders (v1.7) ────────────────────────────────────

  async listFolders(): Promise<MediaFolderRecord[]> {
    const rows = await this.db.select().from(schema.mediaFolders).all();
    return rows.map((r) => this.toFolderRecord(r));
  }

  async createFolder(input: {
    name: string;
    parentId?: string | null;
  }): Promise<MediaFolderRecord> {
    const id = nanoid();
    await this.db.insert(schema.mediaFolders).values({
      id,
      name: input.name.trim(),
      parentId: input.parentId ?? null,
    });
    const row = await this.db
      .select()
      .from(schema.mediaFolders)
      .where(eq(schema.mediaFolders.id, id))
      .get();
    return this.toFolderRecord(row!);
  }

  async renameFolder(id: string, name: string): Promise<MediaFolderRecord> {
    await this.db
      .update(schema.mediaFolders)
      .set({ name: name.trim() })
      .where(eq(schema.mediaFolders.id, id));
    const row = await this.db
      .select()
      .from(schema.mediaFolders)
      .where(eq(schema.mediaFolders.id, id))
      .get();
    if (!row) throw new Error("Folder not found");
    return this.toFolderRecord(row);
  }

  async deleteFolder(id: string): Promise<void> {
    // Detach children (folders + media) to root before delete so we
    // never silently lose assets. Two updates + a delete; D1's lack
    // of a real ON DELETE SET NULL on a self-reference makes the
    // explicit version clearer anyway.
    await this.db
      .update(schema.mediaFolders)
      .set({ parentId: null })
      .where(eq(schema.mediaFolders.parentId, id));
    await this.db
      .update(schema.media)
      .set({ folderId: null })
      .where(eq(schema.media.folderId, id));
    await this.db
      .delete(schema.mediaFolders)
      .where(eq(schema.mediaFolders.id, id));
  }

  private toRecord(row: typeof schema.media.$inferSelect): MediaRecord {
    return {
      id: row.id,
      filename: row.filename,
      r2Key: row.r2Key,
      mimeType: row.mimeType,
      size: row.size,
      width: row.width,
      height: row.height,
      altText: row.altText,
      folderId: row.folderId,
      uploadedBy: row.uploadedBy,
      createdAt: row.createdAt,
    };
  }

  private toFolderRecord(
    row: typeof schema.mediaFolders.$inferSelect,
  ): MediaFolderRecord {
    return {
      id: row.id,
      name: row.name,
      parentId: row.parentId,
      createdAt: row.createdAt,
    };
  }
}
