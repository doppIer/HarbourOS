// Wall mode (/wall): a full-screen, touch-first home screen for a tablet that
// stays on. Tiles are the same widget files as the dashboard. Long press any
// tile to edit; the screen behaviour (night dimming, wake on touch, burn-in
// shift, screensaver, keep awake) is set per tablet in "Screen".
import { useEffect, useRef, useState } from "preact/hooks";
import { apps, isAdmin, me, settings, opensInTab, type App } from "../store";
import { api } from "../lib/ws";
import { Icon } from "../icons/Icon";
import { Tile, type LayoutItem, type Size } from "../widgets/runtime";
import { appSrc } from "../shell/AppHost";
import { BackgroundLayer, ASCII_CREDIT } from "../shell/Background";
import { Talk, DJ } from "./Sections";
import { NowPlaying, current as nowTrack } from "./player";
import * as V from "./voice";

export interface Screen {
  dim: { on: boolean; from: string; to: string; level: number };
  wake: { on: boolean; seconds: number };
  shift: { on: boolean; minutes: number; px: number };
  saver: { on: boolean; minutes: number; style: "clock" | "black" };
  keepAwake: boolean;
}
export interface Look { theme: "dark" | "light"; glass: number; background: string; header: boolean; preset: string }
interface Profile { id: string; name: string; layout: LayoutItem[]; screen: Screen; look: Look; custom?: LayoutItem[] }

// Ready-made layouts. The grid has 4 columns: s = 1×1, m = 2×1, l = 2×2, w = 4×1, tall = 1×2.
interface Preset { id: string; name: string; note: string; header: boolean; items: { widget: string; size: Size }[] }
const PRESETS: Preset[] = [
  { id: "home", name: "Home", note: "Big clock up top, then weather, departures, calendar", header: false,
    items: [{ widget: "clock", size: "hero" }, { widget: "weather", size: "m" }, { widget: "bus", size: "m" }, { widget: "calendar", size: "m" }, { widget: "system-summary", size: "m" }] },
  { id: "agenda", name: "Agenda", note: "Big calendar beside weather and departures", header: false,
    items: [{ widget: "clock", size: "w" }, { widget: "calendar", size: "l" }, { widget: "weather", size: "m" }, { widget: "bus", size: "m" }] },
  { id: "commute", name: "Commute", note: "Departures first, for the hallway", header: true,
    items: [{ widget: "clock", size: "w" }, { widget: "bus", size: "l" }, { widget: "weather", size: "m" }] },
  { id: "clock", name: "Bedside", note: "A big clock and little else", header: false,
    items: [{ widget: "clock", size: "hero" }, { widget: "weather", size: "m" }, { widget: "calendar", size: "m" }] },
  { id: "server", name: "Server", note: "How the home server is doing", header: true,
    items: [{ widget: "system-summary", size: "w" }, { widget: "system-area", size: "l" }, { widget: "containers-summary", size: "m" }, { widget: "weather", size: "m" }] },
];
const WALL_BGS = [["none", "None"], ["ascii:koi", "Koi"], ["ascii:jellyfish", "Jellyfish"], ["ascii:butterflies", "Butterflies"], ["ascii:cranes", "Cranes"], ["ascii:dragonflies", "Dragonflies"]];

const SIZES: Size[] = ["s", "m", "l", "w", "tall", "hero"];
const SIZE_NAME: Record<Size, string> = { s: "Small", m: "Wide", l: "Large", w: "Full width", tall: "Tall", hero: "Hero" };

const mins = (hhmm: string) => { const [h, m] = hhmm.split(":").map(Number); return (h || 0) * 60 + (m || 0); };
function isNight(d: Screen["dim"], now = new Date()) {
  const t = now.getHours() * 60 + now.getMinutes(), a = mins(d.from), b = mins(d.to);
  return a <= b ? t >= a && t < b : t >= a || t < b;
}

