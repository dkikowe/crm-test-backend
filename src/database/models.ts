import { Schema, type Connection } from "mongoose";
import type { Client, Deal, Task, User } from "../domain.js";
import { stages } from "../domain.js";

// String _id preserves the existing public IDs (including demo IDs and UUIDs).
export type Stored<T extends { id: string }> = Omit<T, "id"> & { _id: string };
const options = {
  versionKey: false,
  id: false,
  bufferCommands: false,
  strict: "throw",
} as const;
const owned = {
  _id: { type: String, required: true },
  ownerId: { type: String, required: true },
  createdAt: { type: String, required: true, immutable: true },
};

export function createModels(connection: Connection) {
  const userSchema = new Schema<Stored<User>>(
    {
      _id: { type: String, required: true },
      name: { type: String, required: true },
      role: { type: String, enum: ["admin", "rop", "manager"], required: true },
    },
    options,
  );
  const clientSchema = new Schema<Stored<Client>>(
    {
      ...owned,
      name: { type: String, required: true },
      company: { type: String, required: true },
      email: { type: String, required: true },
      phone: { type: String, required: true },
      city: { type: String, required: true },
      stage: { type: String, enum: stages, required: true },
      source: { type: String, required: true },
      notes: { type: String, default: "" },
    },
    options,
  );
  clientSchema.index({ ownerId: 1, createdAt: -1 });
  clientSchema.index({ stage: 1 });
  const dealSchema = new Schema<Stored<Deal>>(
    {
      ...owned,
      title: { type: String, required: true },
      clientId: { type: String, required: true },
      amount: { type: Number, required: true, min: 0, max: 1e12 },
      stage: { type: String, enum: stages, required: true },
    },
    options,
  );
  dealSchema.index({ ownerId: 1, stage: 1 });
  dealSchema.index({ clientId: 1 });
  const taskSchema = new Schema<Stored<Task>>(
    {
      ...owned,
      title: { type: String, required: true },
      clientId: { type: String, default: null },
      dueDate: { type: String, required: true },
      completed: { type: Boolean, required: true },
    },
    options,
  );
  taskSchema.index({ ownerId: 1, completed: 1, dueDate: 1 });
  taskSchema.index({ clientId: 1 });
  const metaSchema = new Schema<{
    _id: string;
    revision: number;
    completedAt?: string;
  }>(
    {
      _id: { type: String, required: true },
      revision: { type: Number, default: 0 },
      completedAt: String,
    },
    options,
  );
  return {
    users: connection.model<Stored<User>>("User", userSchema, "users"),
    clients: connection.model<Stored<Client>>(
      "Client",
      clientSchema,
      "clients",
    ),
    deals: connection.model<Stored<Deal>>("Deal", dealSchema, "deals"),
    tasks: connection.model<Stored<Task>>("Task", taskSchema, "tasks"),
    meta: connection.model("CrmMeta", metaSchema, "_crm_meta"),
  };
}
export type Models = ReturnType<typeof createModels>;
