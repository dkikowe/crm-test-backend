import type { RequestHandler } from "express";
import type { UserService } from "../services/users.js";
import type { User } from "../domain.js";
import { AppError } from "../errors.js";
declare global {
  namespace Express {
    interface Request {
      user: User;
    }
  }
}
export function authenticate(users: UserService): RequestHandler {
  return async (req, _res, next) => {
    const id = req.get("X-User-Id");
    const user = id ? await users.findById(id) : undefined;
    if (!user)
      throw new AppError(401, "UNAUTHORIZED", "Выберите демо-пользователя");
    req.user = user;
    next();
  };
}
