import type { Repositories, Repository } from "./interfaces.js";
import * as seed from "../data/seed.js";
export class MemoryRepository<
  T extends { id: string },
> implements Repository<T> {
  private records: Map<string, T>;
  constructor(records: T[]) {
    this.records = new Map(
      records.map((row) => [row.id, structuredClone(row)]),
    );
  }
  async findAll() {
    return structuredClone([...this.records.values()]);
  }
  async findById(id: string) {
    const row = this.records.get(id);
    return row ? structuredClone(row) : undefined;
  }
  async create(entity: T) {
    this.records.set(entity.id, structuredClone(entity));
    return structuredClone(entity);
  }
  async update(id: string, patch: Partial<T>) {
    const row = this.records.get(id);
    if (!row) return undefined;
    const updated = { ...row, ...patch, id };
    this.records.set(id, updated);
    return structuredClone(updated);
  }
  async delete(id: string) {
    return this.records.delete(id);
  }
}
// Isolated adapter for tests; runtime uses MongoDB and never silently falls back.
export function createRepositories(): Repositories {
  let previous = Promise.resolve();
  return {
    async transaction<T>(work: () => Promise<T>): Promise<T> {
      const before = previous;
      let release!: () => void;
      previous = new Promise<void>((resolve) => {
        release = resolve;
      });
      await before;
      try {
        return await work();
      } finally {
        release();
      }
    },
    clients: new MemoryRepository(seed.clients),
    deals: new MemoryRepository(seed.deals),
    tasks: new MemoryRepository(seed.tasks),
    users: new MemoryRepository(seed.users),
  };
}
