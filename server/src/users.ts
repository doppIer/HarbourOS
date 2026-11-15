// Accounts: scrypt-hashed passwords, roles (admin | member), approval status.
import crypto from "node:crypto";
import { db } from "./db.js";

export type Role = "admin" | "member" | "device"; // device: a paired wall tablet
export type Status = "active" | "pending";
export interface User { id: string; email: string; name: string; role: Role; status: Status; created: number }

const N = 16384, KEYLEN = 64;
export function hashPassword(pw: string): string {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw, salt, KEYLEN, { N });
  return `scrypt$${N}$${salt.toString("hex")}$${key.toString("hex")}`;
}
export function verifyPassword(pw: string, stored: string): boolean {
  const [alg, n, salt, key] = stored.split("$");
  if (alg !== "scrypt" || !salt || !key) return false;
  const got = crypto.scryptSync(pw, Buffer.from(salt, "hex"), KEYLEN, { N: Number(n) });
  return crypto.timingSafeEqual(got, Buffer.from(key, "hex"));
}
// Same work for unknown emails, so timing doesn't reveal which accounts exist.
const DUMMY = hashPassword(crypto.randomBytes(8).toString("hex"));

const pub = (r: any): User | null =>
  r ? { id: r.id, email: r.email, name: r.name, role: r.role, status: r.status, created: r.created } : null;

export const users = {
  count: () => (db.prepare("SELECT COUNT(*) n FROM users").get() as any).n as number,
  activeAdmins: () => (db.prepare("SELECT COUNT(*) n FROM users WHERE role='admin' AND status='active'").get() as any).n as number,
  get: (id: string) => pub(db.prepare("SELECT * FROM users WHERE id=?").get(id)),
  byEmail: (email: string) => pub(db.prepare("SELECT * FROM users WHERE email=?").get(email.trim())),
  all: () => (db.prepare("SELECT * FROM users ORDER BY created").all() as any[]).map((r) => pub(r)!),

  create(email: string, name: string, password: string, role: Role, status: Status): User {
    const id = crypto.randomUUID();
    db.prepare("INSERT INTO users(id,email,name,hash,role,status,created) VALUES(?,?,?,?,?,?,?)")
      .run(id, email.trim(), name.trim(), hashPassword(password), role, status, Date.now());
    return users.get(id)!;
  },

  /** Returns the user only if the password matches (any status). */
  check(email: string, password: string): User | null {
    const r: any = db.prepare("SELECT * FROM users WHERE email=?").get(email.trim());
    const ok = verifyPassword(password, r?.hash ?? DUMMY);
    return r && ok ? pub(r) : null;
  },

  update(id: string, patch: Partial<Pick<User, "role" | "status" | "name">>) {
    const u = users.get(id);
    if (!u) return null;
    const n = { ...u, ...patch };
    db.prepare("UPDATE users SET role=?, status=?, name=? WHERE id=?").run(n.role, n.status, n.name, id);
    if (n.status !== "active") db.prepare("DELETE FROM sessions WHERE user_id=?").run(id);
    return users.get(id);
  },

  setPassword(id: string, pw: string, keepSession?: string) {
    db.prepare("UPDATE users SET hash=? WHERE id=?").run(hashPassword(pw), id);
    db.prepare("DELETE FROM sessions WHERE user_id=? AND token<>?").run(id, keepSession ?? "");
  },

  remove(id: string) {
    db.prepare("DELETE FROM sessions WHERE user_id=?").run(id);
    db.prepare("DELETE FROM users WHERE id=?").run(id);
  },
};

// ---- password reset codes ----
// There's no mail server, so a code is either shown to an admin (Settings →
// Users) or printed to the server log for whoever has shell access.
db.exec("CREATE TABLE IF NOT EXISTS password_resets (user_id TEXT PRIMARY KEY, hash TEXT NOT NULL, expires INTEGER NOT NULL, tries INTEGER NOT NULL DEFAULT 0)");
const RESET_TTL = 15 * 60_000;
const ALPHA = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I/L
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const norm = (c: string) => c.toUpperCase().replace(/[^A-Z0-9]/g, "");

export const resets = {
  /** New one-time code for a user, replacing any earlier one. */
  create(userId: string): { code: string; expires: number } {
    const raw = Array.from(crypto.randomBytes(8), (b) => ALPHA[b % ALPHA.length]).join("");
    const expires = Date.now() + RESET_TTL;
    db.prepare("INSERT OR REPLACE INTO password_resets(user_id,hash,expires,tries) VALUES(?,?,?,0)").run(userId, sha(raw), expires);
    return { code: `${raw.slice(0, 4)}-${raw.slice(4)}`, expires };
  },
  /** True if the code is right; 5 wrong tries or expiry burns it. */
  use(userId: string, code: string): boolean {
    const r: any = db.prepare("SELECT * FROM password_resets WHERE user_id=?").get(userId);
    if (!r) return false;
    if (r.expires < Date.now() || r.tries >= 5) { db.prepare("DELETE FROM password_resets WHERE user_id=?").run(userId); return false; }
    const ok = crypto.timingSafeEqual(Buffer.from(sha(norm(code))), Buffer.from(r.hash));
    if (ok) db.prepare("DELETE FROM password_resets WHERE user_id=?").run(userId);
    else db.prepare("UPDATE password_resets SET tries=tries+1 WHERE user_id=?").run(userId);
    return ok;
  },
};

export const validEmail = (e: unknown): e is string =>
  typeof e === "string" && e.length < 200 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim());
export const validPassword = (p: unknown): p is string => typeof p === "string" && p.length >= 8 && p.length <= 200;
