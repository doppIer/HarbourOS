// Voice assistant and music.
//
// A spoken sentence goes through three steps:
//   1. Rules: known commands (music, buses, calendar, time) in English or Turkish. Instant.
//   2. Router (optional): a small Ollama model sorts sentences the rules missed into one of
//      those commands, or "chat".
//   3. Brain: everything else goes to the brain picked in Settings: none (rules only),
//      Ollama, Claude API, or a running Claude Code / agent tmux session.
//
// Music comes from Navidrome (Subsonic API) and plays on the tablet that asked.
import crypto from "node:crypto";
import { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import Anthropic from "@anthropic-ai/sdk";
import { settings } from "./db.js";
import { env } from "./env.js";
import { demo } from "./demo.js";
import { hostExec, q } from "./host.js";

export interface AssistantSettings {
  brain: "rules" | "ollama" | "claude" | "session";
  router: "rules" | "model";
  ollamaUrl: string;
  ollamaModel: string;
  routerModel: string;
  session: string;
  wakeWord: string;
  voice: VoiceSettings;
}
// "local" = Piper for Turkish, Kokoro for English (Kokoro has no Turkish).
export interface VoiceSettings {
  engine: "local" | "piper" | "kokoro" | "elevenlabs" | "browser";
  piperTr: string; piperEn: string; kokoro: string;
  elevenVoice: string; elevenModel: string; elevenKey?: string;
}
export interface MusicSettings { navidromeUrl: string; navidromeUser: string; navidromePass?: string }

export const ASSISTANT_DEFAULTS: AssistantSettings = {
  brain: "rules", router: "rules", ollamaUrl: "http://host.docker.internal:11434",
  ollamaModel: "llama3.2:3b", routerModel: "qwen2.5:1.5b", session: "", wakeWord: "hey harbor",
  voice: { engine: "local", piperTr: "tr_TR-dfki-medium", piperEn: "en_US-ryan-high", kokoro: "af_heart", elevenVoice: "", elevenModel: "eleven_multilingual_v2" },
};

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

// ---------------- the brain ----------------
type Intent =
  | { kind: "play"; query: string }
  | { kind: "pause" } | { kind: "resume" } | { kind: "next" } | { kind: "prev" }
  | { kind: "volume"; dir: 1 | -1 }
  | { kind: "bus" } | { kind: "calendar" } | { kind: "time" }
  | { kind: "chat"; text: string };

export interface Reply {
  say: string;
  via: "rules" | "router" | "ollama" | "claude" | "session";
  music?: { action: "play"; tracks: Track[]; label: string } | { action: "pause" | "resume" | "next" | "prev" | "louder" | "quieter" };
  show?: "bus" | "calendar";
}
interface Ctx { picks?: { line: string; to?: string; stop: string }[]; city?: string; calendar?: string; lang?: string }

/** Step 1: plain rules, English and Turkish. */
export function rules(raw: string): Intent | null {
  const t = raw.toLowerCase().replace(/^(hey|hi|ok)\s+harbor[,.!\s]*/i, "").replace(/[?!.]+$/, "").trim();
  if (!t) return null;
  if (/(?<!\p{L})(otob[uü]s|tramvay|troleybüs|bus|tram|trolleybus|departure|kalkış)/u.test(t)) return { kind: "bus" };
  if (/(?<!\p{L})(takvim|ajanda|etkinlik|toplantı|calendar|agenda|schedule|meeting|events?)(?!\p{L})|bugün ne var|what'?s on/u.test(t)) return { kind: "calendar" };
  if (/saat kaç|what time|the time/.test(t)) return { kind: "time" };
  if (/(?<!\p{L})(pause|stop|durdur|dur)(?!\p{L})/u.test(t)) return { kind: "pause" };
  if (/(?<!\p{L})(resume|continue|devam)(?!\p{L})/u.test(t)) return { kind: "resume" };
  if (/(?<!\p{L})(next|skip|sonraki|geç|atla)(?!\p{L})/u.test(t)) return { kind: "next" };
  if (/(?<!\p{L})(previous|back|önceki|geri)(?!\p{L})/u.test(t)) return { kind: "prev" };
  if (/(?<!\p{L})(louder|volume up|turn it up|sesi (aç|yükselt|artır))(?!\p{L})/u.test(t)) return { kind: "volume", dir: 1 };
  if (/(?<!\p{L})(quieter|volume down|turn it down|sesi (kıs|azalt))(?!\p{L})/u.test(t)) return { kind: "volume", dir: -1 };
  let m = t.match(/^(?:play|put on)\s+(.*)$/);
  if (m) return { kind: "play", query: m[1].replace(/^(some|me|music|songs?)\s*/g, "").replace(/^(music|songs?)$/, "").trim() };
  m = t.match(/^(.*?)\s*(?:çal|aç|dinle|oynat)$/);
  if (m && /(müzik|şarkı|çal|dinle|oynat)/.test(t)) return { kind: "play", query: m[1].replace(/(?<!\p{L})(bana|biraz|bir|müzik|müziği|şarkı|şarkısı|şarkılar[ıi]?|dan|den|tan|ten)(?!\p{L})/ug, "").replace(/['’]\S*/g, "").trim() };
  if (/^(müzik|music)$/.test(t)) return { kind: "play", query: "" };
  return null;
}

async function ollama(prompt: string, model: string, system: string, json = false): Promise<string> {
  const a = assistant();
  const r = await fetch(new URL("/api/chat", a.ollamaUrl), {
    method: "POST", signal: AbortSignal.timeout(60000), headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, stream: false, ...(json ? { format: "json" } : {}), messages: [{ role: "system", content: system }, { role: "user", content: prompt }] }),
  }).catch(() => { throw bad(`Ollama isn't reachable at ${a.ollamaUrl}.`, 502); });
  if (!r.ok) throw bad(`Ollama answered ${r.status}${r.status === 404 ? ` (is "${model}" pulled?)` : ""}.`, 502);
  return ((await r.json()) as any).message?.content ?? "";
}

/** Step 2: a small model picks the command when the rules didn't. */
async function route(text: string): Promise<Intent | null> {
  const out = await ollama(text, assistant().routerModel,
    'Sort the user\'s sentence into one command. Reply with JSON only: {"kind": "play"|"pause"|"resume"|"next"|"prev"|"bus"|"calendar"|"time"|"chat", "query": "<what to play, or empty>"}. Use "chat" for anything else.', true);
  try {
    const j = JSON.parse(out);
    if (j.kind === "play") return { kind: "play", query: String(j.query ?? "") };
    if (["pause", "resume", "next", "prev", "bus", "calendar", "time"].includes(j.kind)) return { kind: j.kind } as Intent;
  } catch {}
  return null;
}

const VOICE = "You are Harbor, a voice assistant on a home tablet. Answer in one or two short spoken sentences, in the user's language. No markdown, no lists.";

/** Step 3: the chosen brain answers whatever isn't a command. */
async function brain(text: string, role = ""): Promise<Reply> {
  const a = assistant();
  if (a.brain === "ollama") return { via: "ollama", say: (await ollama(text, a.ollamaModel, VOICE)).trim() };
  if (a.brain === "claude") {
    if (!process.env.ANTHROPIC_API_KEY) throw bad("Set ANTHROPIC_API_KEY on the server to use Claude.");
    const m = await new Anthropic().messages.create({ model: env.claudeModel, max_tokens: 300, system: VOICE, messages: [{ role: "user", content: text }] });
    return { via: "claude", say: m.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim() };
  }
  if (a.brain === "session") {
    // A terminal session can run anything on the server: only admins and the tablets they paired may type into it.
    if (role !== "admin" && role !== "device") return { via: "session", say: "Only an admin can talk to the AI session." };
    if (!a.session) throw bad("Pick a session in Settings → Assistant.");
    if (demo) return { via: "session", say: `Sent to ${a.session}. Open the AI page to follow it.` };
    const r = await hostExec(`tmux send-keys -t ${q(a.session)} -l ${q(text)} && tmux send-keys -t ${q(a.session)} Enter`);
    if (r.code !== 0) throw bad(`Couldn't reach the "${a.session}" session. Is it still running?`, 502);
    return { via: "session", say: `Sent to ${a.session}. Open the AI page to follow it.` };
  }
  return { via: "rules", say: "I can play music, pause or skip, tell you the next bus or what's on your calendar. Pick a brain in Settings for anything else." };
}

const tr = (lang?: string) => /^tr/i.test(lang ?? "");
const hhmm = (d: Date) => d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

async function act(intent: Intent, via: Reply["via"], ctx: Ctx, app: FastifyInstance, cookie?: string, role = ""): Promise<Reply> {
  const T = tr(ctx.lang);
  const ask = async (url: string) => {
    const r = await app.inject({ method: "GET", url, headers: cookie ? { cookie } : {} });
    if (r.statusCode !== 200) throw bad(JSON.parse(r.body).error ?? "Failed", r.statusCode);
    return JSON.parse(r.body);
  };
  switch (intent.kind) {
    case "play": {
      const tracks = intent.query ? await search(intent.query) : await shuffle();
      if (!tracks.length) return { via, say: T ? `"${intent.query}" için bir şey bulamadım.` : `I couldn't find anything for "${intent.query}".` };
      const label = intent.query ? (tracks[0].artist.toLowerCase().includes(intent.query.toLowerCase()) ? tracks[0].artist : intent.query) : (T ? "Karışık" : "Shuffle");
      return { via, say: T ? `${label} çalıyor.` : `Playing ${label}.`, music: { action: "play", tracks, label } };
    }
    case "pause": case "resume": case "next": case "prev":
      return { via, say: "", music: { action: intent.kind } };
    case "volume":
      return { via, say: "", music: { action: intent.dir > 0 ? "louder" : "quieter" } };
    case "time":
      return { via, say: (T ? "Saat " : "It's ") + hhmm(new Date()) + "." };
    case "bus": {
      if (!ctx.picks?.length) return { via, say: T ? "Önce wall'a bir otobüs kartı ekle ve hattını seç." : "Add a bus tile to the wall and pick your line first." };
      const board: any[] = await ask(`/api/transit/board?city=${encodeURIComponent(ctx.city ?? "riga")}&limit=2&picks=${encodeURIComponent(JSON.stringify(ctx.picks))}`);
      const parts = board.filter((b) => b.departures?.length).map((b) => {
        const d = b.departures[0], n = b.line.replace(/^\D+/, "");
        return T ? `${n} ${d.in} dakika sonra ${b.stop} durağından` : `the ${n} leaves ${b.stop} in ${d.in} minute${d.in === 1 ? "" : "s"}`;
      });
      if (!parts.length) return { via, say: T ? "Önümüzdeki 3 saatte sefer yok." : "Nothing leaves in the next three hours.", show: "bus" };
      return { via, say: T ? parts.join(", ") + "." : parts.join(", ").replace(/^t/, "T") + ".", show: "bus" };
    }
    case "calendar": {
      if (!ctx.calendar) return { via, say: T ? "Önce wall'a bir takvim kartı ekle." : "Add a calendar tile to the wall first." };
      const { events }: { events: { title: string; start: number; allDay: boolean }[] } = await ask(`/api/calendar?days=2&url=${encodeURIComponent(ctx.calendar)}`);
      const end = new Date(); end.setHours(23, 59, 59);
      const today = events.filter((e) => e.start <= end.getTime() && (e.allDay || e.start >= Date.now() - 30 * 60_000));
      if (!today.length) return { via, say: T ? "Bugün takviminde başka bir şey yok." : "Nothing else on your calendar today.", show: "calendar" };
      const list = today.slice(0, 3).map((e) => (e.allDay ? e.title : `${e.title} ${T ? "saat" : "at"} ${hhmm(new Date(e.start))}`));
      return { via, say: (T ? "Bugün: " : "Today: ") + list.join(", ") + ".", show: "calendar" };
    }
    case "chat":
      return brain(intent.text, role);
  }
}

export function assistant(): AssistantSettings {
  const a = (settings.get() as any).assistant ?? {};
  return { ...ASSISTANT_DEFAULTS, ...a, voice: { ...ASSISTANT_DEFAULTS.voice, ...(a.voice ?? {}) } };
}

// ---------------- voice (text to speech) ----------------
const PIPER = process.env.PIPER_URL ?? "http://127.0.0.1:5000";
const KOKORO = process.env.KOKORO_URL ?? "http://127.0.0.1:8880";

async function tts(engine: string, text: string, tr: boolean, v: VoiceSettings): Promise<{ type: string; body: Buffer }> {
  const get = async (r: Response, name: string) => {
    if (!r.ok) throw bad(`${name} answered ${r.status}.`, 502);
    return { type: r.headers.get("content-type")?.startsWith("audio") ? r.headers.get("content-type")! : name === "Piper" ? "audio/wav" : "audio/mpeg", body: Buffer.from(await r.arrayBuffer()) };
  };
  const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(url, { method: "POST", signal: AbortSignal.timeout(30000), headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  if (engine === "piper")
    return get(await post(`${PIPER}/synthesize`, { text, voice: tr ? v.piperTr : v.piperEn }).catch(() => { throw bad("Piper isn't running.", 502); }), "Piper");
  if (engine === "kokoro")
    return get(await post(`${KOKORO}/v1/audio/speech`, { model: "kokoro", input: text, voice: v.kokoro, response_format: "mp3" }).catch(() => { throw bad("Kokoro isn't running.", 502); }), "Kokoro");
  if (engine === "elevenlabs") {
    if (!v.elevenKey || !v.elevenVoice) throw bad("Add your ElevenLabs key and voice in Settings.");
    return get(await post(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(v.elevenVoice)}?output_format=mp3_44100_128`,
      { text, model_id: v.elevenModel || "eleven_multilingual_v2" }, { "xi-api-key": v.elevenKey }).catch(() => { throw bad("ElevenLabs isn't reachable.", 502); }), "ElevenLabs");
  }
  throw bad("This voice plays in the browser.");
}

/** Which engine speaks this sentence, and what to try if it's down. */
function engines(v: VoiceSettings, tr: boolean): string[] {
  if (v.engine === "local") return tr ? ["piper"] : ["kokoro", "piper"];
  if (v.engine === "kokoro" && tr) return ["piper"]; // Kokoro can't speak Turkish
  return [v.engine];
}

export async function registerAssistant(app: FastifyInstance) {
  app.post("/api/assistant", async (req) => {
    const { text = "", ...ctx } = (req.body ?? {}) as Ctx & { text?: string };
    const said = String(text).slice(0, 500).trim();
    if (!said) throw bad("Say something.");
    const cookie = req.headers.cookie;
    let intent = rules(said), via: Reply["via"] = "rules";
    if (!intent && assistant().router === "model") {
      intent = await route(said).catch(() => null);
      if (intent) via = "router";
    }
    return act(intent ?? { kind: "chat", text: said }, via, ctx, app, cookie, req.user?.role);
  });

  // Spoken answers. The tablet falls back to its own voice if this fails.
  app.post("/api/assistant/speak", async (req, reply) => {
    const { text = "", lang = "" } = (req.body ?? {}) as { text?: string; lang?: string };
    const said = String(text).slice(0, 600).trim();
    if (!said) throw bad("Nothing to say.");
    const v = assistant().voice, tr = /^tr/i.test(lang);
    if (v.engine === "browser") throw bad("This voice plays in the browser.");
    let last: unknown;
    for (const e of engines(v, tr)) {
      try { const a = await tts(e, said, tr, v); return reply.header("content-type", a.type).header("x-voice", e).send(a.body); }
      catch (err) { last = err; }
    }
    throw last;
  });

  app.get("/api/assistant/voices", async () => {
    const j = async (u: string) => { try { const r = await fetch(u, { signal: AbortSignal.timeout(3000) }); return r.ok ? await r.json() : null; } catch { return null; } };
    const [p, k] = await Promise.all([j(`${PIPER}/voices`), j(`${KOKORO}/v1/audio/voices`)]);
    return {
      piper: p ? Object.keys(p) : null,
      kokoro: k ? (k.voices ?? []).map((x: any) => (typeof x === "string" ? x : x.id ?? x.name)) : null,
    };
  });

  // The settings screen asks which sessions and models exist.
  app.get("/api/assistant/status", async () => {
    const a = assistant();
    let models: string[] = [];
    if (demo) models = ["llama3.2:3b", "qwen2.5:1.5b"];
    else try { const r = await fetch(new URL("/api/tags", a.ollamaUrl), { signal: AbortSignal.timeout(3000) }); models = ((await r.json()) as any).models.map((m: any) => m.name); } catch {}
    const s = demo ? { out: Buffer.from("harbor-claude\n"), code: 0 } : await hostExec("tmux ls -F '#{session_name}' 2>/dev/null");
    return { models, sessions: s.out.toString().split("\n").filter(Boolean), claude: demo || !!process.env.ANTHROPIC_API_KEY };
  });

  // ---- music ----
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
