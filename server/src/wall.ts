// Wall mode: a tablet that stays on the /wall screen.
//
// Tablets pair once with a short code (or the QR code that carries it) and
// then hold a long-lived device cookie. A device can see the wall, open apps
// and change its own layout and screen settings, nothing else. An admin can
// revoke it from Settings at any time.
//
// Each device has its own profile (layout + screen settings). Signed-in
// people who open /wall in a browser use the shared "default" profile.
import crypto from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import QRCode from "qrcode";
import { db } from "./db.js";
import type { User } from "./users.js";

db.exec(`
CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL, created INTEGER NOT NULL, last_seen INTEGER);
CREATE TABLE IF NOT EXISTS device_pairs (code_hash TEXT PRIMARY KEY, name TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS wall_profiles (id TEXT PRIMARY KEY, json TEXT NOT NULL);
`);

export const DEVICE_COOKIE = "harbor_device";
const YEAR = 365 * 24 * 3600;
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

// ---------- profiles ----------
export interface WallItem { widget: string; size: "s" | "m" | "l" | "w" | "tall"; opts?: Record<string, string> }
export interface WallScreen {
  dim: { on: boolean; from: string; to: string; level: number };   // level: 0-90 % darker
  wake: { on: boolean; seconds: number };                         // touch wakes a dimmed screen for N s
  shift: { on: boolean; minutes: number; px: number };            // burn-in: nudge content
  saver: { on: boolean; minutes: number; style: "clock" | "black" };
  keepAwake: boolean;
}
export interface WallLook { theme: "dark" | "light"; glass: number; background: string } // glass: tile opacity 0-100
export interface WallProfile { layout: WallItem[]; screen: WallScreen; look: WallLook }

export const defaultProfile = (): WallProfile => ({
  layout: [
    { widget: "clock", size: "w" },
    { widget: "weather", size: "m" },
    { widget: "system-summary", size: "m" },
  ],
  screen: {
    dim: { on: true, from: "23:00", to: "07:00", level: 70 },
    wake: { on: true, seconds: 30 },
    shift: { on: true, minutes: 5, px: 4 },
    saver: { on: false, minutes: 10, style: "clock" },
    keepAwake: true,
  },
  look: { theme: "dark", glass: 55, background: "ascii:koi" },
});

export const profiles = {
  get(id: string): WallProfile {
    const r: any = db.prepare("SELECT json FROM wall_profiles WHERE id=?").get(id);
    const d = defaultProfile();
    if (!r) return d;
    const p = JSON.parse(r.json);
    return { layout: p.layout ?? d.layout, screen: deepMerge(d.screen, p.screen ?? {}), look: { ...d.look, ...(p.look ?? {}) } };
  },
  put(id: string, p: WallProfile) { db.prepare("INSERT OR REPLACE INTO wall_profiles(id,json) VALUES(?,?)").run(id, JSON.stringify(p)); },
};
function deepMerge<T>(a: T, b: any): T {
  const o: any = { ...a };
  for (const k of Object.keys(b ?? {})) o[k] = o[k] && typeof o[k] === "object" && !Array.isArray(o[k]) ? { ...o[k], ...b[k] } : b[k];
  return o;
}
function validProfile(p: any): WallProfile {
  const bad = () => Object.assign(new Error("That wall layout isn't valid."), { statusCode: 400 });
  if (!p || !Array.isArray(p.layout) || p.layout.length > 60 || typeof p.screen !== "object") throw bad();
  for (const i of p.layout) {
    if (typeof i?.widget !== "string" || !/^[a-z0-9-]{1,40}$/.test(i.widget) || !["s", "m", "l", "w", "tall"].includes(i.size)) throw bad();
    if (i.opts && (typeof i.opts !== "object" || JSON.stringify(i.opts).length > 2000)) throw bad();
  }
  const look = { ...defaultProfile().look, ...(p.look ?? {}) };
  if (!["dark", "light"].includes(look.theme) || !(look.glass >= 0 && look.glass <= 100) || !/^(none|ascii:[a-z]{1,20})$/.test(String(look.background))) throw bad();
  return { layout: p.layout, screen: deepMerge(defaultProfile().screen, p.screen), look: { theme: look.theme, glass: Number(look.glass), background: look.background } };
}

// ---------- devices ----------
export function deviceUser(req: FastifyRequest): User | null {
  const raw = req.cookies[DEVICE_COOKIE];
  if (!raw) return null;
  const un = req.unsignCookie(raw);
  if (!un.valid || !un.value) return null;
  const d: any = db.prepare("SELECT id, name, created FROM devices WHERE token_hash=?").get(sha(un.value));
  if (!d) return null;
  db.prepare("UPDATE devices SET last_seen=? WHERE id=?").run(Date.now(), d.id);
  return { id: `device:${d.id}`, email: "", name: d.name, role: "device", status: "active", created: d.created };
}
const profileId = (u: User | null) => (u?.role === "device" ? u.id : "default");

