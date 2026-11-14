import express from "express";
import cors from "cors";
import { createRoutes } from "./routes/index.js";
import type { Repositories } from "./repositories/interfaces.js";
import { errorHandler } from "./middleware/errors.js";
import { AppError } from "./errors.js";
export function createApp(
  frontendUrl: string,
  repositories: Repositories,
  isHealthy: () => Promise<boolean> = async () => true,
) {
  const app = express();
  app.disable("x-powered-by");
  app.use(
    cors({
      origin(origin, callback) {
        // Requests without Origin (health checks / CLI) do not receive CORS credentials.
        if (!origin || origin === frontendUrl) callback(null, true);
        else
          callback(
            new AppError(
              403,
              "CORS_FORBIDDEN",
              "Этот адрес фронтенда не разрешён",
            ),
          );
      },
      allowedHeaders: ["Content-Type", "X-User-Id"],
      methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    }),
  );
  app.use(express.json({ limit: "100kb" }));
  app.use(createRoutes(repositories, isHealthy));
  app.use((_req, _res, next) =>
    next(new AppError(404, "NOT_FOUND", "Маршрут не найден")),
  );
  app.use(errorHandler);
  return app;
}