export function Wall() {
  const [p, setP] = useState<Profile | null>(null);
  const [err, setErr] = useState("");
  const [editing, setEditing] = useState(false);
  const [sheet, setSheet] = useState<null | "add" | "screen" | "layouts" | { opts: number }>(null);
  const [open, setOpen] = useState<App | null>(null);
  const [section, setSection] = useState<"tiles" | "talk" | "dj">("tiles");
  const wakeWord = settings.value?.assistant?.wakeWord || "hey harbor";

  // The assistant answers "next bus" and "what's on today" from this wall's own tiles.
  useEffect(() => {
    if (!p) return;
    const bus = p.layout.find((i) => i.widget === "bus")?.opts, cal = p.layout.find((i) => i.widget === "calendar")?.opts;
    let picks: unknown[] = [];
    try { picks = JSON.parse(bus?.picks || "[]"); } catch {}
    V.setup({ picks, city: bus?.gtfs || bus?.city || "riga", calendar: cal?.url }, () => { setOpen(null); setSection("talk"); });
  }, [p]);
  useEffect(() => { V.setWakeWord(wakeWord); V.resumeWake(); }, [wakeWord]);
  // "Play some music" from AI Talk: show the player starting, then go back to the tiles.
  const music = V.lastMusic.value;
  useEffect(() => {
    if (!music || section !== "talk") return;
    const t = setTimeout(() => setSection("tiles"), 2600);
    return () => clearTimeout(t);
  }, [music]);

  useEffect(() => { api<Profile>("/api/wall/profile").then(setP).catch((e) => setErr(e.message)); }, []);
  const save = (n: Profile) => { setP(n); api("/api/wall/profile", { method: "PUT", json: { layout: n.layout, screen: n.screen, look: n.look, custom: n.custom } }).catch((e) => setErr(e.message)); };
  // Any edit makes the layout your own ("Custom").
  const setLayout = (layout: LayoutItem[]) => p && save({ ...p, layout, custom: undefined, look: { ...p.look, preset: "custom" } });
  const applyPreset = (id: string) => {
    if (!p || id === p.look.preset) return;
    const mine = p.look.preset === "custom" ? p.layout : p.custom ?? [];
    if (id === "custom") return save({ ...p, layout: mine.length ? mine : p.layout, custom: undefined, look: { ...p.look, preset: "custom", header: true } });
    const pr = PRESETS.find((x) => x.id === id)!;
    // Keep your settings (bus lines, calendar link, ...) from tiles you already had.
    const optsOf = (w: string) => [...p.layout, ...mine].find((i) => i.widget === w && i.opts)?.opts;
    const layout = pr.items.map((i) => ({ ...i, ...(optsOf(i.widget) ? { opts: optsOf(i.widget) } : {}) }));
    save({ ...p, layout, custom: mine, look: { ...p.look, preset: id, header: pr.header } });
  };
  const setScreen = (screen: Screen) => p && save({ ...p, screen });
  const setLook = (look: Look) => p && save({ ...p, look });

  const openApp = (id: string) => {
    const a = apps.value.find((x) => x.id === id);
    if (!a) return;
    if (a.status !== "running" && a.status !== "link") api(`/api/apps/${a.id}/open`, { method: "POST" }).catch(() => {});
    if (opensInTab(a)) { window.open(a.url, "_blank", "noopener"); return; }
    setOpen(a);
  };

  const fx = useScreen(p?.screen);

  if (err && !p) return <div class="wall"><div class="wall-msg">{err}</div></div>;
  if (!p) return <div class="wall" />;

  return (
    <div class={`wall ${p.look.theme}`} style={{ "--glass": p.look.glass / 100 } as any} onPointerDownCapture={fx.touch}>
      {p.look.background !== "none" && <BackgroundLayer module={p.look.background} theme={p.look.theme} paused={!!open || fx.dim > 0 || fx.saver} />}
      <nav class="wall-rail" aria-label="Wall">
        {me.value?.role !== "device" && <a class="wall-rail-btn" href="/" aria-label="Back to the desktop" title="Desktop"><Icon name="solar:home-2-linear" size={24} /></a>}
        <button class={`wall-rail-btn ${section === "tiles" && !editing ? "on" : ""}`} aria-label="Tiles" title="Tiles" onClick={() => setSection("tiles")}><Icon name="solar:widget-4-linear" size={22} /></button>
        <button class={`wall-rail-btn ${section === "talk" ? "on" : ""} ${V.phase.value === "wake" ? "listening" : ""}`} aria-label="AI Talk" title="AI Talk" onClick={() => setSection("talk")}><Icon name="solar:microphone-3-linear" size={22} /></button>
        <button class={`wall-rail-btn ${section === "dj" ? "on" : ""}`} aria-label="DJ" title="DJ" onClick={() => setSection("dj")}><Icon name="solar:music-library-2-linear" size={22} /></button>
        <span class="wall-rail-sep" />
        <button class={`wall-rail-btn ${editing ? "on" : ""}`} aria-label="Edit tiles" title="Edit tiles" onClick={() => { setSection("tiles"); setEditing(!editing); }}><Icon name="solar:pen-2-linear" size={22} /></button>
        <button class="wall-rail-btn" aria-label="Layouts" title="Layouts" onClick={() => setSheet("layouts")}><Icon name="solar:widget-5-linear" size={22} /></button>
        <button class="wall-rail-btn" aria-label="Add tile" title="Add tile" onClick={() => { setEditing(true); setSheet("add"); }}><Icon name="solar:widget-add-linear" size={22} /></button>
        <button class="wall-rail-btn" aria-label="Full screen" title="Full screen" onClick={() => document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.().catch(() => {})}><Icon name="solar:maximize-square-linear" size={22} /></button>
        <span style={{ flex: 1 }} />
        <button class="wall-rail-btn" aria-label="Screen settings" title="Screen" onClick={() => setSheet("screen")}><Icon name="solar:settings-linear" size={22} /></button>
      </nav>
      {section !== "tiles" && (
        <div class="wall-section" key={section} style={{ transform: fx.shift }}>
          {section === "talk" ? <Talk wakeWord={wakeWord} /> : <DJ />}
        </div>
      )}
      <div class={`wall-inner ${section === "tiles" ? "sec-in" : "sec-hidden"} ${nowTrack.value ? "with-np" : ""}`} style={{ transform: fx.shift }}>
        {p.look.header !== false && <WallHeader />}
        {editing && (
          <div class="wall-bar">
            <span style={{ fontWeight: 600 }}>Editing {p.name}</span>
            <span class="muted" style={{ fontSize: 13 }}>Tap a tile's buttons to move, resize or remove it.</span>
            <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
              <button class="btn wall-btn" onClick={() => setSheet("add")}><Icon name="solar:widget-add-linear" size={18} />Add tile</button>
              <button class="btn wall-btn" onClick={() => setSheet("screen")}><Icon name="solar:settings-linear" size={18} />Screen</button>
              <button class="btn wall-btn" onClick={() => document.documentElement.requestFullscreen?.().catch(() => {})}><Icon name="solar:maximize-square-linear" size={18} />Full screen</button>
              {me.value?.role !== "device" && <a class="btn wall-btn" href="/"><Icon name="solar:arrow-left-linear" size={18} />Desktop</a>}
              <button class="btn primary wall-btn" onClick={() => setEditing(false)}><Icon name="solar:check-circle-linear" size={18} />Done</button>
            </span>
          </div>
        )}
        {!p.layout.length && !editing && (
          <div class="wall-msg">Nothing here yet. <button class="btn wall-btn" onClick={() => { setEditing(true); setSheet("add"); }}>Add tiles</button></div>
        )}
        <div class="wall-grid">
          {p.layout.map((item, i) => (
            <WallTile key={item.widget + i + JSON.stringify(item.opts ?? {})} item={item} editing={editing} openApp={openApp}
              onLongPress={() => setEditing(true)}
              move={(d) => { const l = [...p.layout]; const j = i + d; if (j < 0 || j >= l.length) return; [l[i], l[j]] = [l[j], l[i]]; setLayout(l); }}
              resize={() => { const l = [...p.layout]; l[i] = { ...item, size: SIZES[(SIZES.indexOf(item.size) + 1) % SIZES.length] }; setLayout(l); }}
              remove={() => setLayout(p.layout.filter((_, j) => j !== i))}
              options={OPTIONS[item.widget] ? () => setSheet({ opts: i }) : undefined} />
          ))}
        </div>
      </div>

      {section !== "dj" && <NowPlaying onOpen={() => setSection("dj")} />}

      {open && (
        <div class="wall-app">
          <iframe class="frame" src={appSrc(apps.value.find((a) => a.id === open.id) ?? open)} title={open.name} allow="fullscreen; autoplay" />
          <button class="wall-close" aria-label={`Close ${open.name}`} onClick={() => setOpen(null)}><Icon name="solar:close-circle-linear" size={30} /></button>
        </div>
      )}

      {sheet === "add" && <AddSheet close={() => setSheet(null)} add={(it) => { setLayout([...p.layout, it]); setSheet(null); }} />}
      {sheet === "layouts" && <LayoutsSheet current={p.look.preset ?? "custom"} custom={p.look.preset === "custom" ? p.layout : p.custom ?? []} pick={(id) => { applyPreset(id); setSheet(null); }} close={() => setSheet(null)} />}
      {sheet === "screen" && <ScreenSheet screen={p.screen} look={p.look} onLook={setLook} wakeLock={fx.wakeLock} close={() => setSheet(null)} onChange={setScreen} />}
      {sheet && typeof sheet === "object" && (
        <OptionsSheet item={p.layout[sheet.opts]} close={() => setSheet(null)}
          onChange={(opts) => { const l = [...p.layout]; l[sheet.opts] = { ...l[sheet.opts], opts }; setLayout(l); }} />
      )}

      {fx.dim > 0 && <div class="wall-dim" style={{ opacity: fx.dim / 100, pointerEvents: p.screen.wake.on ? "auto" : "none" }} />}
      {fx.saver && <Saver style={p.screen.saver.style} />}
    </div>
  );
}

