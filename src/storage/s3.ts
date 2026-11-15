import {
  S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand,
  CreateMultipartUploadCommand, UploadPartCommand, ListPartsCommand,
  CompleteMultipartUploadCommand, AbortMultipartUploadCommand, DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { ClientFile } from "../domain.js";
import type { FileStorage } from "./interface.js";
const missing = (error: unknown) => typeof error === "object" && error !== null && "name" in error && ["NotFound", "NoSuchKey", "NoSuchUpload"].includes(String(error.name));
export class S3FileStorage implements FileStorage {
  readonly client: S3Client;
  constructor(private config: { endpoint: string; region: string; bucket: string; forcePathStyle?: boolean }) {
    this.client = new S3Client({ endpoint: config.endpoint, region: config.region, forcePathStyle: config.forcePathStyle ?? false,
      requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED",
      maxAttempts: 3,
    }); // AWS credential provider chain: environment / IAM role. Never browser credentials.
  }
  private object(file: ClientFile) { return { Bucket: this.config.bucket, Key: file.key }; }
  private metadata(file: ClientFile) { return { ContentType: file.contentType, CacheControl: "private, no-store", Metadata: { "file-id": file.id } }; }
  async signPut(file: ClientFile, expiresIn: number) {
    const command = new PutObjectCommand({ ...this.object(file), ...this.metadata(file), ContentLength: file.size, IfNoneMatch: "*" });
    const url = await getSignedUrl(this.client, command, { expiresIn, signableHeaders: new Set(["content-type", "content-length", "if-none-match"]) });
    return { url, headers: { "Content-Type": file.contentType, "If-None-Match": "*", "Cache-Control": "private, no-store" }, expiresIn };
  }
  async startMultipart(file: ClientFile) {
    const result = await this.client.send(new CreateMultipartUploadCommand({ ...this.object(file), ...this.metadata(file) }));
    if (!result.UploadId) throw new Error("S3 did not return upload ID");
    return result.UploadId;
  }
  async signPart(file: ClientFile, partNumber: number, size: number, expiresIn: number) {
    const url = await getSignedUrl(this.client, new UploadPartCommand({ ...this.object(file), UploadId: file.uploadId!, PartNumber: partNumber, ContentLength: size }), { expiresIn, signableHeaders: new Set(["content-length"]) });
    return { url, headers: {}, expiresIn };
  }
  async listParts(file: ClientFile) {
    const result = await this.client.send(new ListPartsCommand({ ...this.object(file), UploadId: file.uploadId! }));
    if (result.IsTruncated) throw new Error("Too many upload parts");
    return (result.Parts ?? []).map(p => ({ partNumber: p.PartNumber!, etag: p.ETag!, size: p.Size! }));
  }
  async completeMultipart(file: ClientFile, parts: { partNumber: number; etag: string }[]) {
    await this.client.send(new CompleteMultipartUploadCommand({ ...this.object(file), UploadId: file.uploadId!, IfNoneMatch: "*", MultipartUpload: { Parts: parts.map(p => ({ PartNumber: p.partNumber, ETag: p.etag })) } }));
  }
  async head(file: ClientFile) {
    try {
      const result = await this.client.send(new HeadObjectCommand(this.object(file)));
      return { size: result.ContentLength ?? -1, contentType: result.ContentType ?? "", etag: result.ETag ?? "" };
    } catch (error) { if (missing(error)) return undefined; throw error; }
  }
  async prefix(file: ClientFile, etag: string) {
    const result = await this.client.send(new GetObjectCommand({ ...this.object(file), Range: "bytes=0-4095", IfMatch: etag }));
    return result.Body ? result.Body.transformToByteArray() : new Uint8Array();
  }
  async signView(file: ClientFile, expiresIn: number) {
    // Content type is validated server-side before ready. Never serve arbitrary HTML/SVG.
    return getSignedUrl(this.client, new GetObjectCommand({ ...this.object(file), ResponseContentType: file.contentType, ResponseCacheControl: "private, no-store", ResponseContentDisposition: `inline; filename*=UTF-8''${encodeURIComponent(file.name)}` }), { expiresIn });
  }
  async abort(file: ClientFile) {
    if (!file.uploadId) return;
    try { await this.client.send(new AbortMultipartUploadCommand({ ...this.object(file), UploadId: file.uploadId })); }
    catch (error) { if (!missing(error)) throw error; }
  }
  async remove(file: ClientFile) { await this.client.send(new DeleteObjectCommand(this.object(file))); }
}
