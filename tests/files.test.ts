import { test } from "node:test";
import assert from "node:assert/strict";
import type { ClientFile, User } from "../src/domain.js";
import { createRepositories } from "../src/repositories/memory.js";
import { FileService, PART_SIZE } from "../src/services/files.js";
import { CrmService } from "../src/services/crm.js";
import type { FileStorage, ObjectInfo, StoredPart } from "../src/storage/interface.js";
import { beginFileSchema, matchesSignature, MiB } from "../src/storage/validation.js";
import { S3FileStorage } from "../src/storage/s3.js";
import { createApp } from "../src/app.js";
import { tokenHash, newToken } from "../src/security/passwords.js";

// Storage double is test-only: runtime always uses real S3, never a memory fallback.
class TestStorage implements FileStorage {
  objects = new Map<string, ObjectInfo>(); prefixes = new Map<string, Uint8Array>();
  parts: StoredPart[] = []; calls: string[] = []; expiries: number[] = [];
  async signPut(f: ClientFile, ttl: number) { this.calls.push(`put:${f.key}`); this.expiries.push(ttl); return { url: "https://storage.invalid/put", headers: {}, expiresIn: ttl }; }
  async startMultipart() { this.calls.push("start"); return "upload-1"; }
  async signPart(f: ClientFile, n: number, size: number, ttl: number) { this.calls.push(`part:${n}:${size}`); this.expiries.push(ttl); return { url: "https://storage.invalid/part", headers: {}, expiresIn: ttl }; }
  async listParts() { return this.parts; }
  async completeMultipart(f: ClientFile) { this.calls.push("complete"); this.objects.set(f.id, { size: f.size, contentType: f.contentType, etag: '"etag"' }); this.prefixes.set(f.id, Buffer.from([0,0,0,24,...Buffer.from("ftypmp42"),0,0,0,0])); }
  async head(f: ClientFile) { return this.objects.get(f.id); }
  async prefix(f: ClientFile) { return this.prefixes.get(f.id) ?? new Uint8Array(); }
  async signView(f: ClientFile, ttl: number) { this.calls.push(`view:${f.id}`); this.expiries.push(ttl); return "https://storage.invalid/view"; }
  async abort(f: ClientFile) { this.calls.push(`abort:${f.id}`); }
  async remove(f: ClientFile) { this.calls.push(`delete:${f.id}`); this.objects.delete(f.id); }
}
const manager: User = { id: "manager", name: "Manager", email: "m@example.com", role: "manager", createdAt: new Date().toISOString() };
const other = { ...manager, id: "other" }, admin = { ...manager, id: "admin", role: "admin" as const }, rop = { ...manager, id: "rop", role: "rop" as const };
const jpeg = { type: "photo", name: "photo.jpg", contentType: "image/jpeg", size: 100, description: "Photo" };
async function setup() {
  const repos = createRepositories(), storage = new TestStorage(), files = new FileService(repos, storage);
  for (const user of [manager, other, admin, rop]) await repos.users.create({ ...user, passwordHash: "unused-test-hash" });
  await repos.clients.create({ id: "client", ownerId: manager.id, name: "Client", company: "Company", email: "client@example.com", phone: "123", city: "City", source: "Сайт", notes: "", stage: "new", createdAt: new Date().toISOString() });
  await repos.clients.create({ id: "foreign-client", ownerId: other.id, name: "Foreign", company: "Company", email: "f@example.com", phone: "123", city: "City", source: "Сайт", notes: "", stage: "new", createdAt: new Date().toISOString() });
  return { repos, storage, files };
}
test("file type, byte limits, name and container signatures", () => {
  for (const [type, contentType, max] of [["audio", "audio/ogg", 20], ["audio", "audio/mpeg", 20], ["photo", "image/jpeg", 10], ["photo", "image/png", 10], ["photo", "image/webp", 10], ["video", "video/mp4", 500]] as const) {
    assert(beginFileSchema.safeParse({ ...jpeg, type, contentType, size: max * MiB }).success);
    assert(!beginFileSchema.safeParse({ ...jpeg, type, contentType, size: max * MiB + 1 }).success);
  }
  for (const patch of [{ size: 0 }, { size: 1.5 }, { name: "../image.jpg" }, { type: "audio" }, { contentType: "image/svg+xml" }, { ownerId: "admin" }]) assert(!beginFileSchema.safeParse({ ...jpeg, ...patch }).success);
  assert(matchesSignature("image/jpeg", new Uint8Array([255,216,255])));
  assert(matchesSignature("audio/ogg", Buffer.from("OggS....OpusHead")));
  assert(!matchesSignature("audio/ogg", Buffer.from("OggS....theora")));
  assert(matchesSignature("image/png", Buffer.from([137,80,78,71,13,10,26,10])));
  assert(matchesSignature("image/webp", Buffer.from("RIFF0000WEBP")));
  assert(matchesSignature("audio/mpeg", Buffer.from("ID3")));
  assert(!matchesSignature("image/jpeg", Buffer.from("<html>")));
});
test("every signed URL checks client ownership and stored file/client association", async () => {
  const { files, repos, storage } = await setup();
  const started = await files.begin("client", jpeg, rop);
  const file = (await repos.files.findById(started.file.id))!;
  assert.equal(file.ownerId, manager.id); assert.equal(file.uploadedBy, rop.id);
  assert.match(file.key, /^clients\/client\/photo\/[a-f0-9-]{36}$/);
  const before = storage.calls.length;
  for (const action of [() => files.begin("client", jpeg, other), () => files.list("client", other), () => files.uploadUrl("client", file.id, other), () => files.partUrl("client", file.id, 1, other), () => files.complete("client", file.id, {}, other), () => files.view("client", file.id, other), () => files.abort("client", file.id, other), () => files.view("foreign-client", file.id, other)]) await assert.rejects(action(), { status: 404 });
  assert.equal(storage.calls.length, before);
  await files.uploadUrl("client", file.id, manager); assert.equal(storage.expiries.at(-1), 300);
  await assert.rejects(files.view("client", file.id, manager), { status: 409 });
  await assert.rejects(files.partUrl("client", file.id, 1, manager), { status: 400 });
  storage.objects.set(file.id, { size: 100, contentType: "image/jpeg", etag: '"photo"' }); storage.prefixes.set(file.id, new Uint8Array([255,216,255]));
  assert.equal((await files.complete("client", file.id, {}, manager)).status, "ready");
  assert.equal((await files.complete("client", file.id, {}, admin)).status, "ready");
  await files.view("client", file.id, rop); assert.equal(storage.expiries.at(-1), 900);
  assert.equal((await files.list("client", manager))[0]!.description, "Photo");
  assert.equal("key" in (await files.list("client", manager))[0]!, false);
  await assert.rejects(files.uploadUrl("client", file.id, manager), { status: 409 });
  await assert.rejects(new CrmService(repos).deleteClient("client", admin), { status: 409 });
  await assert.rejects(new CrmService(repos).update("clients", "client", { ownerId: other.id }, admin), { status: 409 });
});
test("untrusted uploaded size, MIME and magic are rejected before viewing", async () => {
  for (const mode of ["size", "mime", "magic"] as const) {
    const { files, repos, storage } = await setup(); const start = await files.begin("client", jpeg, manager); const f = (await repos.files.findById(start.file.id))!;
    storage.objects.set(f.id, { size: mode === "size" ? 101 : 100, contentType: mode === "mime" ? "text/html" : "image/jpeg", etag: '"bad"' });
    storage.prefixes.set(f.id, mode === "magic" ? Buffer.from("<script>") : new Uint8Array([255,216,255]));
    await assert.rejects(files.complete("client", f.id, {}, manager), { status: 400 });
    assert.equal((await repos.files.findById(f.id))!.status, "failed"); assert.equal(storage.objects.has(f.id), false);
    await assert.rejects(files.view("client", f.id, manager), { status: 409 });
  }
});
test("video multipart validates every part size, number and ETag; completion retries are safe", async () => {
  const { files, repos, storage } = await setup();
  const start = await files.begin("client", { type: "video", name: "movie.mp4", contentType: "video/mp4", size: PART_SIZE + 100 }, manager); const f = (await repos.files.findById(start.file.id))!;
  assert.equal(start.multipart, true); assert.equal(start.partCount, 2);
  await files.partUrl("client", f.id, 2, manager); assert.equal(storage.calls.at(-1), "part:2:100");
  for (const n of [0, 3, 1.5]) await assert.rejects(files.partUrl("client", f.id, n, manager), { status: 400 });
  await assert.rejects(files.uploadUrl("client", f.id, manager), { status: 400 });
  const parts = [{ partNumber: 1, etag: '"p1"' }, { partNumber: 2, etag: '"p2"' }];
  await assert.rejects(files.complete("client", f.id, { parts: [parts[0], parts[0]] }, manager), { status: 400 });
  storage.parts = parts.map((p, i) => ({ ...p, size: i ? 99 : PART_SIZE }));
  await assert.rejects(files.complete("client", f.id, { parts }, manager), { status: 400 });
  storage.parts[1]!.size = 100;
  assert.equal((await files.complete("client", f.id, { parts }, manager)).status, "ready");
  assert.equal((await files.complete("client", f.id, { parts }, manager)).status, "ready");
  assert.equal(storage.calls.filter(c => c === "complete").length, 1);
});
test("abort and expiration prevent new URLs; cleanup never deletes ready objects", async () => {
  const { files, repos, storage } = await setup(); const start = await files.begin("client", jpeg, manager);
  await files.abort("client", start.file.id, manager);
  await assert.rejects(files.uploadUrl("client", start.file.id, manager), { status: 409 });
  await repos.files.update(start.file.id, { uploadExpiresAt: new Date(0) });
  const next = await files.begin("client", jpeg, manager); await repos.files.update(next.file.id, { status: "ready", uploadExpiresAt: new Date(0) });
  await files.cleanupExpired(); assert.equal(await repos.files.findById(start.file.id), undefined); assert(await repos.files.findById(next.file.id));
  assert(storage.calls.includes(`delete:${start.file.id}`)); assert(!storage.calls.includes(`delete:${next.file.id}`));
});
test("S3 signing uses configured endpoint, region, fixed TTL and signed byte length", async () => {
  const { repos, files } = await setup(); const created = await files.begin("client", jpeg, manager); const file = (await repos.files.findById(created.file.id))!;
  const s3 = new S3FileStorage({ endpoint: "https://s3.ap-southeast-2.amazonaws.com", region: "ap-southeast-2", bucket: "test-bucket" });
  // Isolated signing test; credentials here are deliberately nonfunctional.
  Object.assign(s3.client.config, { credentials: async () => ({ accessKeyId: "TEST_ONLY_KEY", secretAccessKey: "TEST_ONLY_SECRET" }) });
  const result = await s3.signPut(file, 300), url = new URL(result.url);
  assert.equal(url.searchParams.get("X-Amz-Expires"), "300");
  assert(url.searchParams.get("X-Amz-Credential")!.includes("/ap-southeast-2/s3/"));
  for (const header of ["content-type", "content-length", "if-none-match"]) assert(url.searchParams.get("X-Amz-SignedHeaders")!.split(";").includes(header));
  assert.equal(result.headers["If-None-Match"], "*");
  assert.equal(new URL(await s3.signView(file, 900)).searchParams.get("X-Amz-Expires"), "900");
});
test("HTTP routes require a session and CSRF header; unavailable S3 returns actionable error", async () => {
  const { repos } = await setup(); const token = newToken(); await repos.sessions.create({ id: tokenHash(token), userId: manager.id, expiresAt: new Date(Date.now() + 60000) });
  const server = createApp("http://localhost:3000", repos).listen(0, "127.0.0.1"); await new Promise<void>(r => server.once("listening", r));
  const a = server.address(); assert(a && typeof a !== "string"); const base = `http://127.0.0.1:${a.port}/clients/client/files`;
  try {
    assert.equal((await fetch(base)).status, 401);
    assert.equal((await fetch(base, { method: "POST", headers: { Cookie: `salespace_session=${token}`, "Content-Type": "application/json" }, body: JSON.stringify(jpeg) })).status, 403);
    const result = await fetch(base, { method: "POST", headers: { Cookie: `salespace_session=${token}`, "Content-Type": "application/json", "X-CRM-Request": "1" }, body: JSON.stringify(jpeg) });
    assert.equal(result.status, 503); assert.equal((await result.json()).error.code, "STORAGE_NOT_CONFIGURED");
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
});
