import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";
import { AppError } from "../errors.js";
export const errorHandler: ErrorRequestHandler = (
  error: unknown,
  _req,
  res,
  _next,
) => {
  if (error instanceof ZodError) {
    res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "Проверьте заполненные поля",
        details: error.issues.map((issue) => ({
          field: issue.path.join("."),
          message: issue.message,
        })),
      },
    });
    return;
  }
  if (error instanceof AppError) {
    res
      .status(error.status)
      .json({ error: { code: error.code, message: error.message } });
    return;
  }
  if (error instanceof SyntaxError && "body" in error) {
    res
      .status(400)
      .json({ error: { code: "INVALID_JSON", message: "Некорректный JSON" } });
    return;
  }
  if (
    error &&
    typeof error === "object" &&
    "type" in error &&
    error.type === "entity.too.large"
  ) {
    res.status(413).json({
      error: { code: "PAYLOAD_TOO_LARGE", message: "Слишком большой запрос" },
    });
    return;
  }
  const name = error instanceof Error ? error.name : "UnknownError";
  const code =
    error && typeof error === "object" && "code" in error
      ? error.code
      : undefined;
  if (code === 11000) {
    res
      .status(409)
      .json({
        error: {
          code: "DUPLICATE_RECORD",
          message: "Запись с таким идентификатором уже существует",
        },
      });
    return;
  }
  if (
    [
      "MongoNetworkError",
      "MongoNetworkTimeoutError",
      "MongoServerSelectionError",
      "MongooseServerSelectionError",
      "MongoNotConnectedError",
      "MongoOperationTimeoutError",
    ].includes(name)
  ) {
    res
      .status(503)
      .json({
        error: {
          code: "DATABASE_UNAVAILABLE",
          message: "База данных временно недоступна. Попробуйте ещё раз.",
        },
      });
    return;
  }
  // No raw errors or request bodies in logs: database errors can contain secrets.
  console.error("API request failed", {
    type: name,
    code: typeof code === "number" ? code : undefined,
  });
  res.status(500).json({
    error: { code: "INTERNAL_ERROR", message: "Внутренняя ошибка сервера" },
  });
};
