import mongoose from "mongoose";
import { createModels } from "./models.js";
import { createMongoRepositories } from "../repositories/mongo.js";
import { archiveLegacyDemo } from "./migration.js";

export async function connectStorage(
  uri: string,
  databaseName: string,
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
    await archiveLegacyDemo(connection);
    return {
      repositories,

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
