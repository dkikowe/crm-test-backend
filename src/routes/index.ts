import { Router } from "express";
import { UserService } from "../services/users.js";
import type { Repositories } from "../repositories/interfaces.js";
import { CrmService } from "../services/crm.js";
import { authenticate } from "../middleware/auth.js";
import { createSchemas, patchSchemas } from "../validation.js";
export function createRoutes(
  repositories: Repositories,
  isHealthy: () => Promise<boolean>,
) {
  const router = Router();
  const service = new CrmService(repositories);
  const users = new UserService(repositories.users);
  router.get("/health", async (_req, res) => {
    const healthy = await isHealthy();
    res.status(healthy ? 200 : 503).json({ status: healthy ? "ok" : "error" });
  });
  // Public on purpose: this list powers the passwordless demo login screen.
  router.get("/users", async (_req, res) => {
    res.json(await users.list());
  });
  router.use(authenticate(users));
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
