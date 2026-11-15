// Public transport departures from GTFS timetables, and calendars from
// shared .ics links. Both are read on the server so the wall tablet only
// gets small JSON answers.
//
// Cities: each one is a GTFS zip. Riga's comes from data.gov.lv (a new file
// every month, so we ask the open-data API for the newest one). Any other
// city works with a "GTFS link" in the tile's options.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import type { FastifyInstance } from "fastify";
import { env } from "./env.js";

const bad = (m: string, code = 400) => Object.assign(new Error(m), { statusCode: code });

// ---------------- tiny zip reader (stored + deflate, enough for GTFS) ----------------
function unzip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let e = buf.length - 22;
  while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) throw bad("That GTFS file isn't a zip.", 502);
  let p = buf.readUInt32LE(e + 16);
  const n = buf.readUInt16LE(e + 10);
  for (let i = 0; i < n; i++) {
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20);
    const nl = buf.readUInt16LE(p + 28), xl = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nl);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    out.set(path.basename(name), method === 8 ? zlib.inflateRawSync(data) : data);
    p += 46 + nl + xl + cl;
  }
  return out;
}

/** CSV rows as objects (handles quotes, BOM, \r\n). */
function* csv(text: string): Generator<Record<string, string>> {
  text = text.replace(/^﻿/, "");
  let head: string[] | null = null;
  let row: string[] = [], f = "", q = false;
  const end = () => { row.push(f); f = ""; };
  for (let i = 0; i <= text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; continue; }
    if (c === '"') q = true;
    else if (c === ",") end();
    else if (c === "\n" || c === undefined) {
      end();
      if (row.length > 1 || row[0]) {
        if (!head) head = row.map((h) => h.trim());
        else { const o: Record<string, string> = {}; head.forEach((h, j) => (o[h] = row[j] ?? "")); yield o; }
      }
      row = [];
    } else if (c !== "\r") f += c;
  }
}

// ---------------- cities ----------------
interface City { id: string; name: string; tz: string; source: () => Promise<string> }
const ckanNewest = (dataset: string) => async () => {
  const r = await fetch(`https://data.gov.lv/dati/api/3/action/package_show?id=${dataset}`, { signal: AbortSignal.timeout(15000) });
  const res: any[] = ((await r.json()) as any).result.resources;
  const z = res.filter((x) => /\.zip$/i.test(x.url)).sort((a, b) => String(a.created).localeCompare(String(b.created))).pop();
  if (!z) throw bad("Couldn't find Riga's timetable file.", 502);
  return z.url as string;
};
export const CITIES: City[] = [
  { id: "riga", name: "Riga (Rīgas satiksme)", tz: "Europe/Riga", source: ckanNewest("marsrutu-saraksti-rigas-satiksme-sabiedriskajam-transportam") },
];

// ---------------- GTFS in memory ----------------
interface Feed {
  at: number;
  tz: string;
  routes: Map<string, { short: string; type: number; color: string; long: string }>;
  stops: Map<string, string>;                 // stop_id -> name
  byName: Map<string, string[]>;              // lowercased name -> stop_ids
  trips: Map<string, { route: string; service: string; head: string }>;
  times: Map<string, { trip: string; t: number; seq: number }[]>; // stop_id -> departures (seconds after midnight)
  weekly: Map<string, { days: boolean[]; from: string; to: string }>;
  exceptions: Map<string, Map<string, number>>; // service -> yyyymmdd -> 1 add / 2 remove
}
const feeds = new Map<string, Feed>();
const loading = new Map<string, Promise<Feed>>();
const dir = path.join(env.dataDir, "transit");
const WEEK = 7 * 24 * 3600_000;

function keyFor(cityOrUrl: string) {
  if (CITIES.some((c) => c.id === cityOrUrl)) return cityOrUrl;
  let u: URL;
  try { u = new URL(cityOrUrl); } catch { throw bad("Pick a city, or paste a GTFS .zip link that starts with https://."); }
  if (u.protocol !== "https:") throw bad("The GTFS link has to start with https://.");
  return u.href;
}

async function feed(cityOrUrl: string): Promise<Feed> {
  const key = keyFor(cityOrUrl);
  const f = feeds.get(key);
  if (f && Date.now() - f.at < WEEK) return f;
  if (!loading.has(key)) loading.set(key, load(key).finally(() => loading.delete(key)));
  try { return await loading.get(key)!; } catch (e) { if (f) return f; throw e; }
}

