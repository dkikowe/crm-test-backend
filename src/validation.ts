import { z } from "zod";
import { stages } from "./domain.js";
z.config(z.locales.ru());
const text = z
  .string()
  .trim()
  .min(1, "Обязательное поле")
  .max(200, "Не более 200 символов");
const ownerId = text.optional();
const stage = z.enum(stages, { error: "Неизвестный этап" });
export const clientSchema = z
  .object({
    name: text,
    company: text,
    email: z.email("Некорректный email").max(254),
    phone: z
      .string()
      .trim()
      .regex(/^\+?[\d\s()-]{7,25}$/, "Некорректный телефон"),
    city: text,
    stage: stage.default("new"),
    source: text.default("Сайт"),
    notes: z.string().trim().max(3000).default(""),
    ownerId,
  })
  .strict();
export const dealSchema = z
  .object({
    title: text,
    clientId: text,
    amount: z
      .number()
      .finite()
      .min(0, "Сумма не может быть отрицательной")
      .max(1e12)
      .multipleOf(0.01),
    stage: stage.default("new"),
    ownerId,
  })
  .strict();
export const taskSchema = z
  .object({
    title: text,
    clientId: text.nullable().default(null),
    dueDate: z.iso.date("Дата должна быть в формате ГГГГ-ММ-ДД"),
    completed: z.boolean().default(false),
    ownerId,
  })
  .strict();
// Build patches from input definitions without create-time defaults.
export const patchSchemas = {
  clients: clientSchema
    .extend({ stage, source: text, notes: z.string().trim().max(3000) })
    .partial()
    .refine(
      (value) => Object.keys(value).length > 0,
      "Укажите хотя бы одно поле",
    ),
  deals: dealSchema
    .extend({ stage })
    .partial()
    .refine(
      (value) => Object.keys(value).length > 0,
      "Укажите хотя бы одно поле",
    ),
  tasks: taskSchema
    .extend({ clientId: text.nullable(), completed: z.boolean() })
    .partial()
    .refine(
      (value) => Object.keys(value).length > 0,
      "Укажите хотя бы одно поле",
    ),
};
export const createSchemas = {
  clients: clientSchema,
  deals: dealSchema,
  tasks: taskSchema,
};
