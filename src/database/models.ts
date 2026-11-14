import { Schema, type Connection } from "mongoose";
import type { Client, Deal, Task, Account, Session, Invite, AuthAttempt } from "../domain.js";
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
  const userSchema = new Schema<Stored<Account>>(
    {
      _id: { type: String, required: true },
      name: { type: String, required: true },
      email: { type: String, required: true },
      passwordHash: { type: String, required: true },
      createdAt: { type: String, required: true },
      role: { type: String, enum: ["admin", "rop", "manager"], required: true },
    },
    options,
  );
  userSchema.index({ email: 1 }, { unique: true, partialFilterExpression: { email: { $type: "string" } } });
  const sessionSchema = new Schema<Stored<Session>>({
    _id: { type: String, required: true }, userId: { type: String, required: true }, expiresAt: { type: Date, required: true },
  }, options);
  sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  sessionSchema.index({ userId: 1 });
  const inviteSchema = new Schema<Stored<Invite>>({
    _id: { type: String, required: true }, email: { type: String, default: null },
    role: { type: String, enum: ["admin", "rop", "manager"], required: true }, expiresAt: { type: Date, required: true },
  }, options);
  inviteSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  const attemptSchema = new Schema<Stored<AuthAttempt>>({
    _id: { type: String, required: true }, count: { type: Number, required: true }, expiresAt: { type: Date, required: true },
  }, options);
  attemptSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
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
    sessions: connection.model<Stored<Session>>("Session", sessionSchema, "sessions"),
    invites: connection.model<Stored<Invite>>("Invite", inviteSchema, "invites"),
    authAttempts: connection.model<Stored<AuthAttempt>>("AuthAttempt", attemptSchema, "auth_attempts"),
    users: connection.model<Stored<Account>>("User", userSchema, "users"),
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
