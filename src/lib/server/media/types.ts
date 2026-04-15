export interface MediaRecord {
  id: string;
  filename: string;
  r2Key: string;
  mimeType: string;
  size: number;
  width: number | null;
  height: number | null;
  altText: string | null;
  uploadedBy: string | null;
  createdAt: string;
}

export interface MediaUploadInput {
  filename: string;
  mimeType: string;
  data: ArrayBuffer;
  altText?: string;
  uploadedBy?: string;
}

export interface MediaService {
  get(id: string): Promise<MediaRecord | null>;
  list(): Promise<MediaRecord[]>;
  upload(input: MediaUploadInput): Promise<MediaRecord>;
  delete(id: string): Promise<void>;
  getPublicUrl(r2Key: string): string;
  getFile(r2Key: string): Promise<ReadableStream | null>;
}
