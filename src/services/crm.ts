import { randomUUID } from "node:crypto";
import type { Entities, Kind, Owned, User } from "../domain.js";
import { stages } from "../domain.js";
import type { Repositories, Repository } from "../repositories/interfaces.js";
import { AppError } from "../errors.js";
export class CrmService {
  constructor(private repositories: Repositories) {}
  private repo<K extends Kind>(kind: K): Repository<Entities[K]> {
    return this.repositories[kind] as Repository<Entities[K]>;
  }
  private canAccess(user: User, row: Owned) {
    return user.role !== "manager" || row.ownerId === user.id;
  }
  async list<K extends Kind>(kind: K, user: User) {
    return (await this.repo(kind).findAll()).filter((row) =>
      this.canAccess(user, row),
    );
  }
  async get<K extends Kind>(kind: K, id: string, user: User) {
    const row = await this.repo(kind).findById(id);
    if (!row || !this.canAccess(user, row))
      throw new AppError(404, "NOT_FOUND", "Запись не найдена или недоступна");
    return row;
  }
  private async validateOwner(ownerId: string, user: User) {
    if (user.role === "manager" && ownerId !== user.id)
      throw new AppError(
        403,
        "FORBIDDEN",
        "Можно назначать записи только себе",
      );
    if (!(await this.repositories.users.findById(ownerId)))
      throw new AppError(400, "INVALID_OWNER", "Ответственный не найден");
  }
  private async validateRelation(
    row: { clientId?: string | null; ownerId: string },
    user: User,
  ) {
    if (!row.clientId) return;
    const client = await this.get("clients", row.clientId, user);
    if (client.ownerId !== row.ownerId)
      throw new AppError(
        400,
        "OWNER_MISMATCH",
        "Ответственный должен совпадать с ответственным клиента",
      );
  }
  async create<K extends Kind>(
    kind: K,
    data: Omit<Entities[K], "id" | "createdAt" | "ownerId"> & {
      ownerId?: string;
    },
    user: User,
  ) {
    return this.repositories.transaction(() =>
      this.createRecord(kind, data, user),
    );
  }
  private async createRecord<K extends Kind>(
    kind: K,
    data: Omit<Entities[K], "id" | "createdAt" | "ownerId"> & {
      ownerId?: string;
    },
    user: User,
  ) {
    const ownerId = data.ownerId ?? user.id;
    await this.validateOwner(ownerId, user);
    const entity = {
      ...data,
      ownerId,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    } as Entities[K];
    if (kind !== "clients") await this.validateRelation(entity, user);
    return this.repo(kind).create(entity);
  }
  async update<K extends Kind>(
    kind: K,
    id: string,
    patch: Partial<Omit<Entities[K], "id" | "createdAt">>,
    user: User,
  ) {
    return this.repositories.transaction(() =>
      this.updateRecord(kind, id, patch, user),
    );
  }
  private async updateRecord<K extends Kind>(
    kind: K,
    id: string,
    patch: Partial<Omit<Entities[K], "id" | "createdAt">>,
    user: User,
  ) {
    const existing = await this.get(kind, id, user);
    const updated = { ...existing, ...patch };
    await this.validateOwner(updated.ownerId, user);
    if (kind !== "clients") await this.validateRelation(updated, user);
    if (
      kind === "clients" &&
      existing.ownerId !== updated.ownerId &&
      (await this.hasRelations(id))
    ) {
      throw new AppError(
        409,
        "HAS_RELATIONS",
        "Нельзя сменить ответственного у клиента со сделками или задачами",
      );
    }
    const result = await this.repo(kind).update(
      id,
      patch as Partial<Entities[K]>,
    );
    if (!result) throw new AppError(404, "NOT_FOUND", "Запись не найдена");
    return result;
  }
  private async hasRelations(clientId: string) {
    // MongoDB transactions require sequential operations on their session.
    const deals = await this.repositories.deals.findAll();
    const tasks = await this.repositories.tasks.findAll();
    return [...deals, ...tasks].some((row) => row.clientId === clientId);
  }
  async deleteClient(id: string, user: User) {
    return this.repositories.transaction(() =>
      this.deleteClientRecord(id, user),
    );
  }
  private async deleteClientRecord(id: string, user: User) {
    await this.get("clients", id, user);
    if (await this.hasRelations(id))
      throw new AppError(
        409,
        "HAS_RELATIONS",
        "У клиента есть сделки или задачи. Удаление недоступно, чтобы сохранить историю.",
      );
    await this.repositories.clients.delete(id);
  }
  async stats(user: User) {
    const [clients, deals, tasks] = await Promise.all([
      this.list("clients", user),
      this.list("deals", user),
      this.list("tasks", user),
    ]);
    const active = deals.filter(
      (row) => row.stage !== "won" && row.stage !== "lost",
    );
    const won = deals.filter((row) => row.stage === "won");
    const closed = deals.filter(
      (row) => row.stage === "won" || row.stage === "lost",
    );
    return {
      newLeads: clients.filter((row) => row.stage === "new").length,
      activeDeals: active.length,
      pipelineAmount: active.reduce((sum, row) => sum + row.amount, 0),
      conversion: closed.length
        ? Math.round((won.length / closed.length) * 100)
        : 0,
      totalClients: clients.length,
      totalDeals: deals.length,
      wonAmount: won.reduce((sum, row) => sum + row.amount, 0),
      byStage: stages.map((stage) => ({
        stage,
        count: deals.filter((row) => row.stage === stage).length,
        amount: deals
          .filter((row) => row.stage === stage)
          .reduce((sum, row) => sum + row.amount, 0),
      })),
      recentTasks: tasks
        .filter((row) => !row.completed)
        .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
        .slice(0, 5),
    };
  }
}
