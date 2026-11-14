import type { Repositories, Repository } from "./interfaces.js";
import type { Account } from "../domain.js";
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
class MemoryUsers extends MemoryRepository<Account> {
  async findByEmail(email: string) { return (await this.findAll()).find(u => u.email === email); }
}
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
    clients: new MemoryRepository([]),
    deals: new MemoryRepository([]),
    tasks: new MemoryRepository([]),
    users: new MemoryUsers([]),
    sessions: new MemoryRepository([]),
    invites: new MemoryRepository([]),
    authAttempts: new MemoryRepository([]),
  };
}
