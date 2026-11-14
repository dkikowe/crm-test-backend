import { randomUUID } from "node:crypto";
import type { Account, User } from "../domain.js";
import type { Repositories } from "../repositories/interfaces.js";
import { AppError } from "../errors.js";
import { hashPassword, verifyPassword, tokenHash, newToken, passwordWork } from "../security/passwords.js";
export const SESSION_MS = 8 * 60 * 60 * 1000;
export function publicUser(account: Account): User {
  return { id: account.id, name: account.name, email: account.email, role: account.role, createdAt: account.createdAt };
}
export class AuthService {
  constructor(private repos: Repositories) {}
  async throttle(key: string, limit = 10) {
    const denied = await this.repos.transaction(async () => {
      const id = tokenHash(key), old = await this.repos.authAttempts.findById(id);
      const now = Date.now();
      if (old && old.expiresAt.getTime() > now) {
        if (old.count >= limit) return true;
        await this.repos.authAttempts.update(id, { count: old.count + 1 });
      } else {
        const row = { id, count: 1, expiresAt: new Date(now + 15 * 60 * 1000) };
        if (old) await this.repos.authAttempts.update(id, row);
        else await this.repos.authAttempts.create(row);
      }
      return false;
    });
    if (denied) throw new AppError(429, "RATE_LIMITED", "Слишком много попыток. Повторите через 15 минут.");
  }
  async register(input: { name: string; email: string; password: string; inviteToken?: string }) {
    const passwordHash = await passwordWork(() => hashPassword(input.password));
    return this.repos.transaction(async () => {
      if (await this.repos.users.findByEmail(input.email)) throw new AppError(409, "ACCOUNT_EXISTS", "Регистрация с этим email недоступна. Попробуйте войти.");
      const invite = input.inviteToken ? await this.repos.invites.findById(tokenHash(input.inviteToken)) : undefined;
      if (input.inviteToken && (!invite || (invite.email !== null && invite.email !== input.email) || invite.expiresAt.getTime() <= Date.now())) throw new AppError(400, "INVALID_INVITE", "Приглашение недействительно или истекло.");
      // An outstanding invitation reserves privileged accounts until its token is supplied.
      const reserved = (await this.repos.invites.findAll()).some(i => i.email === input.email && i.expiresAt.getTime() > Date.now());
      if (reserved && !invite) throw new AppError(403, "INVITE_REQUIRED", "Для этого email требуется ссылка приглашения.");
      const account: Account = { id: randomUUID(), name: input.name, email: input.email, role: invite?.role ?? "manager", passwordHash, createdAt: new Date().toISOString() };
      await this.repos.users.create(account);
      if (invite) await this.repos.invites.delete(invite.id);
      if (account.role === "admin") {
        // Preserve real records entered during the previous passwordless version.
        for (const kind of ["clients", "deals", "tasks"] as const) {
          for (const row of await this.repos[kind].findAll()) {
            if (["u-admin", "u-rop", "u-manager"].includes(row.ownerId)) await this.repos[kind].update(row.id, { ownerId: account.id });
          }
        }
      }
      return this.issue(account);
    });
  }
  async login(email: string, password: string) {
    const account = await this.repos.users.findByEmail(email);
    const verified = await passwordWork(() => verifyPassword(password, account?.passwordHash));
    if (!account || !verified) throw new AppError(401, "INVALID_CREDENTIALS", "Неверный email или пароль.");
    return this.repos.transaction(async () => {
      const current = await this.repos.users.findById(account.id);
      if (!current || current.passwordHash !== account.passwordHash) throw new AppError(401, "INVALID_CREDENTIALS", "Неверный email или пароль.");
      return this.issue(current);
    });
  }
  private async issue(account: Account) {
    const token = newToken();
    await this.repos.sessions.create({ id: tokenHash(token), userId: account.id, expiresAt: new Date(Date.now() + SESSION_MS) });
    return { user: publicUser(account), token };
  }
  async current(token?: string) {
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return undefined;
    const session = await this.repos.sessions.findById(tokenHash(token));
    if (!session || session.expiresAt.getTime() <= Date.now()) return undefined;
    const user = await this.repos.users.findById(session.userId);
    return user?.passwordHash ? publicUser(user) : undefined;
  }
  async logout(token?: string) {
    if (token) await this.repos.sessions.delete(tokenHash(token));
  }
  async changePassword(user: User, oldPassword: string, newPassword: string) {
    const old = await this.repos.users.findById(user.id);
    const passwordHash = await passwordWork(async () => {
      if (!old || !await verifyPassword(oldPassword, old.passwordHash)) throw new AppError(400, "INVALID_PASSWORD", "Текущий пароль неверен.");
      return hashPassword(newPassword);
    });
    return this.repos.transaction(async () => {
      const current = await this.repos.users.findById(user.id);
      if (!current || current.passwordHash !== old!.passwordHash) throw new AppError(409, "PASSWORD_CHANGED", "Пароль уже изменён. Войдите снова.");
      await this.repos.users.update(user.id, { passwordHash });
      await this.revokeAll(user.id);
    });
  }
  async revokeAll(userId: string) {
    for (const session of await this.repos.sessions.findAll()) if (session.userId === userId) await this.repos.sessions.delete(session.id);
  }
  async setRole(actor: User, id: string, role: User["role"]) {
    return this.repos.transaction(async () => {
      const currentActor = await this.repos.users.findById(actor.id);
      if (currentActor?.role !== "admin") throw new AppError(403, "FORBIDDEN", "Роли изменяет только администратор.");
      const target = await this.repos.users.findById(id);
      if (!target) throw new AppError(404, "NOT_FOUND", "Пользователь не найден.");
      if (target.role === "admin" && role !== "admin" && (await this.repos.users.findAll()).filter(u => u.role === "admin").length <= 1) throw new AppError(409, "LAST_ADMIN", "Нельзя убрать последнего администратора.");
      const updated = await this.repos.users.update(id, { role });
      await this.revokeAll(id);
      return publicUser(updated!);
    });
  }
}
