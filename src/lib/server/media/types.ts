export interface MediaRecord {
  id: string;
  filename: string;
  r2Key: string;
  mimeType: string;
  size: number;
  width: number | null;
  height: number | null;
  altText: string | null;
  /** v1.7: parent folder id, or null for root. */
  folderId: string | null;
  uploadedBy: string | null;
  createdAt: string;
}

export interface MediaUploadInput {
  filename: string;
  mimeType: string;
  data: ArrayBuffer;
  altText?: string;
  uploadedBy?: string;
  folderId?: string | null;
}

/** A folder in the media library tree (v1.7). */
export interface MediaFolderRecord {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: string;
}

export interface MediaListFilter {
  /** When provided, restrict results to that folder. `null` means root. */
  folderId?: string | null;
}

export interface MediaService {
  get(id: string): Promise<MediaRecord | null>;
  list(filter?: MediaListFilter): Promise<MediaRecord[]>;
  upload(input: MediaUploadInput): Promise<MediaRecord>;
  delete(id: string): Promise<void>;
  /** Move a media record to a different folder, or to the root (null). */
  move(id: string, folderId: string | null): Promise<MediaRecord>;
  getPublicUrl(r2Key: string): string;
  getFile(r2Key: string): Promise<ReadableStream | null>;

  // ─── Folders (v1.7) ────────────────────────────────────
  listFolders(): Promise<MediaFolderRecord[]>;
  createFolder(input: {
    name: string;
    parentId?: string | null;
  }): Promise<MediaFolderRecord>;
  renameFolder(id: string, name: string): Promise<MediaFolderRecord>;
  /**
   * Delete a folder. Children (sub-folders + media) detach to root —
   * never silently lose assets. Documented as the safe behavior.
   */
  deleteFolder(id: string): Promise<void>;
}
