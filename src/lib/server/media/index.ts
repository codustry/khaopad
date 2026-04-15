import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import * as schema from "../content/schema";
import type { MediaService, MediaRecord, MediaUploadInput } from "./types";

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

  async list(): Promise<MediaRecord[]> {
    const rows = await this.db.select().from(schema.media).all();
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

  getPublicUrl(r2Key: string): string {
    return `${this.publicBaseUrl}/${r2Key}`;
  }

  async getFile(r2Key: string): Promise<ReadableStream | null> {
    const object = await this.bucket.get(r2Key);
    if (!object) return null;
    return object.body;
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
      uploadedBy: row.uploadedBy,
      createdAt: row.createdAt,
    };
  }
}
