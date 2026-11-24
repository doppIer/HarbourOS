// Passkeys (WebAuthn): sign in with Face ID, Touch ID, Windows Hello or a
// security key instead of a password. Passkeys are added from Settings while
// signed in, and are discoverable, so signing in needs no email first.
//
// Browsers only offer passkeys on a secure origin: https (Tailscale Serve, a
// reverse proxy) or localhost. On plain http://<lan-ip> the login screen hides
// the button. A passkey belongs to the host name it was made on.
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  generateAuthenticationOptions, generateRegistrationOptions,
  verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticatorTransportFuture,
} from "@simplewebauthn/server";
import { db } from "./db.js";
import { users } from "./users.js";

db.exec(`CREATE TABLE IF NOT EXISTS passkeys (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, public_key BLOB NOT NULL, counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT, name TEXT NOT NULL, rp_id TEXT NOT NULL, created INTEGER NOT NULL, last_used INTEGER
)`);

interface Row { id: string; user_id: string; public_key: Buffer; counter: number; transports: string | null; name: string; rp_id: string; created: number; last_used: number | null }

export const passkeys = {
  forUser: (userId: string) => db.prepare("SELECT id, name, rp_id, created, last_used FROM passkeys WHERE user_id=? ORDER BY created").all(userId) as Omit<Row, "user_id" | "public_key" | "counter" | "transports">[],
  get: (id: string) => db.prepare("SELECT * FROM passkeys WHERE id=?").get(id) as Row | undefined,
  removeAllFor: (userId: string) => db.prepare("DELETE FROM passkeys WHERE user_id=?").run(userId),
};

// Challenges live a few minutes, in memory, and work once.
const CHALLENGE_TTL = 5 * 60_000;
const challenges = new Map<string, { until: number; userId?: string }>();
function remember(challenge: string, userId?: string) {
  for (const [k, v] of challenges) if (v.until < Date.now()) challenges.delete(k);
  challenges.set(challenge, { until: Date.now() + CHALLENGE_TTL, userId });
}
function take(challenge: string, userId?: string): boolean {
  const c = challenges.get(challenge);
  challenges.delete(challenge);
  return !!c && c.until > Date.now() && c.userId === userId;
}

export interface PasskeyDeps {
  sameOrigin: (origin: string, req: FastifyRequest) => boolean;
  limited: (key: string) => boolean;
  fail: (key: string) => void;
  startSession: (reply: any, user: NonNullable<ReturnType<typeof users.get>>) => void;
}

/** The page's own origin and host name, or null when the request didn't come from HarbourOS's page. */
function site(req: FastifyRequest, sameOrigin: PasskeyDeps["sameOrigin"]) {
  const origin = req.headers.origin;
  if (typeof origin !== "string" || !sameOrigin(origin, req)) return null;
  return { origin, rpID: new URL(origin).hostname };
}

