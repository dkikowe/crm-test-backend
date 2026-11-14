import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { createApp } from "../src/app.js";
import { createRepositories } from "../src/repositories/memory.js";
let server: Server;
let base: string;
before(async () => {
  server = createApp("http://localhost:3000", createRepositories()).listen(
    0,
    "127.0.0.1",
  );
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  base = `http://127.0.0.1:${address.port}`;
});
after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
async function request(
  path: string,
  user = "u-admin",
  method = "GET",
  body?: unknown,
  extraHeaders: Record<string, string> = {},
) {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(user ? { "X-User-Id": user } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...extraHeaders,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: response.status,
    headers: response.headers,
    body: response.status === 204 ? null : await response.json(),
  };
}
const clientPayload = {
  name: "Тестовый клиент",
  company: "ТОО «Тест»",
  email: "test@example.kz",
  phone: "+7 701 123 45 67",
  city: "Алматы",
};
test("health and demo users are public; business data requires a known user", async () => {
  assert.equal((await request("/health", "")).status, 200);
  const users = await request("/users", "");
  assert.equal(users.body.length, 3);
  assert.deepEqual(
    users.body.map((u: { role: string }) => u.role),
    ["admin", "rop", "manager"],
  );
  assert.equal((await request("/clients", "")).status, 401);
  assert.equal((await request("/clients", "unknown")).status, 401);
});
test("seed counts and manager visibility", async () => {
  for (const [path, total, own] of [
    ["clients", 15, 5],
    ["deals", 12, 4],
    ["tasks", 10, 3],
  ] as const) {
    assert.equal((await request(`/${path}`)).body.length, total);
    assert.equal((await request(`/${path}`, "u-rop")).body.length, total);
    const result = await request(`/${path}`, "u-manager");
    assert.equal(result.body.length, own);
    assert(
      result.body.every(
        (row: { ownerId: string }) => row.ownerId === "u-manager",
      ),
    );
  }
});
test("manager cannot read, update or delete another owner's records", async () => {
  for (const [path, id, patch] of [
    ["clients", "c-1", { name: "Чужой" }],
    ["deals", "d-1", { stage: "won" }],
    ["tasks", "t-1", { completed: true }],
  ] as const) {
    assert.equal((await request(`/${path}/${id}`, "u-manager")).status, 404);
    assert.equal(
      (await request(`/${path}/${id}`, "u-manager", "PATCH", patch)).status,
      404,
    );
  }
  assert.equal(
    (await request("/clients/c-1", "u-manager", "DELETE")).status,
    404,
  );
});
test("manager cannot assign records to others or link foreign clients", async () => {
  assert.equal(
    (
      await request("/clients", "u-manager", "POST", {
        ...clientPayload,
        ownerId: "u-admin",
      })
    ).status,
    403,
  );
  assert.equal(
    (await request("/clients/c-3", "u-manager", "PATCH", { ownerId: "u-rop" }))
      .status,
    403,
  );
  assert.equal(
    (
      await request("/deals", "u-manager", "POST", {
        title: "Чужая сделка",
        amount: 100,
        clientId: "c-1",
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await request("/tasks", "u-manager", "POST", {
        title: "Чужая задача",
        clientId: "c-1",
        dueDate: "2026-11-15",
      })
    ).status,
    404,
  );
  assert.equal(
    (await request("/deals/d-3", "u-manager", "PATCH", { clientId: "c-1" }))
      .status,
    404,
  );
});
test("strict validation, dates, values, unknown fields, empty patch", async () => {
  assert.equal(
    (
      await request("/clients", "u-admin", "POST", {
        ...clientPayload,
        email: "wrong",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request("/deals", "u-admin", "POST", {
        title: "Сделка",
        clientId: "c-1",
        amount: -1,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request("/tasks", "u-admin", "POST", {
        title: "Задача",
        dueDate: "2026-02-30",
      })
    ).status,
    400,
  );
  assert.equal(
    (await request("/clients/c-1", "u-admin", "PATCH", { id: "replace-id" }))
      .status,
    400,
  );
  assert.equal(
    (await request("/clients/c-1", "u-admin", "PATCH", {})).status,
    400,
  );
  assert.equal(
    (await request("/deals/d-1", "u-admin", "PATCH", { stage: "invalid" }))
      .status,
    400,
  );
  assert.equal(
    (
      await request("/clients", "u-admin", "POST", {
        ...clientPayload,
        ownerId: "missing",
      })
    ).status,
    400,
  );
  const malformed = await fetch(base + "/clients", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-User-Id": "u-admin" },
    body: "{",
  });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error.code, "INVALID_JSON");
});
test("PATCH preserves unrelated fields and defaults; managers can update their own data", async () => {
  const before = (await request("/clients/c-3", "u-manager")).body;
  const updated = await request("/clients/c-3", "u-manager", "PATCH", {
    name: "Новое имя",
  });
  assert.equal(updated.status, 200);
  assert.deepEqual(updated.body, { ...before, name: "Новое имя" });
  const deal = (await request("/deals/d-3", "u-manager")).body;
  const moved = await request("/deals/d-3", "u-manager", "PATCH", {
    stage: "won",
  });
  assert.deepEqual(moved.body, { ...deal, stage: "won" });
  const task = (await request("/tasks/t-3", "u-manager")).body;
  const done = await request("/tasks/t-3", "u-manager", "PATCH", {
    completed: true,
  });
  assert.deepEqual(done.body, { ...task, completed: true });
});
test("new client CRUD works; linked history and ownership remain consistent", async () => {
  const created = await request("/clients", "u-manager", "POST", clientPayload);
  assert.equal(created.status, 201);
  assert.equal(created.body.ownerId, "u-manager");
  assert.equal(created.body.stage, "new");
  const id = created.body.id;
  assert.equal(
    (await request(`/clients/${id}`, "u-manager", "DELETE")).status,
    204,
  );
  assert.equal((await request(`/clients/${id}`, "u-manager")).status, 404);
  const linked = await request("/clients", "u-admin", "POST", {
    ...clientPayload,
    ownerId: "u-rop",
  });
  const deal = await request("/deals", "u-rop", "POST", {
    title: "Новая сделка",
    amount: 420000.5,
    clientId: linked.body.id,
  });
  assert.equal(deal.status, 201);
  assert.equal(deal.body.amount, 420000.5);
  assert.equal(
    (await request(`/clients/${linked.body.id}`, "u-admin", "DELETE")).status,
    409,
  );
  assert.equal(
    (
      await request(`/clients/${linked.body.id}`, "u-admin", "PATCH", {
        ownerId: "u-admin",
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await request("/tasks", "u-admin", "POST", {
        title: "Задача",
        clientId: linked.body.id,
        dueDate: "2026-11-16",
      })
    ).status,
    400,
  );
  const task = await request("/tasks", "u-manager", "POST", {
    title: "Без клиента",
    dueDate: "2026-11-16",
  });
  assert.equal(task.status, 201);
  assert.equal(task.body.clientId, null);
  assert.equal(task.body.completed, false);
});
test("stats are scoped and derived from actual records", async () => {
  for (const user of ["u-admin", "u-rop", "u-manager"]) {
    const stats = (await request("/stats", user)).body;
    const deals = (await request("/deals", user)).body as Array<{
      amount: number;
      stage: string;
    }>;
    const active = deals.filter((d) => !["won", "lost"].includes(d.stage));
    assert.equal(stats.activeDeals, active.length);
    assert.equal(
      stats.pipelineAmount,
      active.reduce((sum, d) => sum + d.amount, 0),
    );
    assert.equal(stats.totalDeals, deals.length);
    assert.equal(
      stats.byStage.reduce(
        (sum: number, s: { count: number }) => sum + s.count,
        0,
      ),
      deals.length,
    );
    if (user === "u-manager")
      assert(
        stats.recentTasks.every((t: { ownerId: string }) => t.ownerId === user),
      );
  }
});
test("CORS allows configured origin only, including preflight", async () => {
  const allowed = await request("/health", "", "GET", undefined, {
    Origin: "http://localhost:3000",
  });
  assert.equal(
    allowed.headers.get("access-control-allow-origin"),
    "http://localhost:3000",
  );
  const denied = await request("/health", "", "GET", undefined, {
    Origin: "https://untrusted.example",
  });
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get("access-control-allow-origin"), null);
  const preflight = await request("/clients", "", "OPTIONS", undefined, {
    Origin: "http://localhost:3000",
    "Access-Control-Request-Headers": "X-User-Id",
    "Access-Control-Request-Method": "PATCH",
  });
  assert.equal(preflight.status, 204);
  assert.match(
    preflight.headers.get("access-control-allow-headers") ?? "",
    /X-User-Id/,
  );
});
