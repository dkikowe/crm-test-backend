import { randomUUID } from "node:crypto";
import type { ClientFile, User } from "../domain.js";
import type { Repositories } from "../repositories/interfaces.js";
import type { FileStorage } from "../storage/interface.js";
import { beginFileSchema, completeFileSchema, matchesSignature, MiB } from "../storage/validation.js";
import { CrmService } from "./crm.js";
import { AppError } from "../errors.js";
export const UPLOAD_SECONDS = 300;
export const VIEW_SECONDS = 900;
export const PART_SIZE = 8 * MiB;
const publicFile = ({ id, clientId, ownerId, uploadedBy, name, description, type, size, contentType, createdAt, status }: ClientFile) => ({ id, clientId, ownerId, uploadedBy, name, description, type, size, contentType, createdAt, status });
const invalid = (message: string) => new AppError(400, "INVALID_FILE", message);
export class FileService {
  private crm: CrmService;
  constructor(private repos: Repositories, private storage?: FileStorage) { this.crm = new CrmService(repos); }
  private s3() {
    if (!this.storage) throw new AppError(503, "STORAGE_NOT_CONFIGURED", "Хранилище файлов пока не настроено. Укажите S3_ENDPOINT, S3_REGION, S3_BUCKET и ключи доступа на сервере.");
    return this.storage;
  }
  private async accessible(clientId: string, id: string, user: User) {
    await this.crm.get("clients", clientId, user);
    const file = await this.repos.files.findById(id);
    if (!file || file.clientId !== clientId) throw new AppError(404, "NOT_FOUND", "Файл не найден или недоступен.");
    return file;
  }
  private uploadTime(file: ClientFile) {
    if (file.status !== "uploading" || file.uploadExpiresAt.getTime() <= Date.now()) throw new AppError(409, "UPLOAD_CLOSED", "Загрузка завершена, отменена или истекла. Начните новую загрузку.");
    return Math.max(1, Math.min(UPLOAD_SECONDS, Math.floor((file.uploadExpiresAt.getTime() - Date.now()) / 1000)));
  }
  async list(clientId: string, user: User) {
    await this.crm.get("clients", clientId, user);
    return (await this.repos.files.findAll()).filter(f => f.clientId === clientId && !["aborted", "failed"].includes(f.status)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(publicFile);
  }
  async begin(clientId: string, input: unknown, user: User) {
    const data = beginFileSchema.parse(input);
    // Authorize before touching storage or creating a remote upload.
    await this.crm.get("clients", clientId, user);
    const storage = this.s3();
    let file = await this.repos.transaction(async () => {
      const client = await this.crm.get("clients", clientId, user);
      const pending = (await this.repos.files.findAll()).filter(f => f.uploadedBy === user.id && ["uploading", "completing"].includes(f.status) && f.uploadExpiresAt.getTime() > Date.now());
      if (pending.length >= 10) throw new AppError(429, "UPLOAD_LIMIT", "Завершите или отмените предыдущие загрузки (не более 10 одновременно).");
      const id = randomUUID();
      return this.repos.files.create({ ...data, id, clientId, ownerId: client.ownerId, uploadedBy: user.id,
        key: `clients/${clientId}/${data.type}/${id}`, status: "uploading", uploadId: null,
        createdAt: new Date().toISOString(), uploadExpiresAt: new Date(Date.now() + 24 * 3600000), leaseUntil: null, etag: null,
      });
    });
    let remoteUpload: ClientFile | undefined;
    try {
      if (file.type === "video") {
        const uploadId = await storage.startMultipart(file);
        remoteUpload = { ...file, uploadId };
        file = await this.repos.transaction(async () => {
          const current = await this.accessible(clientId, file.id, user);
          this.uploadTime(current);
          return (await this.repos.files.update(file.id, { uploadId }))!;
        });
      }
      return { file: publicFile(file), multipart: file.type === "video", partSize: PART_SIZE, partCount: Math.ceil(file.size / PART_SIZE) };
    } catch (error) {
      if (remoteUpload) {
        try { await storage.abort(remoteUpload); } catch { /* Bucket lifecycle also expires orphaned multipart uploads. */ }
      }
      await this.repos.files.update(file.id, { status: "failed" }); throw error;
    }
  }
  async uploadUrl(clientId: string, id: string, user: User) {
    const file = await this.accessible(clientId, id, user);
    const ttl = this.uploadTime(file);
    if (file.type === "video") throw invalid("Для видео используйте загрузку по частям.");
    return this.s3().signPut(file, ttl);
  }
  async partUrl(clientId: string, id: string, partNumber: number, user: User) {
    const file = await this.accessible(clientId, id, user);
    const ttl = this.uploadTime(file);
    const count = Math.ceil(file.size / PART_SIZE);
    if (file.type !== "video" || !file.uploadId || !Number.isInteger(partNumber) || partNumber < 1 || partNumber > count) throw invalid("Недопустимый номер части.");
    return this.s3().signPart(file, partNumber, Math.min(PART_SIZE, file.size - (partNumber - 1) * PART_SIZE), ttl);
  }
  async complete(clientId: string, id: string, input: unknown, user: User) {
    const { parts } = completeFileSchema.parse(input);
    const file = await this.repos.transaction(async () => {
      const row = await this.accessible(clientId, id, user);
      if (row.status === "ready") return row;
      if (row.status === "completing" && row.leaseUntil && row.leaseUntil.getTime() > Date.now()) throw new AppError(409, "UPLOAD_BUSY", "Файл уже проверяется. Повторите через несколько секунд.");
      if (!["uploading", "completing"].includes(row.status) || row.uploadExpiresAt.getTime() <= Date.now()) throw new AppError(409, "UPLOAD_CLOSED", "Загрузка закрыта.");
      return (await this.repos.files.update(id, { status: "completing", leaseUntil: new Date(Date.now() + 120000) }))!;
    });
    if (file.status === "ready") return publicFile(file);
    const storage = this.s3();
    try {
      // A previous attempt may have completed S3 but lost its HTTP/DB response.
      let object = await storage.head(file);
      if (!object && file.type === "video") {
        const expectedCount = Math.ceil(file.size / PART_SIZE);
        if (parts.length !== expectedCount || parts.some((p, i) => p.partNumber !== i + 1)) throw invalid("Передайте все части видео по порядку, без повторов.");
        const uploaded = await storage.listParts(file);
        if (uploaded.length !== expectedCount || uploaded.some((part, i) => part.partNumber !== i + 1 || part.etag !== parts[i]?.etag || part.size !== Math.min(PART_SIZE, file.size - i * PART_SIZE))) throw invalid("Части видео не совпадают с заявленным размером или ETag. Повторите загрузку.");
        await storage.completeMultipart(file, parts);
        object = await storage.head(file);
      }
      if (!object) throw invalid("Файл ещё не загружен в хранилище.");
      if (object.size !== file.size || object.contentType !== file.contentType || !matchesSignature(file.contentType, await storage.prefix(file, object.etag))) {
        await this.repos.files.update(id, { status: "failed", leaseUntil: null });
        await storage.abort(file); await storage.remove(file);
        throw invalid("Размер или содержимое файла не соответствует выбранному формату.");
      }
      return this.repos.transaction(async () => {
        const current = await this.accessible(clientId, id, user);
        if (current.status !== "completing" || current.leaseUntil?.getTime() !== file.leaseUntil?.getTime()) throw new AppError(409, "UPLOAD_CHANGED", "Состояние загрузки изменилось.");
        return publicFile((await this.repos.files.update(id, { status: "ready", etag: object.etag, leaseUntil: null }))!);
      });
    } catch (error) {
      await this.repos.transaction(async () => {
        const current = await this.repos.files.findById(id);
        if (current?.status === "completing" && current.leaseUntil?.getTime() === file.leaseUntil?.getTime()) await this.repos.files.update(id, { status: "uploading", leaseUntil: null });
      });
      throw error;
    }
  }
  async view(clientId: string, id: string, user: User) {
    const file = await this.accessible(clientId, id, user);
    if (file.status !== "ready") throw new AppError(409, "FILE_NOT_READY", "Файл ещё не готов к просмотру.");
    return { url: await this.s3().signView(file, VIEW_SECONDS), expiresIn: VIEW_SECONDS };
  }
  async abort(clientId: string, id: string, user: User) {
    const file = await this.repos.transaction(async () => {
      const current = await this.accessible(clientId, id, user);
      if (current.status === "ready") throw new AppError(409, "UPLOAD_CLOSED", "Файл уже сохранён.");
      if (current.status === "completing" && current.leaseUntil && current.leaseUntil.getTime() > Date.now()) throw new AppError(409, "UPLOAD_BUSY", "Подождите завершения проверки файла.");
      return (await this.repos.files.update(id, { status: "aborted", leaseUntil: null }))!;
    });
    await this.s3().abort(file); await this.s3().remove(file);
    // Keep the tombstone until all possible issued links have expired, then sweep.
  }
  async cleanupExpired() {
    if (!this.storage) return;
    for (const file of await this.repos.files.findAll()) {
      if (file.status === "ready" || file.uploadExpiresAt.getTime() > Date.now() || (file.leaseUntil?.getTime() ?? 0) > Date.now()) continue;
      try { await this.storage.abort(file); await this.storage.remove(file); await this.repos.files.delete(file.id); }
      catch { console.warn("Не удалось очистить незавершённую загрузку", { fileId: file.id }); }
    }
  }
}