// ---------- weather (Open-Meteo, no key) ----------
interface Place { name: string; lat: number; lon: number }
const place = (): Place | null => { const r: any = db.prepare("SELECT value FROM settings WHERE key='weather'").get(); return r ? JSON.parse(r.value) : null; };
let cache: { at: number; key: string; data: unknown } | null = null;
async function weather() {
  const p = place();
  if (!p) return { place: null };
  const key = `${p.lat},${p.lon}`;
  if (cache && cache.key === key && Date.now() - cache.at < 15 * 60_000) return cache.data;
  const u = new URL("https://api.open-meteo.com/v1/forecast");
  u.search = new URLSearchParams({
    latitude: String(p.lat), longitude: String(p.lon), timezone: "auto", forecast_days: "6",
    current: "temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,is_day",
    hourly: "temperature_2m,weather_code,precipitation_probability",
    daily: "weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,precipitation_probability_max",
  }).toString();
  const r = await fetch(u, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw Object.assign(new Error("The weather service didn't answer."), { statusCode: 502 });
  const data = { place: p, ...(await r.json() as object) };
  cache = { at: Date.now(), key, data };
  return data;
}

export async function registerWall(app: FastifyInstance) {
  // --- pairing (admin makes a code, the tablet redeems it) ---
  app.post("/api/devices/pair-code", async (req) => {
    const name = String((req.body as any)?.name ?? "").trim().slice(0, 40) || "Wall tablet";
    const code = Array.from(crypto.randomBytes(6), (b) => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[b % 32]).join("");
    db.prepare("DELETE FROM device_pairs WHERE expires < ?").run(Date.now());
    db.prepare("INSERT INTO device_pairs(code_hash,name,expires) VALUES(?,?,?)").run(sha(code), name, Date.now() + 10 * 60_000);
    const origin = String((req.body as any)?.origin ?? "");
    const url = /^https?:\/\/[^/\s]+$/.test(origin) ? `${origin}/wall?pair=${code}` : null;
    const qr = url ? await QRCode.toString(url, { type: "svg", margin: 1, color: { dark: "#000000", light: "#ffffff" } }) : null;
    return { code, url, qr, expires: Date.now() + 10 * 60_000 };
  });

  app.post("/api/devices/pair", async (req: FastifyRequest, reply: FastifyReply) => {
    const code = String((req.body as any)?.code ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    const row: any = db.prepare("SELECT name, expires FROM device_pairs WHERE code_hash=?").get(sha(code));
    if (!row || row.expires < Date.now()) return reply.code(400).send({ error: "That code is wrong or has expired. Make a new one in Settings → Tablets." });
    db.prepare("DELETE FROM device_pairs WHERE code_hash=?").run(sha(code));
    const id = crypto.randomBytes(6).toString("hex");
    const token = crypto.randomBytes(32).toString("hex");
    db.prepare("INSERT INTO devices(id,name,token_hash,created,last_seen) VALUES(?,?,?,?,?)").run(id, row.name, sha(token), Date.now(), Date.now());
    reply.setCookie(DEVICE_COOKIE, token, { signed: true, httpOnly: true, sameSite: "strict", secure: "auto", path: "/", maxAge: YEAR });
    return { ok: true, name: row.name };
  });

  app.get("/api/devices", async () =>
    db.prepare("SELECT id, name, created, last_seen as lastSeen FROM devices ORDER BY created").all());
  app.delete("/api/devices/:id", async (req) => {
    const id = (req.params as any).id;
    db.prepare("DELETE FROM devices WHERE id=?").run(id);
    db.prepare("DELETE FROM wall_profiles WHERE id=?").run(`device:${id}`);
    return { ok: true };
  });

  // --- profile (device: its own; people: the shared default) ---
  app.get("/api/wall/profile", async (req) => ({ id: profileId(req.user), name: req.user?.role === "device" ? req.user.name : "This browser", ...profiles.get(profileId(req.user)) }));
  app.put("/api/wall/profile", async (req) => { const p = validProfile(req.body); profiles.put(profileId(req.user), p); return p; });

  // --- weather ---
  app.get("/api/weather", async () => weather());
  app.get("/api/weather/search", async (req) => {
    const q = String((req.query as any).q ?? "").trim().slice(0, 80);
    if (q.length < 2) return [];
    const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?count=6&language=en&name=${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(8000) });
    const j: any = await r.json();
    return (j.results ?? []).map((x: any) => ({ name: [x.name, x.admin1, x.country].filter(Boolean).join(", "), lat: x.latitude, lon: x.longitude }));
  });
  app.put("/api/weather/place", async (req) => {
    const p = req.body as Place;
    if (typeof p?.name !== "string" || !Number.isFinite(p.lat) || !Number.isFinite(p.lon)) throw Object.assign(new Error("Pick a place from the list."), { statusCode: 400 });
    db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('weather',?)").run(JSON.stringify({ name: p.name.slice(0, 120), lat: p.lat, lon: p.lon }));
    cache = null;
    return { ok: true };
  });
}
