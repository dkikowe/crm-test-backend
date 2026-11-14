import "dotenv/config";
import { writeFile } from "node:fs/promises";
import { z } from "zod";
import { connectStorage } from "../database/connection.js";
import { readConfig } from "../config.js";
import { newToken, tokenHash } from "../security/passwords.js";
const email = process.argv[2] === "-" ? null : z.email().parse(process.argv[2]?.trim().toLowerCase());
const output = process.argv[3];
if (!output) throw new Error("Usage: npm run admin:invite -- EMAIL /absolute/private/file.txt");
const env = readConfig();
const storage = await connectStorage(env.MONGODB_URI, env.MONGODB_DB_NAME);
try {
  const token = newToken();
  await storage.repositories.transaction(async () => {
    if ((await storage.repositories.users.findAll()).some(u => u.role === "admin")) throw new Error("Administrator already exists. Use the team page to manage roles.");
    if (email && await storage.repositories.users.findByEmail(email)) throw new Error("This email already has an account.");
    for (const invite of await storage.repositories.invites.findAll()) if (invite.role === "admin") await storage.repositories.invites.delete(invite.id);
    await storage.repositories.invites.create({ id: tokenHash(token), email, role: "admin", expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) });
  });
  const url = `${env.FRONTEND_URL}/register#invite=${token}&email=${encodeURIComponent(email ?? "")}`;
  await writeFile(output, `Одноразовое приглашение администратора (24 часа).\nОткройте ссылку и задайте свой пароль:\n${url}\n`, { mode: 0o600, flag: "wx" });
  console.log("Invitation saved to the private output file. Do not commit it.");
} finally { await storage.close(); }