// ---------- header: weather strip, greeting, clock ----------
function WallHeader() {
  const [now, setNow] = useState(new Date());
  const [wx, setWx] = useState<any>(null);
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 15_000); return () => clearInterval(t); }, []);
  useEffect(() => {
    const load = () => api<any>("/api/weather").then(setWx).catch(() => {});
    load(); const t = setInterval(load, 10 * 60_000); return () => clearInterval(t);
  }, []);
  const h = now.getHours();
  const part = h < 5 ? "Good night" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  const name = me.value?.role === "device" ? "" : (me.value?.name ?? "").split(" ")[0];
  const c = wx?.current;
  return (
    <header class="wall-head">
      <div class="wall-strip">
        {c ? <>
          <span><Icon name="solar:temperature-linear" size={16} />{Math.round(c.temperature_2m)}°C</span>
          <span><Icon name="solar:waterdrops-linear" size={16} />{c.relative_humidity_2m}%</span>
          <span><Icon name="solar:wind-linear" size={16} />{Math.round(c.wind_speed_10m)} km/h</span>
          <span class="dim">{wx.place?.name?.split(",")[0]}</span>
        </> : <span />}
        <span class="wall-strip-time">{now.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })} · {now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
      </div>
      <h1 class="wall-greet">{part}{name ? `, ${name}` : ""}.<br /><span>Have a great day.</span></h1>
    </header>
  );
}

