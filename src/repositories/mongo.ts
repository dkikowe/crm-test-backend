import { AsyncLocalStorage } from "node:async_hooks";
import type { ClientSession, Connection, Model, UpdateQuery } from "mongoose";
import type { Models, Stored } from "../database/models.js";
import type { Repositories, Repository } from "./interfaces.js";

export function toStored<T extends { id: string }>(entity: T): Stored<T> {
  const { id, ...fields } = entity;
  return { ...fields, _id: id };
}
export function fromStored<T extends { id: string }>(document: Stored<T>): T {
  const { _id, ...fields } = document;
  return { ...fields, id: _id } as unknown as T;
}

class MongoRepository<T extends { id: string }> implements Repository<T> {
  constructor(
    protected readonly model: Model<Stored<T>>,
    protected readonly context: AsyncLocalStorage<ClientSession>,
  ) {}
  async findAll(): Promise<T[]> {
    const rows = await this.model
      .find()
      .session(this.context.getStore() ?? null)
      .lean<Stored<T>[]>()
      .exec();
    return rows.map((row) => fromStored<T>(row));
  }
  async findById(id: string): Promise<T | undefined> {
    const row = await this.model
      .findById(id)
      .session(this.context.getStore() ?? null)
      .lean<Stored<T>>()
      .exec();
    return row ? fromStored<T>(row) : undefined;
  }
  async create(entity: T): Promise<T> {
    const document = new this.model(toStored(entity));
    await document.save({ session: this.context.getStore() });
    return structuredClone(entity);
  }
  async update(id: string, patch: Partial<T>): Promise<T | undefined> {
    // Public IDs cannot be overwritten, even by a repository caller.
    const { id: ignoredId, ...fields } = patch;
    const row = await this.model
      .findByIdAndUpdate(id, { $set: fields } as UpdateQuery<Stored<T>>, {
        returnDocument: "after",
        runValidators: true,
        session: this.context.getStore(),
      })
      .lean<Stored<T>>()
      .exec();
    return row ? fromStored<T>(row) : undefined;
  }
  async delete(id: string): Promise<boolean> {
    const result = await this.model
      .deleteOne({ _id: id })
      .session(this.context.getStore() ?? null)
      .exec();
    return result.deletedCount === 1;
  }
}

class MongoUsers extends MongoRepository<import("../domain.js").Account> {
  async findByEmail(email: string) {
    const row = await this.model.findOne({ email }).session(this.context.getStore() ?? null).lean<Stored<import("../domain.js").Account>>().exec();
    return row ? fromStored<import("../domain.js").Account>(row) : undefined;
  }
}
export function createMongoRepositories(
  connection: Connection,
  models: Models,
): Repositories {
  const context = new AsyncLocalStorage<ClientSession>();
  return {
    users: new MongoUsers(models.users, context),
    sessions: new MongoRepository(models.sessions, context),
    invites: new MongoRepository(models.invites, context),
    authAttempts: new MongoRepository(models.authAttempts, context),
    clients: new MongoRepository(models.clients, context),
    deals: new MongoRepository(models.deals, context),
    tasks: new MongoRepository(models.tasks, context),
    async transaction<T>(work: () => Promise<T>): Promise<T> {
      if (context.getStore()) return work();
      return connection.transaction(
        async (session) => {
          // A small CRM serializes writes through one document. This prevents races
          // between permission checks, client reassignment/deletion and linked writes,
          // including when more than one API instance is running.
          await models.meta.updateOne(
            { _id: "write-lock" },
            { $inc: { revision: 1 } },
            { session },
          );
          return context.run(session, work);
        },
        {
          readPreference: "primary",
          writeConcern: { w: "majority" },
          readConcern: { level: "snapshot" },
          maxCommitTimeMS: 10000,
        },
      );
    },
  };
}
