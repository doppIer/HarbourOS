// Sessions, login, sign-up and role checks.
//
// Roles: "admin" can do everything. "member" can see the dashboard and open
// apps, but can't use the terminal, Claude, container controls or settings.
// The first account created becomes admin. Later sign-ups (if enabled in
// Settings) wait as "pending" until an admin approves them.
import crypto from "node:crypto";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { db, settings } from "./db.js";
import { env } from "./env.js";
import { deviceUser } from "./wall.js";
import { resets, users, validEmail, validPassword, type User } from "./users.js";

const COOKIE = "harbor_session";
const MAX_AGE = 60 * 60 * 24 * 30; // 30 days

declare module "fastify" {
  interface FastifyRequest { user: User | null; sessionToken: string | null }
}

// small in-memory rate limit per IP for login/sign-up
const attempts = new Map<string, { n: number; until: number }>();
function limited(ip: string) { const a = attempts.get(ip); return !!a && a.until > Date.now(); }
function fail(ip: string) { const n = (attempts.get(ip)?.n ?? 0) + 1; attempts.set(ip, { n, until: n >= 5 ? Date.now() + 60_000 : 0 }); }

function resolveUser(req: FastifyRequest): { user: User | null; token: string | null } {
  if (env.trustTailscale) {
    const login = req.headers["tailscale-user-login"];
    if (typeof login === "string" && (env.tailscaleUsers.length === 0 || env.tailscaleUsers.includes(login))) {
      const u = users.byEmail(login);
      if (u?.status === "active") return { user: u, token: null };
    }
  }
  const raw = req.cookies[COOKIE];
  if (!raw) return { user: deviceUser(req), token: null };
  const un = req.unsignCookie(raw);
  if (!un.valid || !un.value) return { user: null, token: null };
  const row: any = db.prepare("SELECT created, user_id FROM sessions WHERE token=?").get(un.value);
  if (!row || Date.now() - row.created > MAX_AGE * 1000) return { user: deviceUser(req), token: null };
  const u = users.get(row.user_id);
  return { user: u?.status === "active" ? u : null, token: un.value };
}

function startSession(reply: FastifyReply, user: User) {
  const token = crypto.randomBytes(32).toString("hex");
  db.prepare("INSERT INTO sessions(token,created,user_id) VALUES(?,?,?)").run(token, Date.now(), user.id);
  reply.setCookie(COOKIE, token, { signed: true, httpOnly: true, sameSite: "strict", secure: "auto", path: "/", maxAge: MAX_AGE });
}

/** What a member may call. Everything else needs admin. */
function memberAllowed(method: string, url: string, role: string): boolean {
  const p = url.split("?")[0];
  // Wall screen: members and paired tablets.
  if (method === "GET" && (p === "/api/wall/profile" || p === "/api/weather" || p === "/api/calendar" || p.startsWith("/api/transit/") || p.startsWith("/api/music/"))) return true;
  if (method === "PUT" && p === "/api/wall/profile") return true;
  if (role === "device") return (method === "GET" && ["/ws", "/api/apps", "/api/containers", "/api/settings", "/api/widgets"].includes(p))
    || (method === "POST" && /^\/api\/apps\/[^/]+\/(open|activity)$/.test(p));
  if (method === "GET") {
    return p === "/ws" || p === "/api/apps" || p === "/api/containers" || p === "/api/settings" ||
      p === "/api/widgets" || p === "/api/backgrounds";
  }
  if (method === "POST") return /^\/api\/apps\/[^/]+\/(open|activity)$/.test(p);
  if (method === "PUT") return p === "/api/me" || p === "/api/me/password";
  return false;
}

const PUBLIC = new Set(["/api/devices/pair", "/api/login", "/api/signup", "/api/me", "/api/auth/config", "/api/logout", "/api/password/forgot", "/api/password/reset"]);

