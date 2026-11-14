import type { Entities, User } from "../domain.js";
// Storage-independent contracts shared by the memory and MongoDB adapters.
export interface Repository<T extends { id: string }> {
  findAll(): Promise<T[]>;
  findById(id: string): Promise<T | undefined>;
  create(entity: T): Promise<T>;
  update(id: string, patch: Partial<T>): Promise<T | undefined>;
  delete(id: string): Promise<boolean>;
}
export interface UserRepository {
  findAll(): Promise<User[]>;
  findById(id: string): Promise<User | undefined>;
}
export type Repositories = {
  [K in keyof Entities]: Repository<Entities[K]>;
} & {
  users: UserRepository;
  transaction<T>(work: () => Promise<T>): Promise<T>;
};
