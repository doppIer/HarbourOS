// Sessions, login, sign-up and role checks.
//
// Roles: "admin" can do everything. "member" can see the dashboard and open
// apps, but can't use the terminal, Claude, container controls or settings.
// The first account created becomes admin. Later sign-ups (if enabled in
// Settings) wait as "pending" until an admin approves them.
import crypto from "node:crypto";
import fastifyCookie from "@fastify/cookie";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { db, settings } from "./db.js";
import { env, isTrustedProxy } from "./env.js";
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
function fail(ip: string) {
  if (attempts.size > 5000) for (const [k, v] of attempts) if (v.until < Date.now()) attempts.delete(k);
  const n = (attempts.get(ip)?.n ?? 0) + 1; attempts.set(ip, { n, until: n >= 5 ? Date.now() + 60_000 : 0 }); }

/** Origin header names this same host (direct, or through a proxy that sets X-Forwarded-Host). */
function sameOrigin(origin: string, req: FastifyRequest): boolean {
  let host: string;
  try { host = new URL(origin).host.toLowerCase(); } catch { return false; }
  const hosts = [req.headers.host, req.headers["x-forwarded-host"]].flatMap((h) => (typeof h === "string" ? h.split(",") : [])).map((h) => h.trim().toLowerCase());
  return hosts.includes(host);
}

/** Tailscale Serve on this machine reaches us from loopback or the Docker bridge, never from a tailnet or LAN address. */
function fromLocalProxy(req: FastifyRequest): boolean { return isTrustedProxy(req.socket?.remoteAddress); }

function resolveUser(req: FastifyRequest): { user: User | null; token: string | null } {
  // The header is only trustworthy when Tailscale Serve set it; anyone connecting
  // straight to the port could send it themselves.
  if (env.trustTailscale && fromLocalProxy(req)) {
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

/** Who a raw Cookie header belongs to, for listeners outside Fastify (the frame proxy). */
export function userFromCookieHeader(header: string | undefined): User | null {
  const cookies: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) { try { cookies[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch {} }
  }
  const fake = { cookies, unsignCookie: (v: string) => fastifyCookie.unsign(v, env.sessionSecret), headers: {}, socket: {} } as unknown as FastifyRequest;
  return resolveUser(fake).user;
}

/** Cookie header without HarbourOS's own cookies, so a proxied app never sees them. */
export function withoutOurCookies(header: string | undefined): string | undefined {
  if (!header) return header;
  const rest = header.split(";").map((c) => c.trim()).filter((c) => c && !/^harbor_(session|device)=/.test(c));
  return rest.length ? rest.join("; ") : undefined;
}

function startSession(reply: FastifyReply, user: User) {
  const token = crypto.randomBytes(32).toString("hex");
  db.prepare("INSERT INTO sessions(token,created,user_id) VALUES(?,?,?)").run(token, Date.now(), user.id);
  reply.setCookie(COOKIE, token, { signed: true, httpOnly: true, sameSite: "strict", secure: "auto", path: "/", maxAge: MAX_AGE });
}

/** What a member may call. Everything else needs admin. */
function memberAllowed(method: string, url: string, role: string, decoded = url): boolean {
  const p = url.split("?")[0];
  // Opening an app: one route serves open/activity/stop/restart (/api/apps/:id/:op), so look at the real path.
  const openApp = method === "POST" && /^\/api\/apps\/[^/]+\/(open|activity)$/.test(decoded) && (p === "/api/apps/:id/:op" || p === decoded);
  if (p === "/api/music/test") return false; // makes the server contact Navidrome
  if (p === "/api/nowplaying/status") return false; // setup details are for admins
  // Wall screen: members and paired tablets.
  if (method === "GET" && (p === "/api/wall/profile" || p === "/api/weather" || p === "/api/calendar" || p.startsWith("/api/transit/") || p.startsWith("/api/music/") || p.startsWith("/api/nowplaying"))) return true;
  if (method === "PUT" && p === "/api/wall/profile") return true;
  if (method === "POST" && (p === "/api/nowplaying/control" || p === "/api/nowplaying/volume")) return true;
  if (role === "device") return (method === "GET" && ["/ws", "/api/apps", "/api/containers", "/api/settings", "/api/widgets"].includes(p))
    || openApp;
  if (method === "GET") {
    return p === "/ws" || p === "/api/apps" || p === "/api/containers" || p === "/api/settings" ||
      p === "/api/widgets" || p === "/api/backgrounds";
  }
  if (method === "POST") return openApp;
  if (method === "PUT") return p === "/api/me" || p === "/api/me/password";
  return false;
}

const PUBLIC = new Set(["/api/devices/pair", "/api/login", "/api/signup", "/api/me", "/api/auth/config", "/api/logout", "/api/password/forgot", "/api/password/reset", "/api/nowplaying/push"]); // push checks its own token

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
    // Also per account, so guesses spread over many addresses still hit a wall.
    const acct = "acct:" + email.toLowerCase();
    if (limited(acct)) return reply.code(429).send({ error: "Too many attempts. Try again in a minute." });
    const u = users.check(email, password);
    if (!u) { fail(req.ip); fail(acct); return reply.code(401).send({ error: "That email and password don't match." }); }
    if (u.status !== "active") return reply.code(403).send({ error: "Your account is waiting for an admin to approve it." });
    attempts.delete(req.ip); attempts.delete(acct);
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
    // Check the path the router will actually run. The raw URL can be percent-encoded
    // ("/%61pi/files" routes to "/api/files"), so never decide on it alone: use the
    // matched route pattern, and the decoded path for unmatched requests.
    let decoded: string;
    try { decoded = decodeURIComponent(req.url.split("?")[0]); } catch { return reply.code(400).send({ error: "Bad URL." }); }
    const route = req.routeOptions?.url;
    const url = route && route !== "*" && route !== "/*" ? route : decoded;
    const isGuarded = (p: string) => p.startsWith("/api/") || p.startsWith("/ws") || p.startsWith("/widgets/") || p.startsWith("/user-");
    const guarded = isGuarded(url) || isGuarded(decoded);
    // /api/me is public only for reading who you are; changing your name needs a session.
    const isPublic = PUBLIC.has(url) && PUBLIC.has(decoded) && !(url === "/api/me" && req.method !== "GET");
    if (!guarded || isPublic) return;
    // Cross-site WebSockets aren't covered by CORS or SameSite=Strict (other ports on
    // this host are the same site): only accept them from HarbourOS's own page.
    const origin = req.headers.origin;
    if (origin && (url.startsWith("/ws") || req.method !== "GET") && !sameOrigin(origin, req)) {
      return reply.code(403).send({ error: "Cross-origin request refused." });
    }
    const { user, token } = resolveUser(req);
    if (!user) return reply.code(401).send({ error: "Sign in first." });
    req.user = user;
    req.sessionToken = token;
    const readOnlyShared = (req.method === "GET" || req.method === "HEAD") && (url.startsWith("/widgets/") || url.startsWith("/user-"));
    if (user.role !== "admin" && !readOnlyShared && !memberAllowed(req.method, url, user.role, decoded)) {
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
