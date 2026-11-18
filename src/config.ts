import { z } from "zod";

const schema = z.object({
  WHATSAPP_VERIFY_TOKEN: z.string().optional(),
  WHATSAPP_APP_SECRET: z.string().optional(),
  S3_ENDPOINT: z.url().optional(),
  S3_REGION: z.string().min(1).optional(),
  S3_BUCKET: z.string().min(3).optional(),
  S3_FORCE_PATH_STYLE: z.enum(["true", "false"]).default("false").transform(v => v === "true"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  FRONTEND_URL: z
    .url()
    .refine(
      (value) => new URL(value).origin === value,
      "Укажите origin без завершающего / и пути",
    )
    .default("http://localhost:3000"),
  MONGODB_URI: z
    .string()
    .regex(/^mongodb(?:\+srv)?:\/\//, "Укажите строку подключения MongoDB"),
  MONGODB_DB_NAME: z
    .string()
    .regex(/^[a-zA-Z0-9_-]{1,38}$/)
    .default("salespace_crm"),

});
export function readConfig(source: NodeJS.ProcessEnv = process.env) {
  const result = schema.safeParse(source);
  if (!result.success) {
    // Never include rejected values: MONGODB_URI contains a password.
    const fields = [
      ...new Set(result.error.issues.map((issue) => issue.path.join("."))),
    ];
    throw new Error(`Проверьте переменные окружения: ${fields.join(", ")}`);
  }
  return result.data;
}
