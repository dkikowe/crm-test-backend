import { Router } from "express";
import { AuthService, publicUser, SESSION_MS } from "../services/auth.js";
import { z } from "zod";
import { AppError } from "../errors.js";
import type { Repositories } from "../repositories/interfaces.js";
import { CrmService } from "../services/crm.js";
import { authenticate, sessionToken } from "../middleware/auth.js";
import { createSchemas, patchSchemas } from "../validation.js";
export function createRoutes(
  repositories: Repositories,
  isHealthy: () => Promise<boolean>,
  frontendUrl: string,
) {
  const router = Router();
  const service = new CrmService(repositories);
  const auth = new AuthService(repositories);
  const secure = frontendUrl.startsWith("https:");
  const cookieName = secure ? "__Host-salespace" : "salespace_session";
  const cookieOptions = { httpOnly: true, secure, sameSite: "lax" as const, path: "/" };
  const email = z.email("Укажите корректный email").max(254).transform(v => v.toLowerCase());
  const password = z.string().min(12, "Пароль: минимум 12 символов").max(128, "Пароль: максимум 128 символов");
  const loginSchema = z.object({ email: z.string().trim().pipe(email), password: z.string().min(1).max(128) }).strict();
  const registerSchema = z.object({ email: z.string().trim().pipe(email), password, name: z.string().trim().min(2).max(100), inviteToken: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict();
  router.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  router.use((req, _res, next) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && req.get("X-CRM-Request") !== "1") throw new AppError(403, "CSRF_REJECTED", "Запрос отклонён. Обновите страницу.");
    next();
  });
  for (const action of ["login", "register"] as const) {
    router.post(`/auth/${action}`, async (req, res) => {
      const data = action === "register" ? registerSchema.parse(req.body) : loginSchema.parse(req.body);
      await auth.throttle("auth-global", 120);
      await auth.throttle(`auth-email:${data.email}`);
      const result = action === "register"
        ? await auth.register(registerSchema.parse(data))
        : await auth.login(data.email, data.password);
      await auth.logout(sessionToken(req, cookieName));
      res.cookie(cookieName, result.token, { ...cookieOptions, maxAge: SESSION_MS });
      res.status(action === "register" ? 201 : 200).json(result.user);
    });
  }
  router.post("/auth/logout", async (req, res) => {
    await auth.logout(sessionToken(req, cookieName));
    res.clearCookie(cookieName, cookieOptions).status(204).end();
  });
  router.get("/health", async (_req, res) => {
    const healthy = await isHealthy();
    res.status(healthy ? 200 : 503).json({ status: healthy ? "ok" : "error" });
  });
  router.use(authenticate(auth, cookieName));
  router.get("/auth/me", (req, res) => { res.json(req.user); });
  router.post("/auth/password", async (req, res) => {
    const data = z.object({ oldPassword: z.string().min(1).max(128), newPassword: password }).strict().parse(req.body);
    await auth.throttle(`password:${req.user.id}`);
    await auth.changePassword(req.user, data.oldPassword, data.newPassword);
    res.clearCookie(cookieName, cookieOptions).status(204).end();
  });
  router.get("/users", async (req, res) => {
    const rows = req.user.role === "manager" ? [req.user] : (await repositories.users.findAll()).map(publicUser);
    res.json(rows);
  });
  router.patch("/users/:id/role", async (req, res) => {
    const { role } = z.object({ role: z.enum(["admin", "rop", "manager"]) }).strict().parse(req.body);
    res.json(await auth.setRole(req.user, String(req.params.id), role));
  });
  for (const kind of ["clients", "deals", "tasks"] as const) {
    router.get(`/${kind}`, async (req, res) => {
      res.json(await service.list(kind, req.user));
    });
    router.get(`/${kind}/:id`, async (req, res) => {
      res.json(await service.get(kind, String(req.params.id), req.user));
    });
    router.post(`/${kind}`, async (req, res) => {
      const data = createSchemas[kind].parse(req.body);
      res.status(201).json(await service.create(kind, data, req.user));
    });
    router.patch(`/${kind}/:id`, async (req, res) => {
      const data = patchSchemas[kind].parse(req.body);
      res.json(
        await service.update(kind, String(req.params.id), data, req.user),
      );
    });
  }
  router.delete("/clients/:id", async (req, res) => {
    await service.deleteClient(String(req.params.id), req.user);
    res.status(204).end();
  });
  router.get("/stats", async (req, res) => {
    res.json(await service.stats(req.user));
  });
  return router;
}
