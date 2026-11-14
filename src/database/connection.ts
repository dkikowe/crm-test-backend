import mongoose from "mongoose";
import { createModels } from "./models.js";
import { createMongoRepositories, toStored } from "../repositories/mongo.js";
import * as seed from "../data/seed.js";

export async function connectStorage(
  uri: string,
  databaseName: string,
  seedDemoData = false,
) {
  const connection = mongoose.createConnection(uri, {
    dbName: databaseName,
    serverSelectionTimeoutMS: 10000,
    connectTimeoutMS: 10000,
    socketTimeoutMS: 15000,
    waitQueueTimeoutMS: 10000,
    maxPoolSize: 10,
    bufferCommands: false,
    autoIndex: false,
    autoCreate: false,
  });
  // Never log raw driver errors: they may contain the connection string.
  connection.on("error", () => console.error("MongoDB: ошибка подключения"));
  connection.on("disconnected", () =>
    console.warn("MongoDB: соединение закрыто"),
  );
  try {
    await connection.asPromise();
    const models = createModels(connection);
    for (const model of Object.values(models)) {
      await model.createCollection();
      await model.createIndexes();
    }
    await models.meta.updateOne(
      { _id: "write-lock" },
      { $setOnInsert: { revision: 0 } },
      { upsert: true },
    );
    const repositories = createMongoRepositories(connection, models);
    let seedResult = "disabled";
    if (seedDemoData) {
      seedResult = await connection.transaction(
        async (session) => {
          await models.meta.updateOne(
            { _id: "write-lock" },
            { $inc: { revision: 1 } },
            { session },
          );
          if (await models.meta.exists({ _id: "seed-v1" }).session(session))
            return "already-seeded";
          for (const exists of [
            () => models.users.exists({}).session(session),
            () => models.clients.exists({}).session(session),
            () => models.deals.exists({}).session(session),
            () => models.tasks.exists({}).session(session),
          ]) {
            if (await exists()) return "existing-data";
          }
          // An all-or-nothing first initialization. No overwrites, no collection drops.
          await models.users.insertMany(seed.users.map(toStored), { session });
          await models.clients.insertMany(seed.clients.map(toStored), {
            session,
          });
          await models.deals.insertMany(seed.deals.map(toStored), { session });
          await models.tasks.insertMany(seed.tasks.map(toStored), { session });
          await models.meta.create(
            [
              {
                _id: "seed-v1",
                revision: 1,
                completedAt: new Date().toISOString(),
              },
            ],
            { session },
          );
          return "created";
        },
        { readPreference: "primary", writeConcern: { w: "majority" } },
      );
    }
    return {
      repositories,
      seedResult,
      async isHealthy() {
        if (connection.readyState !== 1 || !connection.db) return false;
        try {
          await connection.db.command({ ping: 1 }, { timeoutMS: 2000 });
          return true;
        } catch {
          return false;
        }
      },
      close: () => connection.close(),
    };
  } catch (error) {
    await connection.close().catch(() => undefined);
    throw error;
  }
}
