// Music for the wall's DJ mode and player: your Navidrome library (Subsonic
// API), proxied so tablets never see the Navidrome password. It plays on the
// tablet that asked.
import crypto from "node:crypto";
import { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { settings } from "./db.js";
import { demo } from "./demo.js";

export interface MusicSettings { navidromeUrl: string; navidromeUser: string; navidromePass?: string }

const bad = (msg: string, code = 400) => Object.assign(new Error(msg), { statusCode: code });

// ---------------- music (Navidrome / Subsonic) ----------------
export interface Track { id: string; title: string; artist: string; album: string; cover?: string; duration: number }
interface Album { id: string; name: string; artist: string; cover?: string; year?: number }

function music(): MusicSettings {
  const s: any = settings.get();
  return { navidromeUrl: "", navidromeUser: "", ...(s.music ?? {}) };
}

async function sub(path: string, params: Record<string, string | number> = {}): Promise<any> {
  const m = music();
  if (!m.navidromeUrl || !m.navidromeUser || !m.navidromePass) throw bad("Connect Navidrome in Settings → Music first.");
  const salt = crypto.randomBytes(6).toString("hex");
  const u = new URL(`/rest/${path}`, m.navidromeUrl);
  const qs = { u: m.navidromeUser, t: crypto.createHash("md5").update(m.navidromePass + salt).digest("hex"), s: salt, v: "1.16.1", c: "HarborOS", f: "json", ...params };
  Object.entries(qs).forEach(([k, v]) => u.searchParams.set(k, String(v)));
  const r = await fetch(u, { signal: AbortSignal.timeout(15000) }).catch(() => { throw bad("Navidrome didn't answer. Is the address right?", 502); });
  const j: any = await r.json().catch(() => null);
  const res = j?.["subsonic-response"];
  if (!res || res.status !== "ok") throw bad(`Navidrome: ${res?.error?.message ?? `answered ${r.status}`}`, 502);
  return res;
}

const toTrack = (s: any): Track => ({ id: s.id, title: s.title, artist: s.artist ?? "", album: s.album ?? "", cover: s.coverArt, duration: s.duration ?? 0 });
const toAlbum = (a: any): Album => ({ id: a.id, name: a.name ?? a.title, artist: a.artist ?? "", cover: a.coverArt, year: a.year });

// Demo mode: a small fake library so the screens can be tried without Navidrome.
const DEMO_ALBUMS: Album[] = [
  ["Night Drive", "Neon Coast", 2021], ["Paper Boats", "Lumen", 2019], ["Low Tide", "Harbor Lights", 2023],
  ["Static Bloom", "Velvet Room", 2020], ["Northern Lines", "Riga Sound", 2022], ["Slow Motion", "Ambient Club", 2018],
].map(([name, artist, year], i) => ({ id: `al${i}`, name: String(name), artist: String(artist), year: Number(year) }));
const demoTracks = (albumId?: string): Track[] =>
  DEMO_ALBUMS.filter((a) => !albumId || a.id === albumId).flatMap((a) =>
    ["Intro", "Waves", "Glass", "Afterglow", "Home"].map((t, i) => ({ id: `${a.id}-${i}`, title: t, artist: a.artist, album: a.name, duration: 180 + i * 17 })));

async function search(query: string): Promise<Track[]> {
  if (demo) { const all = demoTracks(); const f = all.filter((t) => `${t.title} ${t.artist} ${t.album}`.toLowerCase().includes(query.toLowerCase())); return (f.length ? f : all).slice(0, 30); }
  const r = await sub("search3", { query, songCount: 50, albumCount: 0, artistCount: 0 });
  return (r.searchResult3?.song ?? []).map(toTrack);
}
async function shuffle(): Promise<Track[]> {
  if (demo) return demoTracks().sort(() => Math.random() - 0.5).slice(0, 25);
  const r = await sub("getRandomSongs", { size: 50 });
  return (r.randomSongs?.song ?? []).map(toTrack);
}

export async function registerMusic(app: FastifyInstance) {
  app.get("/api/music/albums", async (req) => {
    const { type = "newest" } = req.query as Record<string, string>;
    if (demo) return type === "random" ? [...DEMO_ALBUMS].sort(() => Math.random() - 0.5) : DEMO_ALBUMS;
    const r = await sub("getAlbumList2", { type: ["newest", "random", "frequent", "recent", "starred"].includes(type) ? type : "newest", size: 40 });
    return (r.albumList2?.album ?? []).map(toAlbum);
  });
  app.get("/api/music/album/:id", async (req) => {
    const id = (req.params as any).id;
    if (demo) return { album: DEMO_ALBUMS.find((a) => a.id === id), tracks: demoTracks(id) };
    const r = await sub("getAlbum", { id });
    return { album: toAlbum(r.album), tracks: (r.album.song ?? []).map(toTrack) };
  });
  app.get("/api/music/search", async (req) => search(String((req.query as any).q ?? "").slice(0, 100)));
  app.get("/api/music/shuffle", async () => shuffle());
  app.get("/api/music/test", async () => { if (!demo) await sub("ping"); return { ok: true }; });

  // Audio and covers are proxied so the tablet never sees the Navidrome password.
  const pipe = (path: string) => async (req: any, reply: any) => {
    if (demo) return reply.code(404).send({ error: "Demo library has no audio." });
    const m = music();
    const salt = crypto.randomBytes(6).toString("hex");
    const u = new URL(`/rest/${path}`, m.navidromeUrl);
    const qs: Record<string, string> = { u: m.navidromeUser, t: crypto.createHash("md5").update((m.navidromePass ?? "") + salt).digest("hex"), s: salt, v: "1.16.1", c: "HarborOS", id: String(req.params.id), ...(path === "getCoverArt" ? { size: "400" } : {}) };
    Object.entries(qs).forEach(([k, v]) => u.searchParams.set(k, v));
    const r = await fetch(u, { headers: req.headers.range ? { range: req.headers.range } : {} });
    reply.code(r.status);
    for (const h of ["content-type", "content-length", "content-range", "accept-ranges"]) { const v = r.headers.get(h); if (v) reply.header(h, v); }
    reply.header("cache-control", path === "getCoverArt" ? "max-age=86400" : "no-store");
    return reply.send(r.body ? Readable.fromWeb(r.body as any) : null);
  };
  app.get("/api/music/stream/:id", pipe("stream"));
  app.get("/api/music/cover/:id", pipe("getCoverArt"));
}
