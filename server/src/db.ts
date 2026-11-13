import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { env } from "./env.js";
import type { AppConfig } from "./protocol.js";

fs.mkdirSync(env.dataDir, { recursive: true });
export const db = new Database(path.join(env.dataDir, "harbor.db"));
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS apps (id TEXT PRIMARY KEY, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS energy (day TEXT PRIMARY KEY, wh REAL NOT NULL, rx REAL NOT NULL DEFAULT 0, tx REAL NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, title TEXT, updated INTEGER, messages TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS actions (id TEXT PRIMARY KEY, chat TEXT, kind TEXT, target TEXT, status TEXT, created INTEGER);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL,
  hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member', status TEXT NOT NULL DEFAULT 'pending', created INTEGER NOT NULL
);
`);
// migration: sessions and chats belong to a user
if (!(db.prepare("PRAGMA table_info(sessions)").all() as any[]).some((c) => c.name === "user_id")) {
  db.exec("DELETE FROM sessions; ALTER TABLE sessions ADD COLUMN user_id TEXT;");
}
if (!(db.prepare("PRAGMA table_info(chats)").all() as any[]).some((c) => c.name === "user_id")) {
  db.exec("ALTER TABLE chats ADD COLUMN user_id TEXT;");
}

export const apps = {
  all(): AppConfig[] {
    return db.prepare("SELECT json FROM apps").all().map((r: any) => JSON.parse(r.json)).sort((a: AppConfig, b: AppConfig) => a.order - b.order);
  },
  get(id: string): AppConfig | undefined {
    const r: any = db.prepare("SELECT json FROM apps WHERE id=?").get(id);
    return r ? JSON.parse(r.json) : undefined;
  },
  put(a: AppConfig) { db.prepare("INSERT OR REPLACE INTO apps(id,json) VALUES(?,?)").run(a.id, JSON.stringify(a)); },
  del(id: string) { db.prepare("DELETE FROM apps WHERE id=?").run(id); },
};

export interface Settings {
  accent: string;
  pricePerKwh: number;
  currency: string;
  baselineWatts: number;      // rest of system on top of RAPL package power
  plugEntity?: string;        // Home Assistant entity id, e.g. sensor.server_plug_power
  haUrl?: string;
  haToken?: string;
  background: { module: string; dim: number; blur: number; pauseHidden: boolean; pauseWhenApp: boolean };
  unmountAfterMinutes: number;
  sidebarCollapsed: boolean;
  allowSignup: boolean;        // new accounts still need an admin's approval
  loginBackground: { module: string; dim: number; blur: number };
}

const defaults: Settings = {
  accent: "#7B7BF0",
  pricePerKwh: 0.3,
  currency: "€",
  baselineWatts: 18,
  background: { module: "none", dim: 0.35, blur: 0, pauseHidden: true, pauseWhenApp: true },
  unmountAfterMinutes: 20,
  sidebarCollapsed: false,
  allowSignup: true, // accounts stay "pending" until an admin approves them
  loginBackground: { module: "aura", dim: 0, blur: 0 },
};

export const settings = {
  get(): Settings {
    const r: any = db.prepare("SELECT value FROM settings WHERE key='main'").get();
    return { ...defaults, ...(r ? JSON.parse(r.value) : {}) };
  },
  set(patch: Partial<Settings>) {
    const s = { ...settings.get(), ...patch };
    db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('main',?)").run(JSON.stringify(s));
    return s;
  },
  /** Settings safe for the browser (no HA token). */
  public(): Omit<Settings, "haToken"> & { hasHaToken: boolean } {
    const { haToken, ...rest } = settings.get();
    return { ...rest, hasHaToken: !!haToken };
  },
};

/** Seed apps from config/harbor.json on first boot. */
export function seedApps(file: string) {
  if (apps.all().length || !fs.existsSync(file)) return;
  const list: AppConfig[] = JSON.parse(fs.readFileSync(file, "utf8")).apps;
  list.forEach((a, i) => apps.put({ ...({ order: i, section: "Apps", pinned: true, containers: [], startOnDemand: true, idleStopMinutes: 0, alwaysOn: false, startOnBoot: false } as Partial<AppConfig>), ...a }));
}