export function registerPasskeys(app: FastifyInstance, d: PasskeyDeps) {
  const noSite = { error: "Passkeys need HarbourOS opened over https (or on localhost)." };

  // ---- adding a passkey (signed in) ----
  app.post("/api/me/passkeys/options", async (req, reply) => {
    const u = req.user;
    if (!u || u.role === "device") return reply.code(403).send({ error: "Sign in with an account first." });
    const s = site(req, d.sameOrigin);
    if (!s) return reply.code(400).send(noSite);
    const existing = db.prepare("SELECT id, transports FROM passkeys WHERE user_id=? AND rp_id=?").all(u.id, s.rpID) as Pick<Row, "id" | "transports">[];
    const opts = await generateRegistrationOptions({
      rpName: "HarbourOS", rpID: s.rpID, userName: u.email, userDisplayName: u.name,
      userID: new TextEncoder().encode(u.id),
      attestationType: "none",
      excludeCredentials: existing.map((c) => ({ id: c.id, transports: c.transports ? JSON.parse(c.transports) : undefined })),
      authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
    });
    remember(opts.challenge, u.id);
    return opts;
  });

  app.post("/api/me/passkeys", async (req, reply) => {
    const u = req.user;
    if (!u || u.role === "device") return reply.code(403).send({ error: "Sign in with an account first." });
    const s = site(req, d.sameOrigin);
    if (!s) return reply.code(400).send(noSite);
    const { response, name } = (req.body ?? {}) as { response?: any; name?: string };
    let v;
    try {
      v = await verifyRegistrationResponse({
        response, expectedChallenge: (c) => take(c, u.id), expectedOrigin: s.origin, expectedRPID: s.rpID, requireUserVerification: false,
      });
    } catch (e) { return reply.code(400).send({ error: `That passkey couldn't be added: ${(e as Error).message}` }); }
    if (!v.verified) return reply.code(400).send({ error: "That passkey couldn't be verified." });
    const c = v.registrationInfo.credential;
    const label = (typeof name === "string" && name.trim()) ? name.trim().slice(0, 60) : guessName(req.headers["user-agent"]);
    db.prepare("INSERT OR REPLACE INTO passkeys(id,user_id,public_key,counter,transports,name,rp_id,created) VALUES(?,?,?,?,?,?,?,?)")
      .run(c.id, u.id, Buffer.from(c.publicKey), c.counter, JSON.stringify(c.transports ?? []), label, s.rpID, Date.now());
    return { ok: true, passkeys: passkeys.forUser(u.id) };
  });

  app.get("/api/me/passkeys", async (req, reply) => {
    if (!req.user || req.user.role === "device") return reply.code(403).send({ error: "Sign in with an account first." });
    return passkeys.forUser(req.user.id);
  });

  app.delete("/api/me/passkeys/:id", async (req, reply) => {
    if (!req.user || req.user.role === "device") return reply.code(403).send({ error: "Sign in with an account first." });
    const { id } = req.params as { id: string };
    db.prepare("DELETE FROM passkeys WHERE id=? AND user_id=?").run(id, req.user.id);
    return passkeys.forUser(req.user.id);
  });

  // ---- signing in with a passkey (public) ----
  app.post("/api/login/passkey/options", async (req, reply) => {
    if (d.limited(req.ip)) return reply.code(429).send({ error: "Too many attempts. Try again in a minute." });
    const s = site(req, d.sameOrigin);
    if (!s) return reply.code(400).send(noSite);
    const opts = await generateAuthenticationOptions({ rpID: s.rpID, userVerification: "preferred" });
    remember(opts.challenge);
    return opts;
  });

  app.post("/api/login/passkey", async (req, reply) => {
    if (d.limited(req.ip)) return reply.code(429).send({ error: "Too many attempts. Try again in a minute." });
    const s = site(req, d.sameOrigin);
    if (!s) return reply.code(400).send(noSite);
    const { response } = (req.body ?? {}) as { response?: any };
    const row = typeof response?.id === "string" ? passkeys.get(response.id) : undefined;
    if (!row || row.rp_id !== s.rpID) { d.fail(req.ip); return reply.code(401).send({ error: "This passkey isn't set up on this server. Sign in with your password, then add it in Settings → Account." }); }
    let v;
    try {
      v = await verifyAuthenticationResponse({
        response, expectedChallenge: (c) => take(c), expectedOrigin: s.origin, expectedRPID: s.rpID, requireUserVerification: false,
        credential: { id: row.id, publicKey: new Uint8Array(row.public_key), counter: row.counter, transports: row.transports ? JSON.parse(row.transports) as AuthenticatorTransportFuture[] : undefined },
      });
    } catch (e) { d.fail(req.ip); return reply.code(401).send({ error: `Passkey sign-in failed: ${(e as Error).message}` }); }
    if (!v.verified) { d.fail(req.ip); return reply.code(401).send({ error: "Passkey sign-in failed." }); }
    const u = users.get(row.user_id);
    if (!u) return reply.code(401).send({ error: "That account no longer exists." });
    if (u.status !== "active") return reply.code(403).send({ error: "Your account is waiting for an admin to approve it." });
    db.prepare("UPDATE passkeys SET counter=?, last_used=? WHERE id=?").run(v.authenticationInfo.newCounter, Date.now(), row.id);
    d.startSession(reply, u);
    return { user: u };
  });
}

function guessName(ua: unknown): string {
  const s = typeof ua === "string" ? ua : "";
  const os = /iPhone/.test(s) ? "iPhone" : /iPad/.test(s) ? "iPad" : /Mac OS X/.test(s) ? "Mac" : /Android/.test(s) ? "Android" : /Windows/.test(s) ? "Windows" : /Linux/.test(s) ? "Linux" : "Device";
  const br = /Edg\//.test(s) ? "Edge" : /Firefox\//.test(s) ? "Firefox" : /Chrome\//.test(s) ? "Chrome" : /Safari\//.test(s) ? "Safari" : "";
  return `${os}${br ? ` · ${br}` : ""} (${new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })})`;
}
