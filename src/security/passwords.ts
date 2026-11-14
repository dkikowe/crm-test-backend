import { randomBytes, scrypt, timingSafeEqual, createHash } from "node:crypto";
const N = 131072, r = 8, p = 1;
function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, { N, r, p, maxmem: 256 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key));
  });
}
// Bound expensive concurrent work, also on large multi-core hosts.
let running = 0;
export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const hash = await derive(password, salt);
  return `scrypt$${N}$${r}$${p}$${salt}$${hash.toString("hex")}`;
}
export async function verifyPassword(password: string, stored?: string) {
  const parts = stored?.split("$");
  const valid = parts?.length === 6 && parts[0] === "scrypt" && parts[1] === String(N) && parts[2] === String(r) && parts[3] === String(p) && /^[a-f0-9]{32}$/.test(parts[4]!) && /^[a-f0-9]{128}$/.test(parts[5]!);
  const derived = await derive(password, valid ? parts![4]! : "0".repeat(32));
  const expected = Buffer.from(valid ? parts![5]! : "0".repeat(128), "hex");
  return timingSafeEqual(derived, expected) && Boolean(valid);
}
export async function passwordWork<T>(work: () => Promise<T>): Promise<T> {
  if (running >= 2) {
    const { AppError } = await import("../errors.js");
    throw new AppError(429, "AUTH_BUSY", "Слишком много попыток. Повторите через минуту.");
  }
  running++;
  try { return await work(); } finally { running--; }
}
export const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
export const newToken = () => randomBytes(32).toString("hex");
