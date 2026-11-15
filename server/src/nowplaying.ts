// "Now playing" on the server's speaker: AirPlay (shairport-sync) and Spotify
// Connect (raspotify / librespot) run on the host and report here through
// host/setup-nowplaying.sh. Wall tablets get every change over the WebSocket.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { env } from "./env.js";
import { hub } from "./hub.js";
import { demo } from "./demo.js";
import type { NowPlaying } from "./protocol.js";


let now: NowPlaying | null = null;
let coverBytes: { type: string; body: Buffer } | null = null;
let coverVer = 0;

const tokenFile = () => path.join(env.dataDir, "nowplaying.token");
function token(): string {
  try { return fs.readFileSync(tokenFile(), "utf8").trim(); } catch {}
  const t = crypto.randomBytes(24).toString("hex");
  fs.mkdirSync(env.dataDir, { recursive: true });
  fs.writeFileSync(tokenFile(), t + "\n", { mode: 0o600 });
  return t;
}
const same = (a: string, b: string) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

function publish() { hub.publish("nowplaying", { t: "nowplaying", d: now }); }

const str = (v: unknown, max = 300) => (typeof v === "string" ? v.slice(0, max) : undefined);
const num = (v: unknown) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : undefined);

export async function registerNowPlaying(app: FastifyInstance) {
  token(); // create it on first boot so the host script can read it

  // From the host hooks. Fields are optional: each event updates what it knows.
  app.post("/api/nowplaying/push", { bodyLimit: 8 * 1024 * 1024 }, async (req, reply) => {
    const got = String(req.headers["x-harbour-token"] ?? "");
    if (!got || !same(got, token())) return reply.code(401).send({ error: "Bad token." });
    const b = (req.body ?? {}) as Record<string, unknown>;
    const source = b.source === "spotify" ? "spotify" : "airplay";
    // A different source taking over starts fresh.
    if (!now || now.source !== source) now = { source, state: "stopped", title: "", artist: "", album: "", cover: null, duration: 0, position: 0, at: Date.now() };
    const n: NowPlaying = { ...now };

    if (b.event === "track") { n.title = ""; n.artist = ""; n.album = ""; n.duration = 0; n.position = 0; n.at = Date.now(); if (source === "spotify") n.cover = null; }
    for (const k of ["title", "artist", "album", "device"] as const) { const v = str(b[k]); if (v !== undefined) n[k] = v; }
    const d = num(b.duration); if (d !== undefined) n.duration = d;
    const p = num(b.position); if (p !== undefined) { n.position = p; n.at = Date.now(); }
    const c = str(b.cover, 2000); if (c && /^https:\/\//.test(c)) n.cover = c;
    if (typeof b.coverData === "string" && b.coverData) {
      const body = Buffer.from(b.coverData, "base64");
      const type = body[0] === 0x89 ? "image/png" : "image/jpeg";
      coverBytes = { type, body }; coverVer++;
      n.cover = `/api/nowplaying/cover?v=${coverVer}`;
    }
    if (b.state === "playing" || b.state === "paused" || b.state === "stopped") {
      // Keep the clock right across pauses.
      if (n.state === "playing" && b.state !== "playing") n.position += Date.now() - n.at;
      n.at = Date.now();
      n.state = b.state;
    }
    if (n.state === "stopped") { coverBytes = source === "airplay" ? null : coverBytes; }
    now = n;
    publish();
    return { ok: true };
  });

  app.get("/api/nowplaying", async () => now);
  app.get("/api/nowplaying/cover", async (_req, reply) => {
    if (!coverBytes) return reply.code(404).send({ error: "No cover." });
    reply.header("content-type", coverBytes.type).header("cache-control", "max-age=86400");
    return reply.send(coverBytes.body);
  });

  // Demo mode: something to look at on the wall.
  if (demo) app.post("/api/nowplaying/demo", async (req) => {
    const on = (req.body as any)?.on !== false;
    now = on ? { source: (req.body as any)?.source === "airplay" ? "airplay" : "spotify", state: "playing", title: "Midnight City", artist: "M83", album: "Hurry Up, We're Dreaming", cover: null, duration: 243000, position: 30000, at: Date.now(), device: "Han's iPhone" }
      : now && { ...now, state: "stopped" };
    publish();
    return now;
  });
}
