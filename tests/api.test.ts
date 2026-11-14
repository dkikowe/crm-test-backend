import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";
import { createRepositories } from "../src/repositories/memory.js";
import { AuthService } from "../src/services/auth.js";
import { newToken, tokenHash } from "../src/security/passwords.js";
const password = "A long test password 123!";
const client = { name: "Client for test", company: "Test", email: "client@example.com", phone: "123456789", city: "Test" };

test("Authentication and CRM authorization end to end", { timeout: 120000 }, async t => {
  const repos = createRepositories();
  const server = createApp("https://crm.example.com", repos).listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address(); assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  async function request(path: string, method = "GET", body?: unknown, cookie = "", extra: Record<string, string> = {}) {
    const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json", "X-CRM-Request": "1", Cookie: cookie, ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, headers: res.headers, body: res.status === 204 ? null : await res.json(), cookie: res.headers.get("set-cookie")?.split(";")[0] ?? "" };
  }
  let adminCookie = "", managerCookie = "", ropCookie = "", adminId = "", managerId = "", ropId = "", clientId = "";
  try {
    await t.test("anonymous and forged demo headers cannot access data", async () => {
      for (const path of ["/users", "/clients", "/deals", "/tasks", "/stats", "/auth/me"]) assert.equal((await request(path, "GET", undefined, "", { "X-User-Id": "u-admin" })).status, 401);
      assert.equal((await request("/auth/register", "POST", { email: "bad@example.com", name: "Test", password, role: "admin" })).status, 400);
      assert.equal((await request("/auth/register", "POST", { email: "bad@example.com", name: "Test", password: "123" })).status, 400);
    });
    await t.test("admin requires single-use email-bound invitation; passwords are hashed", async () => {
      const token = newToken();
      await repos.invites.create({ id: tokenHash(token), email: "admin@example.com", role: "admin", expiresAt: new Date(Date.now() + 60000) });
      assert.equal((await request("/auth/register", "POST", { email: "admin@example.com", name: "Admin", password })).status, 403);
      assert.equal((await request("/auth/register", "POST", { email: "other@example.com", name: "Other", password, inviteToken: token })).status, 400);
      const admin = await request("/auth/register", "POST", { email: "ADMIN@example.com", name: "Admin", password, inviteToken: token });
      assert.equal(admin.status, 201); assert.equal(admin.body.role, "admin"); assert.equal(admin.body.passwordHash, undefined);
      adminCookie = admin.cookie; adminId = admin.body.id;
      assert.match(admin.headers.get("set-cookie")!, /HttpOnly/); assert.match(admin.headers.get("set-cookie")!, /Secure/); assert.match(admin.headers.get("set-cookie")!, /SameSite=Lax/);
      assert.equal(await repos.invites.findById(tokenHash(token)), undefined);
      const stored = await repos.users.findById(adminId); assert.match(stored!.passwordHash, /^scrypt\$131072\$8\$1\$/); assert(!stored!.passwordHash.includes(password));
      assert.equal((await repos.sessions.findAll())[0]!.id, tokenHash(admin.cookie.split("=")[1]!));
      const manager = await request("/auth/register", "POST", { email: "manager@example.com", name: "Manager", password });
      assert.equal(manager.status, 201); assert.equal(manager.body.role, "manager"); managerCookie = manager.cookie; managerId = manager.body.id;
      assert.notEqual((await repos.users.findById(managerId))!.passwordHash, stored!.passwordHash);
      const rop = await request("/auth/register", "POST", { email: "rop@example.com", name: "Rop", password }); ropId = rop.body.id;
      assert.equal((await request(`/users/${ropId}/role`, "PATCH", { role: "rop" }, managerCookie)).status, 403);
      assert.equal((await request(`/users/${ropId}/role`, "PATCH", { role: "rop" }, adminCookie)).status, 200);
      assert.equal((await request("/auth/me", "GET", undefined, rop.cookie)).status, 401);
      ropCookie = (await request("/auth/login", "POST", { email: "rop@example.com", password })).cookie;
    });
    await t.test("empty database has truthful zero stats, managers see only own records", async () => {
      assert.equal((await request("/stats", "GET", undefined, adminCookie)).body.pipelineAmount, 0);
      assert.equal((await request("/clients", "GET", undefined, adminCookie)).body.length, 0);
      const created = await request("/clients", "POST", client, managerCookie); assert.equal(created.status, 201); clientId = created.body.id;
      assert.equal(created.body.ownerId, managerId);
      assert.equal((await request("/users", "GET", undefined, managerCookie)).body.length, 1);
      await request("/clients", "POST", { ...client, name: "Admin client" }, adminCookie);
      assert.equal((await request("/clients", "GET", undefined, managerCookie)).body.length, 1);
      assert.equal((await request("/clients", "GET", undefined, ropCookie)).body.length, 2);
      const adminClient = (await request("/clients", "GET", undefined, adminCookie)).body.find((c: { ownerId: string }) => c.ownerId === adminId);
      assert.equal((await request(`/clients/${adminClient.id}`, "GET", undefined, managerCookie)).status, 404);
      assert.equal((await request(`/clients/${adminClient.id}`, "PATCH", { name: "Hacked" }, managerCookie)).status, 404);
      assert.equal((await request("/clients", "POST", { ...client, ownerId: adminId }, managerCookie)).status, 403);
      const deal = await request("/deals", "POST", { title: "Actual test deal", clientId, amount: 123.45 }, managerCookie); assert.equal(deal.status, 201);
      const moved = await request(`/deals/${deal.body.id}`, "PATCH", { stage: "payment" }, managerCookie); assert.equal(moved.body.amount, 123.45);
      assert.equal((await request("/stats", "GET", undefined, managerCookie)).body.pipelineAmount, 123.45);
      assert.equal((await request(`/clients/${clientId}`, "DELETE", undefined, managerCookie)).status, 409);
      assert.equal((await request(`/clients/${clientId}`, "PATCH", { ownerId: adminId }, adminCookie)).status, 409);
      assert.equal((await request("/tasks", "POST", { title: "Mismatched", clientId, dueDate: "2026-12-01" }, adminCookie)).status, 400);
      const task = await request("/tasks", "POST", { title: "Task", dueDate: "2026-12-01" }, managerCookie); assert.equal(task.status, 201);
      assert.equal((await request(`/tasks/${task.body.id}`, "PATCH", { completed: true }, managerCookie)).body.completed, true);
    });
    await t.test("only admin changes roles; last admin cannot be removed", async () => {
      assert.equal((await request(`/users/${managerId}/role`, "PATCH", { role: "admin" }, ropCookie)).status, 403);
      assert.equal((await request(`/users/${adminId}/role`, "PATCH", { role: "manager" }, adminCookie)).status, 409);
      assert.equal((await request("/users", "GET", undefined, adminCookie)).body.some((u: unknown) => JSON.stringify(u).includes("passwordHash")), false);
    });
    await t.test("CSRF, origin, login errors and session expiration are enforced", async () => {
      assert.equal((await request("/clients", "POST", client, managerCookie, { "X-CRM-Request": "" })).status, 403);
      assert.equal((await request("/auth/logout", "POST", undefined, managerCookie, { Origin: "https://evil.example" })).status, 403);
      assert.equal((await request("/auth/login", "POST", { email: "manager@example.com", password: "wrong password" })).status, 401);
      assert.equal((await request("/auth/login", "POST", { email: "missing@example.com", password })).status, 401);
      const expired = newToken(); await repos.sessions.create({ id: tokenHash(expired), userId: managerId, expiresAt: new Date(0) });
      assert.equal((await request("/auth/me", "GET", undefined, `__Host-salespace=${expired}`)).status, 401);
    });
    await t.test("password change revokes all sessions, new login works and logout is final", async () => {
      assert.equal((await request("/auth/password", "POST", { oldPassword: "incorrect", newPassword: password + "new" }, managerCookie)).status, 400);
      assert.equal((await request("/auth/password", "POST", { oldPassword: password, newPassword: password + "new" }, managerCookie)).status, 204);
      assert.equal((await request("/auth/me", "GET", undefined, managerCookie)).status, 401);
      assert.equal((await request("/auth/login", "POST", { email: "manager@example.com", password })).status, 401);
      const signed = await request("/auth/login", "POST", { email: "manager@example.com", password: password + "new" }); assert.equal(signed.status, 200);
      assert.equal((await request("/auth/logout", "POST", undefined, signed.cookie)).status, 204);
      assert.equal((await request("/clients", "GET", undefined, signed.cookie)).status, 401);
    });
    await t.test("rate limits persist in repository", async () => {
      const a = new AuthService(repos), b = new AuthService(repos);
      await a.throttle("test", 1); await assert.rejects(b.throttle("test", 1), { status: 429 });
    });
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});


test("private bootstrap invitation allows one chosen email only once", async () => {
  const repos = createRepositories(), auth = new AuthService(repos), token = newToken();
  await repos.invites.create({ id: tokenHash(token), email: null, role: "admin", expiresAt: new Date(Date.now() + 60000) });
  await assert.rejects(auth.register({ name: "Invalid", email: "invalid@example.com", password, inviteToken: newToken() }), { status: 400 });
  const admin = await auth.register({ name: "Chosen", email: "chosen@example.com", password, inviteToken: token });
  assert.equal(admin.user.role, "admin");
  await assert.rejects(auth.register({ name: "Replay", email: "replay@example.com", password, inviteToken: token }), { status: 400 });
  const expired = newToken();
  await repos.invites.create({ id: tokenHash(expired), email: null, role: "admin", expiresAt: new Date(0) });
  await assert.rejects(auth.register({ name: "Expired", email: "expired@example.com", password, inviteToken: expired }), { status: 400 });
});