async function load(key: string): Promise<Feed> {
  const city = CITIES.find((c) => c.id === key);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, (city ? key : Buffer.from(key).toString("base64url").slice(0, 60)) + ".zip");
  let buf: Buffer | null = null;
  const fresh = fs.existsSync(file) && Date.now() - fs.statSync(file).mtimeMs < WEEK;
  if (!fresh) {
    try {
      const url = city ? await city.source() : key;
      const r = await fetch(url, { signal: AbortSignal.timeout(120000) });
      if (!r.ok) throw bad(`The timetable download failed (${r.status}).`, 502);
      buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > 200 * 1024 * 1024) throw bad("That timetable is too big.", 502);
      fs.writeFileSync(file, buf);
    } catch (e) { if (!fs.existsSync(file)) throw e; }
  }
  buf ??= fs.readFileSync(file);
  const files = unzip(buf);
  const txt = (n: string) => files.get(n)?.toString("utf8") ?? "";

  const agency = csv(txt("agency.txt")).next().value;
  const fd: Feed = { at: Date.now(), tz: city?.tz ?? agency?.agency_timezone ?? "UTC", routes: new Map(), stops: new Map(), byName: new Map(), trips: new Map(), times: new Map(), weekly: new Map(), exceptions: new Map() };
  for (const r of csv(txt("routes.txt"))) fd.routes.set(r.route_id, { short: r.route_short_name || r.route_long_name, type: Number(r.route_type), color: r.route_color, long: r.route_long_name });
  for (const s of csv(txt("stops.txt"))) {
    fd.stops.set(s.stop_id, s.stop_name);
    const k = s.stop_name.toLowerCase();
    fd.byName.set(k, [...(fd.byName.get(k) ?? []), s.stop_id]);
  }
  for (const t of csv(txt("trips.txt"))) fd.trips.set(t.trip_id, { route: t.route_id, service: t.service_id, head: t.trip_headsign });
  for (const st of csv(txt("stop_times.txt"))) {
    const [h, m, s] = (st.departure_time || st.arrival_time).split(":").map(Number);
    if (!Number.isFinite(h)) continue;
    const l = fd.times.get(st.stop_id) ?? [];
    l.push({ trip: st.trip_id, t: h * 3600 + m * 60 + (s || 0), seq: Number(st.stop_sequence) });
    fd.times.set(st.stop_id, l);
  }
  const D = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
  for (const c of csv(txt("calendar.txt"))) fd.weekly.set(c.service_id, { days: D.map((d) => c[d] === "1"), from: c.start_date, to: c.end_date });
  for (const c of csv(txt("calendar_dates.txt"))) {
    const m = fd.exceptions.get(c.service_id) ?? new Map();
    m.set(c.date, Number(c.exception_type));
    fd.exceptions.set(c.service_id, m);
  }
  feeds.set(key, fd);
  return fd;
}

/** Local date parts in the feed's time zone. */
function localNow(tz: string, at = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short", hourCycle: "h23" })
    .formatToParts(at).map((x) => [x.type, x.value]));
  const wd = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(p.weekday);
  return { ymd: `${p.year}${p.month}${p.day}`, wd, secs: Number(p.hour) * 3600 + Number(p.minute) * 60 + Number(p.second) };
}
function runs(fd: Feed, service: string, ymd: string, wd: number) {
  const ex = fd.exceptions.get(service)?.get(ymd);
  if (ex === 1) return true;
  if (ex === 2) return false;
  const w = fd.weekly.get(service);
  return !!w && w.days[wd] && ymd >= w.from && ymd <= w.to;
}

const lineId = (r: { type: number; short: string }) => `${KIND[r.type] ?? "bus"} ${r.short}`;
const stopName = (fd: Feed, name: string) => fd.stops.get(fd.byName.get(name.toLowerCase())?.[0] ?? "") ?? name;

