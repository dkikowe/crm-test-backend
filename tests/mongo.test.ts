import "dotenv/config";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { connectStorage } from "../src/database/connection.js";
import { CrmService } from "../src/services/crm.js";
import { createApp } from "../src/app.js";
import type { User } from "../src/domain.js";

// Opt-in: each run owns a new, randomly named database, never the application's DB.
test(
  "MongoDB: persistence, seed safety, transactions and access control",
  {
    skip: process.env.RUN_MONGODB_TESTS !== "true",
    timeout: 120000,
  },
  async (t) => {
    const uri = process.env.MONGODB_URI;
    assert(uri, "Set MONGODB_URI in api/.env before running test:mongo");
    const databaseName = `salespace_test_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    let storage: Awaited<ReturnType<typeof connectStorage>> | undefined;
    const manager: User = {
      id: "u-manager",
      name: "Данияр Омаров",
      role: "manager",
    };
    const admin: User = { id: "u-admin", name: "Александр Ким", role: "admin" };
    const payload = {
      name: "Проверка MongoDB",
      company: "Тестовая компания",
      email: "test@example.kz",
      phone: "+7 701 123 45 67",
      city: "Алматы",
      stage: "new" as const,
      source: "Сайт",
      notes: "",
    };
    try {
      storage = await connectStorage(uri, databaseName, true);
      assert.equal(storage.seedResult, "created");
      assert.equal(await storage.isHealthy(), true);
      assert.equal((await storage.repositories.users.findAll()).length, 3);
      assert.equal((await storage.repositories.clients.findAll()).length, 15);
      assert.equal((await storage.repositories.deals.findAll()).length, 12);
      assert.equal((await storage.repositories.tasks.findAll()).length, 10);
      let service = new CrmService(storage.repositories);
      let clientId = "";
      await t.test(
        "HTTP contracts and manager visibility use MongoDB",
        async () => {
          const server = createApp(
            "http://localhost:3000",
            storage!.repositories,
            storage!.isHealthy,
          ).listen(0, "127.0.0.1");
          await new Promise<void>((resolve) =>
            server.once("listening", resolve),
          );
          try {
            const address = server.address();
            assert(address && typeof address === "object");
            const base = `http://127.0.0.1:${address.port}`;
            const list = await fetch(`${base}/clients`, {
              headers: { "X-User-Id": manager.id },
            });
            assert.equal(list.status, 200);
            const rows = await list.json();
            assert.equal(rows.length, 5);
            assert(
              rows.every(
                (row: { ownerId: string }) => row.ownerId === manager.id,
              ),
            );
            assert.equal(
              (
                await fetch(`${base}/clients/c-1`, {
                  headers: { "X-User-Id": manager.id },
                })
              ).status,
              404,
            );
            const create = await fetch(`${base}/clients`, {
              method: "POST",
              headers: {
                "X-User-Id": manager.id,
                "Content-Type": "application/json",
              },
              body: JSON.stringify(payload),
            });
            assert.equal(create.status, 201);
            const saved = await create.json();
            clientId = saved.id;
            assert.equal(saved.ownerId, manager.id);
            assert.equal(saved._id, undefined);
          } finally {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
          }
        },
      );
      await t.test(
        "PATCH preserves fields and linked records enforce ownership",
        async () => {
          await service.update(
            "clients",
            clientId,
            { notes: "Сохранённая заметка" },
            manager,
          );
          const updated = await service.get("clients", clientId, manager);
          assert.equal(updated.stage, "new");
          assert.equal(updated.notes, "Сохранённая заметка");
          const deal = await service.create(
            "deals",
            {
              title: "Сохранённая сделка",
              amount: 123456.78,
              stage: "qualified",
              clientId,
            },
            manager,
          );
          await service.update("deals", deal.id, { stage: "payment" }, manager);
          assert.equal(
            (await service.get("deals", deal.id, manager)).amount,
            123456.78,
          );
          await assert.rejects(service.deleteClient(clientId, manager), {
            status: 409,
          });
          await assert.rejects(
            service.update("clients", clientId, { ownerId: admin.id }, admin),
            { status: 409 },
          );
          await assert.rejects(
            service.create(
              "tasks",
              {
                title: "Чужая задача",
                clientId: "c-1",
                dueDate: "2026-12-01",
                completed: false,
              },
              manager,
            ),
            { status: 404 },
          );
          const task = await service.create(
            "tasks",
            {
              title: "Завершить проверку",
              clientId,
              dueDate: "2026-12-01",
              completed: false,
            },
            manager,
          );
          await service.update("tasks", task.id, { completed: true }, manager);
          assert.equal(
            (await service.get("tasks", task.id, manager)).completed,
            true,
          );
          await assert.rejects(service.get("clients", "c-1", manager), {
            status: 404,
          });
          await assert.rejects(
            service.update("clients", clientId, { ownerId: admin.id }, manager),
            { status: 403 },
          );
        },
      );
      await t.test("failed transactions roll back all writes", async () => {
        await assert.rejects(
          storage!.repositories.transaction(async () => {
            await storage!.repositories.clients.update(clientId, {
              notes: "Откатить",
            });
            throw new Error("Expected rollback");
          }),
          /Expected rollback/,
        );
        assert.equal(
          (await service.get("clients", clientId, manager)).notes,
          "Сохранённая заметка",
        );
      });
      await t.test(
        "concurrent deletion and related creation cannot produce an orphan",
        async () => {
          const client = await service.create("clients", payload, manager);
          const outcomes = await Promise.allSettled([
            service.deleteClient(client.id, manager),
            service.create(
              "deals",
              {
                title: "Гонка операций",
                amount: 100,
                stage: "new",
                clientId: client.id,
              },
              manager,
            ),
          ]);
          assert.equal(
            outcomes.filter((result) => result.status === "fulfilled").length,
            1,
          );
          const parent = await storage!.repositories.clients.findById(
            client.id,
          );
          const related = (await storage!.repositories.deals.findAll()).filter(
            (row) => row.clientId === client.id,
          );
          assert(parent ? related.length === 1 : related.length === 0);
        },
      );
      await t.test(
        "reconnecting preserves updates and does not restore deleted seed records",
        async () => {
          await service.deleteClient("c-15", manager);
          await storage!.close();
          storage = await connectStorage(uri, databaseName, true);
          service = new CrmService(storage.repositories);
          assert.equal(storage.seedResult, "already-seeded");
          assert.equal(
            (await service.get("clients", clientId, manager)).notes,
            "Сохранённая заметка",
          );
          assert.equal(
            await storage.repositories.clients.findById("c-15"),
            undefined,
          );
          assert.equal(
            (await service.list("deals", manager)).some(
              (deal) => deal.clientId === clientId && deal.stage === "payment",
            ),
            true,
          );
          assert.equal(
            (await service.list("tasks", manager)).some(
              (task) => task.clientId === clientId && task.completed,
            ),
            true,
          );
        },
      );
      await t.test(
        "health fails when the database is disconnected",
        async () => {
          await storage!.close();
          assert.equal(await storage!.isHealthy(), false);
        },
      );
    } finally {
      await storage?.close();
      // Only the fresh random DB created by this test is removed.
      assert.match(databaseName, /^salespace_test_[a-f0-9]{16}$/);
      const cleanup = await mongoose
        .createConnection(uri, {
          dbName: databaseName,
          serverSelectionTimeoutMS: 10000,
        })
        .asPromise();
      try {
        await cleanup.dropDatabase();
      } finally {
        await cleanup.close();
      }
    }
  },
);