// ---------- one tile: long press to edit; buttons while editing ----------
function WallTile({ item, editing, openApp, onLongPress, move, resize, remove, options }: {
  item: LayoutItem; editing: boolean; openApp: (id: string) => void; onLongPress: () => void;
  move: (d: number) => void; resize: () => void; remove: () => void; options?: () => void;
}) {
  const timer = useRef<number>();
  const down = () => { clearTimeout(timer.current); timer.current = window.setTimeout(() => { navigator.vibrate?.(15); onLongPress(); }, 600); };
  const up = () => clearTimeout(timer.current);
  return (
    <div class={`wall-cell ${item.size} ${editing ? "editing" : ""}`} onPointerDown={down} onPointerUp={up} onPointerLeave={up} onPointerCancel={up}
      onContextMenu={(e) => e.preventDefault()}>
      <Tile item={item} editing={editing} mode="wall" open={openApp} />
      {editing && (
        <div class="wall-edit">
          <button class="iconbtn" aria-label="Move earlier" onClick={() => move(-1)}><Icon name="solar:arrow-left-linear" size={20} /></button>
          <button class="btn" onClick={resize}>{SIZE_NAME[item.size]}</button>
          {options && <button class="iconbtn" aria-label="Tile options" onClick={options}><Icon name="solar:settings-linear" size={20} /></button>}
          <button class="iconbtn" aria-label="Move later" onClick={() => move(1)}><Icon name="solar:arrow-right-linear" size={20} /></button>
          <button class="iconbtn" aria-label="Remove tile" onClick={remove}><Icon name="solar:trash-bin-minimalistic-linear" size={20} /></button>
        </div>
      )}
    </div>
  );
}

// ---------- screen behaviour ----------
function useScreen(s?: Screen) {
  const [now, setNow] = useState(Date.now());
  const last = useRef(Date.now());       // last touch
  const awakeUntil = useRef(0);
  const [shift, setShift] = useState("none");
  const [wakeLock, setWakeLock] = useState<"on" | "off" | "unsupported">("off");

  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 15_000); return () => clearInterval(t); }, []);

  // Burn-in protection: nudge everything a few pixels now and then.
  useEffect(() => {
    if (!s?.shift.on) { setShift("none"); return; }
    const move = () => { const r = () => Math.round((Math.random() * 2 - 1) * s.shift.px); setShift(`translate(${r()}px, ${r()}px)`); };
    const t = setInterval(move, Math.max(1, s.shift.minutes) * 60_000);
    return () => clearInterval(t);
  }, [s?.shift.on, s?.shift.minutes, s?.shift.px]);

  // Keep the screen on (needs https; Android kiosk browsers can also do it themselves).
  useEffect(() => {
    if (!s?.keepAwake) { setWakeLock("off"); return; }
    if (!("wakeLock" in navigator)) { setWakeLock("unsupported"); return; }
    let lock: any = null, dead = false;
    const get = () => (navigator as any).wakeLock.request("screen").then((l: any) => { if (dead) l.release(); else { lock = l; setWakeLock("on"); } }).catch(() => setWakeLock("unsupported"));
    const vis = () => { if (document.visibilityState === "visible") get(); };
    get(); document.addEventListener("visibilitychange", vis);
    return () => { dead = true; lock?.release?.(); document.removeEventListener("visibilitychange", vis); };
  }, [s?.keepAwake]);

  const awake = now < awakeUntil.current;
  const dim = s?.dim.on && isNight(s.dim) && !awake ? s.dim.level : 0;
  const saver = !!s?.saver.on && now - last.current > s.saver.minutes * 60_000;

  const touch = (e: PointerEvent) => {
    const wasSaver = saver, wasDim = dim > 0 && !!s?.wake.on;
    last.current = Date.now();
    if (s?.wake.on) awakeUntil.current = Date.now() + s.wake.seconds * 1000;
    if (wasSaver || wasDim) { e.stopPropagation(); e.preventDefault(); }
    setNow(Date.now());
  };
  return { dim, saver, shift, touch, wakeLock };
}