export async function registerAuth(app: FastifyInstance) {
  // Bootstrap: an admin from HARBOR_PASSWORD on a fresh install (optional).
  if (users.count() === 0 && env.password) {
    users.create(process.env.HARBOR_ADMIN_EMAIL || "admin@harbor.local", "Admin", env.password, "admin", "active");
    app.log.warn("Created admin account from HARBOR_PASSWORD.");
  }

  app.decorateRequest("user", null);
  app.decorateRequest("sessionToken", null);

  // Public: lets the login screen know what to show.
  app.get("/api/auth/config", async () => {
    const s = settings.get();
    return { needsSetup: users.count() === 0, allowSignup: s.allowSignup, background: s.loginBackground, accent: s.accent };
  });

  app.post("/api/login", async (req, reply) => {
    if (limited(req.ip)) return reply.code(429).send({ error: "Too many attempts. Try again in a minute." });
    const { email, password } = (req.body ?? {}) as { email?: string; password?: string };
    if (!validEmail(email) || typeof password !== "string") return reply.code(400).send({ error: "Enter your email and password." });
    const u = users.check(email, password);
    if (!u) { fail(req.ip); return reply.code(401).send({ error: "That email and password don't match." }); }
    if (u.status !== "active") return reply.code(403).send({ error: "Your account is waiting for an admin to approve it." });
    attempts.delete(req.ip);
    startSession(reply, u);
    return { user: u };
  });

  app.post("/api/signup", async (req, reply) => {
    if (limited(req.ip)) return reply.code(429).send({ error: "Too many attempts. Try again in a minute." });
    const first = users.count() === 0;
    if (!first && !settings.get().allowSignup) return reply.code(403).send({ error: "Sign-ups are turned off. Ask the admin for an account." });
    const { email, password, name } = (req.body ?? {}) as { email?: string; password?: string; name?: string };
    if (!validEmail(email)) return reply.code(400).send({ error: "Enter a valid email address." });
    if (!validPassword(password)) return reply.code(400).send({ error: "Use at least 8 characters for your password." });
    if (users.byEmail(email)) { fail(req.ip); return reply.code(409).send({ error: "That email already has an account. Sign in instead." }); }
    const displayName = (typeof name === "string" && name.trim()) ? name.trim().slice(0, 60) : email.split("@")[0];
    const u = users.create(email, displayName, password, first ? "admin" : "member", first ? "active" : "pending");
    if (u.status === "active") { startSession(reply, u); return { user: u }; }
    return { pending: true };
  });

  // ---- forgotten passwords ----
  // Same answer whether or not the email exists, so this can't be used to
  // discover accounts. The code goes to the server log: only someone with
  // shell access to the server (or an admin, via Settings → Users) sees it.
  app.post("/api/password/forgot", async (req, reply) => {
    if (limited(req.ip)) return reply.code(429).send({ error: "Too many attempts. Try again in a minute." });
    fail(req.ip); // counts toward the limit: codes shouldn't be spammed into the log
    const { email } = (req.body ?? {}) as { email?: string };
    if (!validEmail(email)) return reply.code(400).send({ error: "Enter a valid email address." });
    const u = users.byEmail(email);
    if (u) {
      const { code } = resets.create(u.id);
      console.log(`\n  ┌──────────────────────────────────────────────\n  │ HarbourOS password reset for ${u.email}\n  │ Code: ${code}   (valid 15 minutes, one use)\n  └──────────────────────────────────────────────\n`);
    }
    return { ok: true };
  });

  app.post("/api/password/reset", async (req, reply) => {
    if (limited(req.ip)) return reply.code(429).send({ error: "Too many attempts. Try again in a minute." });
    const { email, code, password } = (req.body ?? {}) as { email?: string; code?: string; password?: string };
    if (!validEmail(email) || typeof code !== "string") return reply.code(400).send({ error: "Enter your email and the reset code." });
    if (!validPassword(password)) return reply.code(400).send({ error: "Use at least 8 characters for the new password." });
    const u = users.byEmail(email);
    if (!u || !resets.use(u.id, code)) { fail(req.ip); return reply.code(400).send({ error: "That code is wrong or has expired. Request a new one." }); }
    users.setPassword(u.id, password); // also signs out every other session
    attempts.delete(req.ip);
    if (u.status !== "active") return { pending: true };
    startSession(reply, u);
    return { user: u };
  });

  app.post("/api/logout", async (req, reply) => {
    const raw = req.cookies[COOKIE];
    const un = raw ? req.unsignCookie(raw) : null;
    if (un?.valid && un.value) db.prepare("DELETE FROM sessions WHERE token=?").run(un.value);
    reply.clearCookie(COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/api/me", async (req) => {
    const { user } = resolveUser(req);
    return { authed: !!user, user };
  });

  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    const url = req.url.split("?")[0];
    const guarded = url.startsWith("/api/") || url.startsWith("/ws") || url.startsWith("/widgets/") || url.startsWith("/user-");
    if (!guarded || PUBLIC.has(url)) return;
    const { user, token } = resolveUser(req);
    if (!user) return reply.code(401).send({ error: "Sign in first." });
    req.user = user;
    req.sessionToken = token;
    if (user.role !== "admin" && !url.startsWith("/widgets/") && !url.startsWith("/user-") && !memberAllowed(req.method, url, user.role)) {
      return reply.code(403).send({ error: "Only an admin can do that." });
    }
  });

  // ---- account ----
  app.put("/api/me", async (req) => {
    const { name } = req.body as { name?: string };
    if (typeof name !== "string" || !name.trim()) throw Object.assign(new Error("Enter a name."), { statusCode: 400 });
    return users.update(req.user!.id, { name: name.trim().slice(0, 60) });
  });
  app.put("/api/me/password", async (req, reply) => {
    const { current, next } = req.body as { current?: string; next?: string };
    if (!users.check(req.user!.email, String(current ?? ""))) return reply.code(400).send({ error: "Your current password is wrong." });
    if (!validPassword(next)) return reply.code(400).send({ error: "Use at least 8 characters for the new password." });
    users.setPassword(req.user!.id, next, req.sessionToken ?? undefined);
    return { ok: true };
  });

  // ---- user admin (admin only, enforced by the hook) ----
  app.get("/api/users", async () => users.all());
  app.patch("/api/users/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { role, status } = req.body as { role?: "admin" | "member"; status?: "active" | "pending" };
    const target = users.get(id);
    if (!target) return reply.code(404).send({ error: "No such user." });
    if (role && !["admin", "member"].includes(role)) return reply.code(400).send({ error: "Unknown role." });
    if (status && !["active", "pending"].includes(status)) return reply.code(400).send({ error: "Unknown status." });
    const losingAdmin = target.role === "admin" && target.status === "active" && (role === "member" || status === "pending");
    if (losingAdmin && users.activeAdmins() <= 1) return reply.code(400).send({ error: "Keep at least one admin." });
    return users.update(id, { ...(role ? { role } : {}), ...(status ? { status } : {}) });
  });
  app.post("/api/users/:id/reset", async (req, reply) => {
    const target = users.get((req.params as { id: string }).id);
    if (!target) return reply.code(404).send({ error: "No such user." });
    return resets.create(target.id); // admin hands the code to the user
  });
  app.delete("/api/users/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const target = users.get(id);
    if (!target) return reply.code(404).send({ error: "No such user." });
    if (target.role === "admin" && target.status === "active" && users.activeAdmins() <= 1) return reply.code(400).send({ error: "Keep at least one admin." });
    users.remove(id);
    return { ok: true };
  });
}
