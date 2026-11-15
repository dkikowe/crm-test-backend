import "dotenv/config";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { connectStorage } from "../src/database/connection.js";
import { AuthService } from "../src/services/auth.js";
import { CrmService } from "../src/services/crm.js";
import { FileService } from "../src/services/files.js";
import type { ClientFile } from "../src/domain.js";
import { newToken, tokenHash } from "../src/security/passwords.js";

test("MongoDB: migration, authentication, persistence and transactions", { skip: process.env.RUN_MONGODB_TESTS !== "true", timeout: 240000 }, async t => {
  const uri = process.env.MONGODB_URI; assert(uri);
  const databaseName = `salespace_test_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  let storage: Awaited<ReturnType<typeof connectStorage>> | undefined;
  const raw = await mongoose.createConnection(uri, { dbName: databaseName }).asPromise();
  const payload = { name: "Actual client", company: "Company", email: "test@example.com", phone: "123456789", city: "City", stage: "new" as const, source: "Сайт", notes: "" };
  try {
    // A legacy database with a seed ID plus a UUID record entered by a person.
    await raw.db!.collection("clients").insertMany([
      { _id: "c-1" as never, ...payload, ownerId: "u-admin", createdAt: new Date().toISOString() },
      { _id: "real-client" as never, ...payload, ownerId: "u-admin", createdAt: new Date().toISOString() },
    ]);
    await raw.db!.collection("users").insertOne({ _id: "u-admin" as never, name: "Old demo", role: "admin" });
    storage = await connectStorage(uri, databaseName);
    await t.test("migration archives only seed IDs and is idempotent", async () => {
      assert.equal((await storage!.repositories.users.findAll()).length, 0);
      assert.deepEqual((await storage!.repositories.clients.findAll()).map(c => c.id), ["real-client"]);
      assert.equal(await raw.db!.collection("_legacy_demo_archive").countDocuments(), 2);
      await storage!.close(); storage = await connectStorage(uri, databaseName);
      assert.equal(await raw.db!.collection("_legacy_demo_archive").countDocuments(), 2);
    });
    const invite = newToken();
    await storage.repositories.invites.create({ id: tokenHash(invite), email: "admin@example.com", role: "admin", expiresAt: new Date(Date.now() + 60000) });
    const auth = new AuthService(storage.repositories);
    const admin = await auth.register({ name: "Admin", email: "admin@example.com", password: "Secure test password 1!", inviteToken: invite });
    const manager = await auth.register({ name: "Manager", email: "manager@example.com", password: "Secure test password 2!" });
    let crm = new CrmService(storage.repositories);
    await t.test("real legacy client transfers to admin and never leaks to manager", async () => {
      assert.equal((await crm.get("clients", "real-client", admin.user)).ownerId, admin.user.id);
      assert.equal((await crm.list("clients", manager.user)).length, 0);
      await assert.rejects(crm.get("clients", "real-client", manager.user), { status: 404 });
    });
    const client = await crm.create("clients", payload, manager.user);
    await t.test("rollback and concurrent writes preserve relationships", async () => {
      await assert.rejects(storage!.repositories.transaction(async () => { await storage!.repositories.clients.update(client.id, { notes: "rollback" }); throw new Error("rollback"); }));
      assert.equal((await crm.get("clients", client.id, manager.user)).notes, "");
      const results = await Promise.allSettled([
        crm.deleteClient(client.id, manager.user),
        crm.create("deals", { title: "Real deal", clientId: client.id, amount: 50, stage: "new" }, manager.user),
      ]);
      assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
      const parent = await storage!.repositories.clients.findById(client.id);
      const linked = (await storage!.repositories.deals.findAll()).filter(d => d.clientId === client.id);
      assert.equal(linked.length, parent ? 1 : 0);
    });
    await t.test("unique emails reject concurrent registration", async () => {
      const results = await Promise.allSettled([1, 2].map(() => auth.register({ name: "Unique", email: "unique@example.com", password: "Secure unique password!" })));
      assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
      assert.equal((await storage!.repositories.users.findAll()).filter(u => u.email === "unique@example.com").length, 1);
    });
    await t.test("file metadata persists in files with dates, ownership and unique keys", async () => {
      const record: ClientFile = { id: randomUUID(), clientId: "real-client", ownerId: admin.user.id, uploadedBy: admin.user.id, name: "integration.png", description: "MongoDB integration test", type: "photo", contentType: "image/png", size: 67, key: `clients/real-client/photo/${randomUUID()}`, status: "ready", uploadId: null, uploadExpiresAt: new Date(Date.now() + 86400000), leaseUntil: null, etag: "test-etag", createdAt: new Date().toISOString() };
      await storage!.repositories.files.create(record);
      await storage!.close(); storage = await connectStorage(uri, databaseName);
      const stored = await storage.repositories.files.findById(record.id);
      assert.equal(stored?.ownerId, admin.user.id);
      assert(stored?.uploadExpiresAt instanceof Date);
      assert.equal(await raw.db!.collection("files").countDocuments(), 1);
      await assert.rejects(storage.repositories.files.create({ ...record, id: randomUUID() }), { code: 11000 });
      const files = new FileService(storage.repositories);
      assert.equal((await files.list("real-client", admin.user)).length, 1);
      await assert.rejects(files.list("real-client", manager.user), { status: 404 });
      await assert.rejects(new CrmService(storage.repositories).deleteClient("real-client", admin.user), { status: 409 });
    });
    await t.test("session and password survive reconnect; logout remains revoked", async () => {
      await storage!.close(); storage = await connectStorage(uri, databaseName); crm = new CrmService(storage.repositories);
      const nextAuth = new AuthService(storage.repositories);
      assert.equal((await nextAuth.current(admin.token))?.id, admin.user.id);
      const login = await nextAuth.login("manager@example.com", "Secure test password 2!");
      assert.equal(login.user.id, manager.user.id);
      await nextAuth.logout(login.token);
      assert.equal(await nextAuth.current(login.token), undefined);
      await nextAuth.throttle("persistent", 1);
      await storage!.close(); storage = await connectStorage(uri, databaseName);
      await assert.rejects(new AuthService(storage.repositories).throttle("persistent", 1), { status: 429 });
      assert.equal(await storage.isHealthy(), true);
      await storage.close(); assert.equal(await storage.isHealthy(), false);
    });
  } finally {
    await storage?.close();
    assert.match(databaseName, /^salespace_test_[a-f0-9]{16}$/);
    await raw.dropDatabase(); await raw.close();
  }
});