function Saver({ style }: { style: "clock" | "black" }) {
  const [t, setT] = useState(new Date());
  const [pos, setPos] = useState({ x: 50, y: 45 });
  useEffect(() => { const i = setInterval(() => setT(new Date()), 10_000); const j = setInterval(() => setPos({ x: 30 + Math.random() * 40, y: 30 + Math.random() * 40 }), 60_000); return () => { clearInterval(i); clearInterval(j); }; }, []);
  return (
    <div class="wall-saver">
      {style === "clock" && (
        <div style={{ position: "absolute", left: `${pos.x}%`, top: `${pos.y}%`, transform: "translate(-50%, -50%)", textAlign: "center", transition: "left 2s, top 2s" }}>
          <div class="big" style={{ fontSize: 120, color: "#6d7076", letterSpacing: "-0.04em" }}>{t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</div>
          <div style={{ color: "#4a4d52", fontSize: 22 }}>{t.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" })}</div>
        </div>
      )}
    </div>
  );
}

// ---------- sheets ----------
function Sheet({ title, close, children }: { title: string; close: () => void; children: any }) {
  return (
    <div class="scrim" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div class="dialog wall-sheet" role="dialog" aria-label={title}>
        <header>{title}<button class="iconbtn" style={{ marginLeft: "auto" }} aria-label="Close" onClick={close}><Icon name="solar:close-circle-linear" size={22} /></button></header>
        <div class="body">{children}</div>
      </div>
    </div>
  );
}

const PRETTY: Record<string, string> = {
  clock: "Clock", weather: "Weather", "system-summary": "System", "system-area": "System load chart", cpu: "CPU", memory: "Memory",
  power: "Power", temp: "Temperature", bus: "Bus departures", calendar: "Calendar", network: "Network", disks: "Disks", savings: "Savings", load: "Load", "containers-summary": "Containers",
};
const DEFAULT_SIZE: Record<string, Size> = { clock: "hero", weather: "m", "system-summary": "m", "system-area": "l", "containers-summary": "tall", bus: "m", calendar: "tall" };

function AddSheet({ close, add }: { close: () => void; add: (i: LayoutItem) => void }) {
  const [list, setList] = useState<string[]>([]);
  useEffect(() => { api<string[]>("/api/widgets").then((l) => setList(l.filter((w) => w !== "app"))); }, []);
  return (
    <Sheet title="Add a tile" close={close}>
      <div class="sec" style={{ padding: 0 }}>Widgets</div>
      <div class="wall-choices">
        {list.map((w) => <button key={w} class="btn wall-btn" onClick={() => add({ widget: w, size: DEFAULT_SIZE[w] ?? "s" })}>{PRETTY[w] ?? w}</button>)}
      </div>
      <div class="sec" style={{ padding: 0 }}>Apps</div>
      <div class="wall-choices">
        {apps.value.map((a) => (
          <button key={a.id} class="btn wall-btn" onClick={() => add({ widget: "app", size: "s", opts: { app: a.id } })}><Icon name={a.icon} size={20} />{a.name}</button>
        ))}
        {!apps.value.length && <span class="dim">No apps yet. Add them from the desktop sidebar.</span>}
      </div>
      <div class="dim" style={{ fontSize: 12.5 }}>Each widget is a file in <span class="mono">data/widgets/</span>; edit it and every screen reloads it.</div>
    </Sheet>
  );
}

// Per-widget options shown under the tile's gear button.
const OPTIONS: Record<string, (o: Record<string, string>, set: (o: Record<string, string>) => void) => any> = {
  app: (o, set) => (
    <div class="wall-choices">
      {apps.value.map((a) => <button key={a.id} class={`btn wall-btn ${o.app === a.id ? "primary" : ""}`} onClick={() => set({ ...o, app: a.id })}><Icon name={a.icon} size={20} />{a.name}</button>)}
    </div>
  ),
  bus: (o, set) => <BusOptions o={o} set={set} />,
  calendar: (o, set) => (
    <>
      <label class="field">Calendar share link
        <input class="input" placeholder="webcal://p123-caldav.icloud.com/published/2/…" value={o.url ?? ""} onChange={(e) => set({ ...o, url: e.currentTarget.value.trim() })} />
      </label>
      <div class="dim" style={{ fontSize: 12.5 }}>On a Mac: Calendar → right-click the calendar → Share Calendar… → tick Public Calendar → copy the link. On iPhone: Calendar → Calendars → (i) → Public Calendar → Share Link.</div>
      <div class="wall-row">Show the next
        <select class="input" value={o.days ?? "7"} onChange={(e) => set({ ...o, days: e.currentTarget.value })}>
          {["1", "3", "7", "14", "31"].map((d) => <option key={d} value={d}>{d === "1" ? "day" : `${d} days`}</option>)}
        </select></div>
    </>
  ),
  clock: (o, set) => (
    <>
      <label class="field"><span>Style</span>
        <select class="input" value={o.style || "plain"} onChange={(e) => set({ ...o, style: e.currentTarget.value })}>
          <option value="plain">Big digits</option><option value="flip">Flip cards</option>
        </select>
      </label>
      <label class="check"><input type="checkbox" checked={o.seconds === "1"} onChange={(e) => set({ ...o, seconds: e.currentTarget.checked ? "1" : "" })} />Show seconds</label>
      <label class="check"><input type="checkbox" checked={o.h12 === "1"} onChange={(e) => set({ ...o, h12: e.currentTarget.checked ? "1" : "" })} />12-hour clock</label>
    </>
  ),
};

interface Pick { line: string; to: string; stop: string }
interface Line { id: string; kind: string; short: string; name: string; color: string }
function MiniGrid({ items }: { items: { widget: string; size: Size }[] }) {
  return (
    <div class="wall-mini">
      {items.map((i, k) => <div key={k} class={`wall-mini-cell ${i.size}`}>{PRETTY[i.widget] ?? i.widget}</div>)}
    </div>
  );
}

function LayoutsSheet({ current, custom, pick, close }: { current: string; custom: LayoutItem[]; pick: (id: string) => void; close: () => void }) {
  return (
    <Sheet title="Layouts" close={close}>
      <div class="wall-layouts">
        {PRESETS.map((pr) => (
          <button key={pr.id} class={`wall-layout ${current === pr.id ? "on" : ""}`} onClick={() => pick(pr.id)}>
            {pr.header && <div class="wall-mini-head" />}
            <MiniGrid items={pr.items} />
            <b>{pr.name}</b><span class="dim">{pr.note}</span>
          </button>
        ))}
        <button class={`wall-layout ${current === "custom" ? "on" : ""}`} onClick={() => pick("custom")}>
          <div class="wall-mini-head" />
          {custom.length ? <MiniGrid items={custom} /> : <div class="wall-mini dim" style={{ placeItems: "center", display: "grid" }}>Empty</div>}
          <b>Custom</b><span class="dim">Your own: edit tiles with the pencil</span>
        </button>
      </div>
      <div class="dim" style={{ fontSize: 12.5 }}>Picking a layout keeps your Custom one, and tiles keep their settings (bus lines, calendar link). Editing any tile turns it into your Custom layout.</div>
    </Sheet>
  );
}

function BusOptions({ o, set }: { o: Record<string, string>; set: (o: Record<string, string>) => void }) {
  const [cities, setCities] = useState<{ id: string; name: string }[]>([]);
  const [lines, setLines] = useState<Line[]>([]);
  const [kind, setKind] = useState("bus");
  const [line, setLine] = useState<Line | null>(null);
  const [dirs, setDirs] = useState<{ to: string; stops: string[] }[]>([]);
  const [dir, setDir] = useState<{ to: string; stops: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const custom = o.city === "custom";
  const src = custom ? o.gtfs ?? "" : o.city || "riga";
  let picks: Pick[] = [];
  try { picks = JSON.parse(o.picks || "[]"); } catch {}
  const savePicks = (p: Pick[]) => set({ ...o, picks: JSON.stringify(p), stop: "", lines: "" });

  useEffect(() => { api<{ id: string; name: string }[]>("/api/transit/cities").then(setCities).catch(() => {}); }, []);
  useEffect(() => {
    if (!src) return;
    setBusy(true); setErr(""); setLine(null);
    api<Line[]>(`/api/transit/lines?${new URLSearchParams({ city: src })}`).then(setLines).catch((e) => setErr(e.message)).finally(() => setBusy(false));
  }, [src]);
  useEffect(() => {
    setDirs([]); setDir(null);
    if (!line) return;
    api<{ to: string; stops: string[] }[]>(`/api/transit/line?${new URLSearchParams({ city: src, line: line.id })}`).then(setDirs).catch((e) => setErr(e.message));
  }, [line]);
  const kinds = [...new Set(lines.map((l) => l.kind))];
  const add = (stop: string) => { savePicks([...picks, { line: line!.id, to: dir!.to, stop }]); setLine(null); };

  return (
    <>
      <label class="field">City
        <select class="input" value={o.city || "riga"} onChange={(e) => set({ ...o, city: e.currentTarget.value, picks: "[]" })}>
          {cities.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          <option value="custom">Another city (GTFS link)…</option>
        </select>
      </label>
      {custom && <label class="field">GTFS timetable link (.zip)
        <input class="input" placeholder="https://…/gtfs.zip" value={o.gtfs ?? ""} onChange={(e) => set({ ...o, gtfs: e.currentTarget.value.trim(), picks: "[]" })} />
      </label>}

      <div class="wall-group">
        <b>On this tile</b>
        {!picks.length && <div class="dim">Nothing yet. Add a line below.</div>}
        {picks.map((p, i) => (
          <div key={i} class="wall-row">
            <span class="tag">{p.line}</span> → {p.to} <span class="dim">from {p.stop}</span>
            <button class="iconbtn" style={{ marginLeft: "auto" }} aria-label="Remove" onClick={() => savePicks(picks.filter((_, j) => j !== i))}><Icon name="solar:trash-bin-trash-linear" size={16} /></button>
          </div>
        ))}
      </div>

      <b>Add a line</b>
      {busy && <div class="dim">Loading the timetable… (the first time takes a few seconds)</div>}
      {err && <div class="err-text">{err}</div>}
      <div class="wall-choices">
        {kinds.map((k) => <button key={k} class={`btn wall-btn ${kind === k ? "primary" : ""}`} onClick={() => { setKind(k); setLine(null); }}>{k[0].toUpperCase() + k.slice(1)}</button>)}
      </div>
      {!line && <div class="wall-choices">
        {lines.filter((l) => l.kind === kind).map((l) => (
          <button key={l.id} class="btn" title={l.name} style={{ minWidth: 52, height: 40, justifyContent: "center", background: l.color || undefined, color: l.color ? "#fff" : undefined, borderColor: "transparent", fontWeight: 600 }} onClick={() => setLine(l)}>{l.short}</button>
        ))}
      </div>}
      {line && <>
        <div class="wall-row"><span class="tag">{line.id}</span> {line.name} <button class="btn" style={{ marginLeft: "auto" }} onClick={() => setLine(null)}>Change</button></div>
        <div class="dim">Which way?</div>
        <div class="wall-choices">
          {dirs.map((d) => <button key={d.to} class={`btn wall-btn ${dir?.to === d.to ? "primary" : ""}`} onClick={() => setDir(d)}>→ {d.to}</button>)}
        </div>
        {dir && <>
          <div class="dim">Your stop:</div>
          <div class="wall-choices" style={{ maxHeight: 260, overflow: "auto" }}>
            {dir.stops.slice(0, -1).map((s, i) => <button key={s + i} class="btn" onClick={() => add(s)}>{s}</button>)}
          </div>
        </>}
      </>}
    </>
  );
}

function OptionsSheet({ item, close, onChange }: { item: LayoutItem; close: () => void; onChange: (o: Record<string, string>) => void }) {
  const [o, setO] = useState(item.opts ?? {});
  const set = (n: Record<string, string>) => { setO(n); onChange(n); };
  return <Sheet title={`${PRETTY[item.widget] ?? item.widget} tile`} close={close}>{OPTIONS[item.widget]?.(o, set)}</Sheet>;
}

function ScreenSheet({ screen, look, onLook, wakeLock, close, onChange }: { screen: Screen; look: Look; onLook: (l: Look) => void; wakeLock: string; close: () => void; onChange: (s: Screen) => void }) {
  const [s, setS] = useState(screen);
  const [l, setL] = useState(look);
  const lk = (v: Partial<Look>) => { const n = { ...l, ...v }; setL(n); onLook(n); };
  const set = <K extends keyof Screen>(k: K, v: Partial<Screen[K]> | Screen[K]) => {
    const n = { ...s, [k]: typeof v === "object" ? { ...(s[k] as object), ...v } : v } as Screen;
    setS(n); onChange(n);
  };
  const num = (v: string, lo: number, hi: number) => Math.max(lo, Math.min(hi, Number(v) || lo));
  return (
    <Sheet title="Screen" close={close}>
      <div class="wall-group">
        <b>Look</b>
        <div class="wall-row">Mode
          <div class="seg">
            {(["dark", "light"] as const).map((t) => <button key={t} class={`btn ${l.theme === t ? "primary" : ""}`} onClick={() => lk({ theme: t })}>{t === "dark" ? "Dark" : "Light"}</button>)}
          </div>
        </div>
        <label class="check"><input type="checkbox" checked={l.header !== false} onChange={(e) => lk({ header: e.currentTarget.checked })} />Greeting and weather line at the top</label>
        <div class="wall-row">Tile see-through <input type="range" min={0} max={90} value={100 - l.glass} onInput={(e) => lk({ glass: 100 - Number(e.currentTarget.value) })} /> <span class="mono">{100 - l.glass}%</span></div>
        <div class="wall-row">Background
          <select class="input" value={l.background} onChange={(e) => lk({ background: e.currentTarget.value })}>
            {WALL_BGS.map(([v, n]) => <option key={v} value={v}>{n}</option>)}
          </select>
        </div>
        {l.background !== "none" && <div class="dim" style={{ fontSize: 12 }}>ASCII animals: <a href={ASCII_CREDIT.url} target="_blank" rel="noopener">{ASCII_CREDIT.name}</a> (MIT)</div>}
      </div>

      <div class="wall-group">
        <label class="check"><input type="checkbox" checked={s.dim.on} onChange={(e) => set("dim", { on: e.currentTarget.checked })} /><b>Dim at night</b></label>
        <div class="wall-row" aria-disabled={!s.dim.on}>
          From <input class="input" type="time" value={s.dim.from} disabled={!s.dim.on} onChange={(e) => set("dim", { from: e.currentTarget.value })} />
          to <input class="input" type="time" value={s.dim.to} disabled={!s.dim.on} onChange={(e) => set("dim", { to: e.currentTarget.value })} />
        </div>
        <div class="wall-row">Darkness <input type="range" min={10} max={95} value={s.dim.level} disabled={!s.dim.on} onInput={(e) => set("dim", { level: Number(e.currentTarget.value) })} /> <span class="mono">{s.dim.level}%</span></div>
      </div>

      <div class="wall-group">
        <label class="check"><input type="checkbox" checked={s.wake.on} onChange={(e) => set("wake", { on: e.currentTarget.checked })} /><b>Wake on touch</b></label>
        <div class="wall-row">The first touch only brightens the screen, for
          <input class="input" type="number" min={5} max={600} style={{ width: 80 }} value={s.wake.seconds} disabled={!s.wake.on} onChange={(e) => set("wake", { seconds: num(e.currentTarget.value, 5, 600) })} /> seconds</div>
      </div>

      <div class="wall-group">
        <label class="check"><input type="checkbox" checked={s.shift.on} onChange={(e) => set("shift", { on: e.currentTarget.checked })} /><b>Burn-in protection</b></label>
        <div class="wall-row">Move everything up to
          <input class="input" type="number" min={1} max={20} style={{ width: 70 }} value={s.shift.px} disabled={!s.shift.on} onChange={(e) => set("shift", { px: num(e.currentTarget.value, 1, 20) })} /> px every
          <input class="input" type="number" min={1} max={120} style={{ width: 70 }} value={s.shift.minutes} disabled={!s.shift.on} onChange={(e) => set("shift", { minutes: num(e.currentTarget.value, 1, 120) })} /> min</div>
      </div>

      <div class="wall-group">
        <label class="check"><input type="checkbox" checked={s.saver.on} onChange={(e) => set("saver", { on: e.currentTarget.checked })} /><b>Screensaver</b></label>
        <div class="wall-row">After
          <input class="input" type="number" min={1} max={240} style={{ width: 70 }} value={s.saver.minutes} disabled={!s.saver.on} onChange={(e) => set("saver", { minutes: num(e.currentTarget.value, 1, 240) })} /> min without a touch, show
          <select class="input" style={{ width: 140 }} value={s.saver.style} disabled={!s.saver.on} onChange={(e) => set("saver", { style: e.currentTarget.value as "clock" | "black" })}>
            <option value="clock">a dim clock</option><option value="black">a black screen</option>
          </select></div>
      </div>

      <div class="wall-group">
        <label class="check"><input type="checkbox" checked={s.keepAwake} onChange={(e) => set("keepAwake", e.currentTarget.checked)} /><b>Keep the screen on</b></label>
        {s.keepAwake && wakeLock === "unsupported" && (
          <div class="muted" style={{ fontSize: 12.5 }}>This browser can't keep the screen on here. It needs HarborOS over https (<span class="mono">tailscale serve</span>), or set the tablet's own "stay awake" / kiosk browser option.</div>
        )}
        {s.keepAwake && wakeLock === "on" && <div class="muted" style={{ fontSize: 12.5 }}>On: the screen won't turn off while this page is open.</div>}
      </div>

      {isAdmin.value && <WeatherPlace />}
      {me.value?.role === "device" && <div class="dim" style={{ fontSize: 12.5 }}>These settings are saved for this tablet only.</div>}
    </Sheet>
  );
}

export function WeatherPlace() {
  const [q, setQ] = useState("");
  const [res, setRes] = useState<{ name: string; lat: number; lon: number }[]>([]);
  const [cur, setCur] = useState<string>("");
  useEffect(() => { api<any>("/api/weather").then((w) => setCur(w.place?.name ?? "")).catch(() => {}); }, []);
  useEffect(() => {
    if (q.trim().length < 2) { setRes([]); return; }
    const t = setTimeout(() => api<typeof res>(`/api/weather/search?q=${encodeURIComponent(q)}`).then(setRes).catch(() => {}), 300);
    return () => clearTimeout(t);
  }, [q]);
  return (
    <div class="wall-group">
      <b>Weather place</b>
      <div class="muted" style={{ fontSize: 12.5 }}>{cur ? `Now: ${cur}` : "Not set yet."} Shared by every screen.</div>
      <input class="input" placeholder="Search a city" value={q} onInput={(e) => setQ(e.currentTarget.value)} />
      {res.map((r) => (
        <button key={r.name + r.lat} class="btn" style={{ justifyContent: "flex-start" }}
          onClick={() => api("/api/weather/place", { method: "PUT", json: r }).then(() => { setCur(r.name); setQ(""); })}>{r.name}</button>
      ))}
    </div>
  );
}

// ---------- pairing ----------
export function Pair({ onDone, signIn }: { onDone: () => void; signIn: () => void }) {
  const [code, setCode] = useState(new URLSearchParams(location.search).get("pair") ?? "");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const go = async (c = code) => {
    setBusy(true); setErr("");
    try { await api("/api/devices/pair", { method: "POST", json: { code: c } }); history.replaceState(null, "", "/wall"); onDone(); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  useEffect(() => { if (code.length >= 6) go(code); }, []);
  return (
    <div class="wall"><div class="wall-msg" style={{ display: "grid", gap: 16, maxWidth: 420, textAlign: "center" }}>
      <Icon name="solar:tablet-linear" size={44} />
      <div style={{ fontSize: 24, fontWeight: 600 }}>Pair this tablet</div>
      <div class="muted">On a computer, open HarborOS → Settings → Tablets → Add tablet, then scan the QR code or type the code here.</div>
      <form onSubmit={(e) => { e.preventDefault(); go(); }} style={{ display: "flex", gap: 8 }}>
        <input class="input mono" style={{ height: 48, fontSize: 22, textAlign: "center", letterSpacing: "0.2em", textTransform: "uppercase" }} maxLength={6}
          value={code} placeholder="ABC123" onInput={(e) => setCode(e.currentTarget.value)} />
        <button class="btn primary wall-btn" disabled={busy || code.length < 6}>Pair</button>
      </form>
      {err && <div class="err-text">{err}</div>}
      <button class="btn" style={{ justifySelf: "center" }} onClick={signIn}>Sign in with an account instead</button>
    </div></div>
  );
}
