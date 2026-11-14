import "dotenv/config";
import { createApp } from "./app.js";
import { readConfig } from "./config.js";
import { connectStorage } from "./database/connection.js";

async function main() {
  const env = readConfig();
  const storage = await connectStorage(
    env.MONGODB_URI,
    env.MONGODB_DB_NAME,
  );
  console.log("MongoDB connected");
  const server = createApp(
    env.FRONTEND_URL,
    storage.repositories,
    storage.isHealthy,
  ).listen(env.PORT, "0.0.0.0", () => {
    console.log(`Salespace API listening on port ${env.PORT}`);
  });
  let stopping = false;
  async function shutdown() {
    if (stopping) return;
    stopping = true;
    const timeout = setTimeout(() => process.exit(1), 10000).unref();
    server.close(async () => {
      await storage.close();
      clearTimeout(timeout);
      process.exit(0);
    });
  }
  server.on("error", async () => {
    console.error(
      "Не удалось запустить HTTP-сервер. Проверьте, что порт свободен.",
    );
    await storage.close();
    process.exitCode = 1;
  });
  for (const signal of ["SIGTERM", "SIGINT"] as const)
    process.on(signal, () => {
      void shutdown();
    });
}

main().catch((error) => {
  if (
    error instanceof Error &&
    error.message.startsWith("Проверьте переменные окружения:")
  )
    console.error(error.message);
  else
    console.error(
      "Не удалось подключить MongoDB. Проверьте MONGODB_URI, права пользователя и IP Access List в Atlas. Секреты не выводятся.",
    );
  process.exitCode = 1;
});
