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
import type { NowPlaying, SpeakerSource, SpeakerStatus } from "./protocol.js";
import { hostExec, isAuthError } from "./host.js";


let now: NowPlaying | null = null;
let coverBytes: { type: string; body: Buffer } | null = null;
let coverVer = 0;
// Last report from each source, for Settings → Speaker.
const seen: Partial<Record<NowPlaying["source"], { at: number; via: "host" | "docker" }>> = {};
// Settings → Speaker → Test: a sample track on the wall for a few seconds.
let test: { timer: NodeJS.Timeout; prev: NowPlaying | null } | null = null;
function endTest(restore: boolean) {
  if (!test) return;
  clearTimeout(test.timer);
  const prev = test.prev; test = null;
  if (restore) { now = prev ?? (now && { ...now, state: "stopped", at: Date.now() }); publish(); }
}

const SETUP = "sudo bash host/setup-nowplaying.sh";

/** Reads the answers of the probe script in status(). Exported for tests. */
export function readProbe(out: string, mixerName = "Master"): Pick<SpeakerStatus, "sources" | "volume"> {
  const kv: Record<string, string> = {};
  for (const l of out.split("\n")) { const i = l.indexOf("="); if (i > 0) kv[l.slice(0, i)] = l.slice(i + 1).trim(); }
  const src = (source: SpeakerSource["source"], state: SpeakerSource["state"], detail: string, fix?: string, controls = false): SpeakerSource =>
    ({ source, state, via: state === "missing" ? null : "host", detail, lastEvent: seen[source]?.at ?? null, controls, ...(fix ? { fix } : {}) });

  const airplay =
    !kv.sp_bin ? src("airplay", "missing", "shairport-sync isn't installed on the server.")
    : kv.sp !== "active" ? src("airplay", "setup", "shairport-sync is installed but not running.", "sudo systemctl enable --now shairport-sync")
    : kv.reader !== "active" ? src("airplay", "setup", "shairport-sync is running, but it doesn't report to HarbourOS yet.", SETUP)
    : src("airplay", "ok", kv.rc ? "shairport-sync on the server." : "shairport-sync on the server. Play/pause and skip don't answer (its D-Bus remote control is off).", undefined, !!kv.rc);
  const spotify =
    !kv.rs_conf ? src("spotify", "missing", "raspotify isn't installed on the server.")
    : kv.rs !== "active" ? src("spotify", "setup", "raspotify is installed but not running.", "sudo systemctl enable --now raspotify")
    : !kv.rs_hook ? src("spotify", "setup", "raspotify is running, but it doesn't report to HarbourOS yet.", SETUP)
    : src("spotify", "ok", "raspotify on the server. It shows what plays; it has no play/pause or skip.");

  const m = (kv.mixer ?? "").match(/\[(\d{1,3})%\]/);
  const volume: SpeakerStatus["volume"] = m ? { ok: true, value: Number(m[1]), detail: `ALSA mixer "${mixerName}" on the server.` }
    : /ermission|cannot open/i.test(kv.mixer ?? "") ? { ok: false, detail: "HarbourOS isn't allowed to use the sound card.", fix: SETUP }
    : /Unable to find simple control/i.test(kv.mixer ?? "") ? { ok: false, detail: `No mixer "${mixerName}" on that sound card. Set NOWPLAYING_MIXER / NOWPLAYING_CARD in .env.` }
    : { ok: false, detail: "Couldn't read the volume (is alsa-utils installed?).", fix: SETUP };
  return { sources: [airplay, spotify], volume };
}

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
    seen[source] = { at: Date.now(), via: "host" };
    if (test) { endTest(false); now = null; } // real music wins over the sample
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
    // AirPlay can be controlled through shairport-sync (it asks the phone); Spotify Connect can't yet.
    n.controls = n.source === "airplay";
    now = n;
    publish();
    return { ok: true };
  });

  app.get("/api/nowplaying", async () => now);

  // Play/pause, next, previous. AirPlay: shairport-sync's remote control on the
  // host's system D-Bus, which passes the command back to the phone.
  const METHODS: Record<string, string> = { playpause: "PlayPause", next: "Next", previous: "Previous" };
  app.post("/api/nowplaying/control", async (req, reply) => {
    const action = String((req.body as any)?.action ?? "");
    const m = METHODS[action];
    if (!m) return reply.code(400).send({ error: "Unknown action." });
    if (!now?.controls) return reply.code(409).send({ error: "This source can't be controlled from here." });
    if (demo) {
      if (action === "playpause") { now = { ...now, state: now.state === "playing" ? "paused" : "playing", at: Date.now() }; publish(); }
      return { ok: true };
    }
    const r = await hostExec(`busctl --system call org.gnome.ShairportSync /org/gnome/ShairportSync org.gnome.ShairportSync.RemoteControl ${m}`);
    if (r.code !== 0) return reply.code(502).send({ error: r.err.trim().split("\n").pop() || "The speaker didn't take the command." });
    return { ok: true };
  });
  app.get("/api/nowplaying/cover", async (_req, reply) => {
    if (!coverBytes) return reply.code(404).send({ error: "No cover." });
    reply.header("content-type", coverBytes.type).header("cache-control", "max-age=86400");
    return reply.send(coverBytes.body);
  });

  // Speaker volume: the host's ALSA mixer, so it works for AirPlay and Spotify alike.
  // NOWPLAYING_MIXER / NOWPLAYING_CARD pick the control (default "Master" on card 0).
  const MIXER = (process.env.NOWPLAYING_MIXER ?? "Master").replace(/[^\w .-]/g, "");
  const CARD = (process.env.NOWPLAYING_CARD ?? "0").replace(/[^\w-]/g, "");
  let demoVol = 45;
  const readVol = (out: string) => { const m = out.match(/\[(\d{1,3})%\]/); return m ? Number(m[1]) : null; };
  app.get("/api/nowplaying/volume", async (_req, reply) => {
    if (demo) return { volume: demoVol };
    const r = await hostExec(`amixer -c ${CARD} sget '${MIXER}'`);
    const v = readVol(r.out.toString());
    if (r.code !== 0 || v === null) return reply.code(502).send({ error: r.err.includes("ermission") || r.err.includes("cannot open") ? "HarbourOS can't reach the sound card. Run sudo bash host/setup-nowplaying.sh again." : "Couldn't read the volume." });
    return { volume: v };
  });
  app.post("/api/nowplaying/volume", async (req, reply) => {
    const v = Math.round(Number((req.body as any)?.volume));
    if (!(v >= 0 && v <= 100)) return reply.code(400).send({ error: "Volume is 0–100." });
    if (demo) { demoVol = v; hub.publish("nowplaying", { t: "volume", d: v }); return { volume: v }; }
    const r = await hostExec(`amixer -c ${CARD} -q sset '${MIXER}' ${v}%`);
    if (r.code !== 0) return reply.code(502).send({ error: "HarbourOS can't reach the sound card. Run sudo bash host/setup-nowplaying.sh again." });
    hub.publish("nowplaying", { t: "volume", d: v });
    return { volume: v };
  });

  // Settings → Speaker: is each source set up, and do controls and volume answer?
  app.get("/api/nowplaying/status", async (): Promise<SpeakerStatus> => {
    if (demo) return {
      host: { ok: true, detail: "Demo mode: nothing is checked on a real server." },
      sources: [
        { source: "airplay", state: "ok", via: "host", detail: "shairport-sync on the server.", lastEvent: seen.airplay?.at ?? Date.now() - 4 * 60_000, controls: true },
        { source: "spotify", state: "setup", via: "host", detail: "raspotify is running, but it doesn't report to HarbourOS yet.", lastEvent: seen.spotify?.at ?? null, controls: false, fix: SETUP },
      ],
      volume: { ok: true, value: demoVol, detail: `ALSA mixer "${MIXER}" on the server.` },
    };
    const r = await hostExec(`
a() { systemctl is-active "$1" 2>/dev/null || true; }
echo "sp=$(a shairport-sync)"; echo "reader=$(a harbour-nowplaying)"; echo "rs=$(a raspotify)"
command -v shairport-sync >/dev/null 2>&1 && echo sp_bin=1
[ -f /etc/raspotify/conf ] && echo rs_conf=1
[ -x /usr/local/bin/harbour-nowplaying-spotify ] && echo rs_hook=1
busctl --system introspect org.gnome.ShairportSync /org/gnome/ShairportSync org.gnome.ShairportSync.RemoteControl >/dev/null 2>&1 && echo rc=1
echo "mixer=$(amixer -c ${CARD} sget '${MIXER}' 2>&1 | tr '\\n' ' ')"
true`);
    const out = r.out.toString();
    if (r.code !== 0 || !out.includes("sp=")) {
      const auth = isAuthError(r.err);
      const detail = auth ? "HarbourOS can't sign in to the server over SSH, so it can't check the speaker." : `Couldn't run the check on the server${r.err ? `: ${r.err.split("\n").pop()}` : "."}`;
      const unknown = (source: SpeakerSource["source"]): SpeakerSource => ({ source, state: "unknown", via: null, detail: "Not checked.", lastEvent: seen[source]?.at ?? null, controls: false });
      return { host: { ok: false, detail, fix: "sudo bash host/setup-terminal.sh" }, sources: [unknown("airplay"), unknown("spotify")], volume: { ok: false, detail: "Not checked." } };
    }
    return { host: { ok: true, detail: "HarbourOS can run commands on the server." }, ...readProbe(out, MIXER) };
  });

  // A sample track on every wall for 10 seconds, to see that the screens react.
  app.post("/api/nowplaying/test", async () => {
    const prev = test ? test.prev : now;
    if (test) clearTimeout(test.timer);
    now = { source: "airplay", state: "playing", title: "Speaker test", artist: "HarbourOS", album: "This closes by itself in 10 seconds", cover: null, duration: 10_000, position: 0, at: Date.now(), device: "Settings", controls: false };
    test = { prev, timer: setTimeout(() => endTest(true), 10_000) };
    publish();
    return { ok: true, seconds: 10 };
  });

  // Demo mode: something to look at on the wall.
  if (demo) app.post("/api/nowplaying/demo", async (req) => {
    const on = (req.body as any)?.on !== false;
    now = on ? { source: (req.body as any)?.source === "airplay" ? "airplay" : "spotify", state: "playing", title: "Midnight City", artist: "M83", album: "Hurry Up, We're Dreaming", cover: null, duration: 243000, position: 30000, at: Date.now(), device: "Han's iPhone", controls: (req.body as any)?.source === "airplay" }
      : now && { ...now, state: "stopped" };
    publish();
    return now;
  });
}
