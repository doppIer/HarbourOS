// Accounts: scrypt-hashed passwords, roles (admin | member), approval status.
import crypto from "node:crypto";
import { db } from "./db.js";

export type Role = "admin" | "member";
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

export const validEmail = (e: unknown): e is string =>
  typeof e === "string" && e.length < 200 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim());
export const validPassword = (p: unknown): p is string => typeof p === "string" && p.length >= 8 && p.length <= 200;