/** Next departures (3 hours) from every platform with this stop name, filtered by line/trip. */
function departures(fd: Feed, stop: string, keep: (r: { type: number; short: string; color: string }, t: { head: string }) => boolean) {
  const ids = fd.byName.get(stop.toLowerCase());
  if (!ids) throw bad(`No stop called "${stop}" in this timetable.`, 404);
  const now = new Date();
  const today = localNow(fd.tz, now), yest = localNow(fd.tz, new Date(now.getTime() - 86400_000));
  const out: { line: string; kind: string; color: string; to: string; in: number; at: string }[] = [];
  for (const id of ids) for (const d of fd.times.get(id) ?? []) {
    const t = fd.trips.get(d.trip); if (!t) continue;
    const r = fd.routes.get(t.route); if (!r || !keep(r, t)) continue;
    // Today's service, plus yesterday's trips that run past midnight (times like 25:10).
    for (const [day, offset] of [[today, 0], [yest, 86400]] as const) {
      const secs = d.t - offset - today.secs;
      if (secs < -30 || secs > 3 * 3600) continue;
      if (!runs(fd, t.service, day.ymd, day.wd)) continue;
      const clock = (d.t - offset) % 86400;
      out.push({ line: r.short, kind: KIND[r.type] ?? "bus", color: r.color ? `#${r.color}` : "", to: t.head, in: Math.max(0, Math.round(secs / 60)),
        at: `${String(Math.floor(clock / 3600)).padStart(2, "0")}:${String(Math.floor(clock / 60) % 60).padStart(2, "0")}` });
    }
  }
  return out.sort((a, b) => a.in - b.in);
}

const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
const KIND: Record<number, string> = { 0: "tram", 3: "bus", 11: "trolleybus", 800: "trolleybus", 2: "train", 1: "metro", 4: "ferry" };

export async function registerTransit(app: FastifyInstance) {
  app.get("/api/transit/cities", async () => CITIES.map(({ id, name }) => ({ id, name })));

  // Stop names matching a search, with the lines that stop there.
  app.get("/api/transit/stops", async (req) => {
    const { city = "riga", q = "" } = req.query as Record<string, string>;
    const s = norm(String(q).trim());
    if (s.length < 2) return [];
    const fd = await feed(city);
    const out: { name: string; lines: string[] }[] = [];
    for (const [k, ids] of fd.byName) {
      if (!norm(k).includes(s)) continue;
      const lines = new Set<string>();
      for (const id of ids) for (const d of fd.times.get(id) ?? []) { const t = fd.trips.get(d.trip); const r = t && fd.routes.get(t.route); if (r) lines.add(`${KIND[r.type] ?? "bus"} ${r.short}`); }
      out.push({ name: fd.stops.get(ids[0])!, lines: [...lines].sort((a, b) => a.split(" ")[0].localeCompare(b.split(" ")[0]) || a.localeCompare(b, undefined, { numeric: true })) });
      if (out.length >= 12) break;
    }
    return out.sort((a, b) => norm(a.name).indexOf(s) - norm(b.name).indexOf(s) || a.name.localeCompare(b.name));
  });

  // Next departures from every platform with this stop name, for the chosen lines.
  app.get("/api/transit/departures", async (req) => {
    const { city = "riga", stop = "", lines = "", limit = "8" } = req.query as Record<string, string>;
    const fd = await feed(city);
    const want = new Set(String(lines).split(",").map((x) => x.trim()).filter(Boolean));
    // Lines are "bus 3" (or just "3" for any kind with that number).
    const out = departures(fd, String(stop), (r) => !want.size || want.has(r.short) || want.has(lineId(r)));
    return { stop: stopName(fd, String(stop)), departures: out.slice(0, Math.min(30, Number(limit) || 8)) };
  });

  // Every line in the city: "bus 25", "tram 11", ...
  app.get("/api/transit/lines", async (req) => {
    const fd = await feed(String((req.query as any).city ?? "riga"));
    const seen = new Map<string, { id: string; kind: string; short: string; name: string; color: string }>();
    for (const r of fd.routes.values()) if (!seen.has(lineId(r))) seen.set(lineId(r), { id: lineId(r), kind: KIND[r.type] ?? "bus", short: r.short, name: r.long, color: r.color ? `#${r.color}` : "" });
    return [...seen.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.short.localeCompare(b.short, undefined, { numeric: true }));
  });

  // A line's directions, each with its stops in order (from its longest trip).
  app.get("/api/transit/line", async (req) => {
    const { city = "riga", line = "" } = req.query as Record<string, string>;
    const fd = await feed(city);
    const routeIds = new Set([...fd.routes].filter(([, r]) => lineId(r) === line).map(([id]) => id));
    if (!routeIds.size) throw bad(`No line "${line}" in this timetable.`, 404);
    const tripStops = new Map<string, { seq: number; stop: string }[]>();
    for (const [stop, list] of fd.times) for (const d of list) {
      const t = fd.trips.get(d.trip);
      if (t && routeIds.has(t.route)) { const a = tripStops.get(d.trip) ?? []; a.push({ seq: d.seq, stop }); tripStops.set(d.trip, a); }
    }
    const best = new Map<string, string[]>(); // headsign -> stop names
    for (const [trip, a] of tripStops) {
      const head = fd.trips.get(trip)!.head;
      if ((best.get(head)?.length ?? 0) >= a.length) continue;
      const names = a.sort((x, y) => x.seq - y.seq).map((x) => fd.stops.get(x.stop)!);
      best.set(head, names.filter((n, i) => n !== names[i - 1]));
    }
    return [...best].map(([to, stops]) => ({ to, stops })).sort((a, b) => b.stops.length - a.stops.length).slice(0, 6);
  });

  // Several picks at once: [{ line: "bus 25", to: "Iļģuciems", stop: "Matīsa iela" }, ...]
  app.get("/api/transit/board", async (req) => {
    const { city = "riga", picks = "[]", limit = "3" } = req.query as Record<string, string>;
    const fd = await feed(city);
    let list: { line: string; to?: string; stop: string }[];
    try { list = JSON.parse(String(picks)).slice(0, 12); } catch { throw bad("Bad picks."); }
    return list.map((p) => {
      try {
        const out = departures(fd, p.stop, (r, t) => lineId(r) === p.line && (!p.to || t.head === p.to));
        return { ...p, stop: stopName(fd, p.stop), departures: out.slice(0, Math.min(8, Number(limit) || 3)) };
      } catch (e) { return { ...p, error: (e as Error).message, departures: [] }; }
    });
  });

  // ---------------- calendar (.ics / webcal link) ----------------
  app.get("/api/calendar", async (req) => {
    const { url = "", days = "7" } = req.query as Record<string, string>;
    return { events: await calendar(String(url), Math.min(31, Math.max(1, Number(days) || 7))) };
  });
}

