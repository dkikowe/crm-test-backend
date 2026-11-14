import type { RequestHandler, Request } from "express";
import type { AuthService } from "../services/auth.js";
import type { User } from "../domain.js";
import { AppError } from "../errors.js";
declare global { namespace Express { interface Request { user: User; } } }
export function sessionToken(req: Request, name: string) {
  return req.headers.cookie?.split(";").map(v => v.trim()).find(v => v.startsWith(`${name}=`))?.slice(name.length + 1);
}
export function authenticate(auth: AuthService, cookieName: string): RequestHandler {
  return async (req, _res, next) => {
    const user = await auth.current(sessionToken(req, cookieName));
    if (!user) throw new AppError(401, "UNAUTHORIZED", "Войдите в аккаунт.");
    req.user = user;
    next();
  };
}
