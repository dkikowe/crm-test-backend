import type { ClientFile } from "../domain.js";
export interface SignedUpload { url: string; headers: Record<string, string>; expiresIn: number }
export interface StoredPart { partNumber: number; etag: string; size: number }
export interface ObjectInfo { size: number; contentType: string; etag: string }
export interface FileStorage {
  signPut(file: ClientFile, expiresIn: number): Promise<SignedUpload>;
  startMultipart(file: ClientFile): Promise<string>;
  signPart(file: ClientFile, partNumber: number, size: number, expiresIn: number): Promise<SignedUpload>;
  listParts(file: ClientFile): Promise<StoredPart[]>;
  completeMultipart(file: ClientFile, parts: { partNumber: number; etag: string }[]): Promise<void>;
  head(file: ClientFile): Promise<ObjectInfo | undefined>;
  prefix(file: ClientFile, etag: string): Promise<Uint8Array>;
  signView(file: ClientFile, expiresIn: number): Promise<string>;
  abort(file: ClientFile): Promise<void>;
  remove(file: ClientFile): Promise<void>;
}