// ---------------- iCalendar ----------------
const icsCache = new Map<string, { at: number; text: string }>();
// Only calendar services, so this can't be used to poke at other machines.
const CAL_HOSTS = /(^|\.)(icloud\.com|google\.com|outlook\.com|office365\.com|live\.com|fastmail\.com|proton\.me)$/i;

async function calendar(raw: string, days: number) {
  let u: URL;
  try { u = new URL(raw.trim().replace(/^webcals?:\/\//i, "https://")); } catch { throw bad("Paste the calendar's share link (webcal://… or https://…)."); }
  if (u.protocol !== "https:" || !CAL_HOSTS.test(u.hostname)) throw bad("That link isn't from a calendar service HarborOS knows (iCloud, Google, Outlook, Fastmail, Proton).");
  let c = icsCache.get(u.href);
  if (!c || Date.now() - c.at > 10 * 60_000) {
    const r = await fetch(u, { signal: AbortSignal.timeout(15000), redirect: "follow" });
    if (!r.ok) throw bad(`The calendar link answered ${r.status}. Is it still shared?`, 502);
    c = { at: Date.now(), text: (await r.text()).slice(0, 10 * 1024 * 1024) };
    icsCache.set(u.href, c);
  }
  return expand(c.text, days);
}

interface Ev { title: string; start: number; end: number; allDay: boolean; where?: string; cal?: string }
function parseDate(v: string, params: string): { t: number; allDay: boolean } {
  const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?/);
  if (!m) return { t: NaN, allDay: false };
  const [, y, mo, d, h, mi, s, z] = m;
  if (!h) return { t: new Date(+y, +mo - 1, +d).getTime(), allDay: true };
  if (z) return { t: Date.UTC(+y, +mo - 1, +d, +h, +mi, +s), allDay: false };
  const tz = params.match(/TZID=([^;:]+)/)?.[1];
  if (!tz) return { t: new Date(+y, +mo - 1, +d, +h, +mi, +s).getTime(), allDay: false };
  // Wall time in a named zone: find the UTC instant that shows this time there.
  const guess = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  try {
    const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
    const p = Object.fromEntries(f.formatToParts(guess).map((x) => [x.type, x.value]));
    const shown = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
    return { t: guess - (shown - guess), allDay: false };
  } catch { return { t: new Date(+y, +mo - 1, +d, +h, +mi, +s).getTime(), allDay: false }; }
}

export function expand(text: string, days: number): Ev[] {
  const lines = text.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
  const from = new Date(); from.setHours(0, 0, 0, 0);
  const a = from.getTime(), b = a + days * 86400_000;
  const calName = lines.find((l) => l.startsWith("X-WR-CALNAME:"))?.slice(13);
  const out: Ev[] = [];
  const overridden = new Set<string>();
  let ev: Record<string, { v: string; p: string }[]> | null = null;
  const unesc = (s: string) => s.replace(/\\n/gi, " ").replace(/\\([,;\\])/g, "$1");
  const events: Record<string, { v: string; p: string }[]>[] = [];
  for (const l of lines) {
    if (l === "BEGIN:VEVENT") { ev = {}; continue; }
    if (l === "END:VEVENT") { if (ev) events.push(ev); ev = null; continue; }
    if (!ev) continue;
    const i = l.indexOf(":"); if (i < 0) continue;
    const [name, ...ps] = l.slice(0, i).split(";");
    (ev[name] ??= []).push({ v: l.slice(i + 1), p: ps.join(";") });
  }
  for (const e of events) if (e["RECURRENCE-ID"]) overridden.add(`${e.UID?.[0]?.v}|${parseDate(e["RECURRENCE-ID"][0].v, e["RECURRENCE-ID"][0].p).t}`);

  for (const e of events) {
    if (!e.DTSTART || e.STATUS?.[0]?.v === "CANCELLED") continue;
    const s = parseDate(e.DTSTART[0].v, e.DTSTART[0].p);
    const en = e.DTEND ? parseDate(e.DTEND[0].v, e.DTEND[0].p).t : s.t + (s.allDay ? 86400_000 : 3600_000);
    const len = Math.max(0, en - s.t);
    const base = { title: unesc(e.SUMMARY?.[0]?.v ?? "(no title)"), allDay: s.allDay, where: e.LOCATION ? unesc(e.LOCATION[0].v) : undefined, cal: calName };
    const push = (t: number) => { if (t < b && t + len > a) out.push({ ...base, start: t, end: t + len }); };
    const rule = e.RRULE?.[0]?.v;
    if (!rule || e["RECURRENCE-ID"]) { push(s.t); continue; }

    const r = Object.fromEntries(rule.split(";").map((x) => x.split("=")));
    const ex = new Set((e.EXDATE ?? []).flatMap((x) => x.v.split(",").map((v) => parseDate(v, x.p).t)));
    const until = r.UNTIL ? parseDate(r.UNTIL, "").t : Infinity;
    const count = r.COUNT ? Number(r.COUNT) : Infinity;
    const step = Math.max(1, Number(r.INTERVAL) || 1);
    const byday = r.BYDAY ? r.BYDAY.split(",").map((d: string) => ["SU", "MO", "TU", "WE", "TH", "FR", "SA"].indexOf(d.slice(-2))) : null;
    const start = new Date(s.t);
    let n = 0;
    for (let i = 0; i < 2000 && n < count; i++) {
      // Each period (day/week/month/year) gives one or more occurrences.
      const p = new Date(start);
      if (r.FREQ === "DAILY") p.setDate(p.getDate() + i * step);
      else if (r.FREQ === "WEEKLY") p.setDate(p.getDate() + i * step * 7);
      else if (r.FREQ === "MONTHLY") p.setMonth(p.getMonth() + i * step);
      else if (r.FREQ === "YEARLY") p.setFullYear(p.getFullYear() + i * step);
      else break;
      let occ = [p.getTime()];
      if (r.FREQ === "WEEKLY" && byday) {
        const sun = new Date(p); sun.setDate(p.getDate() - p.getDay());
        occ = byday.map((d: number) => { const x = new Date(sun); x.setDate(sun.getDate() + d); return x.getTime(); }).filter((t: number) => t >= s.t).sort();
      }
      let stop = false;
      for (const t of occ) {
        if (t > until || n >= count) { stop = true; break; }
        n++;
        if (t >= b) { stop = true; break; }
        if (!ex.has(t) && !overridden.has(`${e.UID?.[0]?.v}|${t}`)) push(t);
      }
      if (stop || p.getTime() > b) break;
    }
  }
  return out.sort((x, y) => x.start - y.start).slice(0, 60);
}
