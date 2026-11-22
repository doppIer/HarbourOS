import { signal, computed } from "@preact/signals";
import type { AppConfig, AppStatus, BootEvent, ContainerInfo, Stats } from "../../../server/src/protocol";
import { live, api } from "../lib/ws";

export type App = AppConfig & { status: AppStatus };
export interface Settings {
  music?: { navidromeUrl: string; navidromeUser: string; navidromePass?: string };
  hasMusicPass?: boolean;
  accent: string; pricePerKwh: number; currency: string; baselineWatts: number;
  plugEntity?: string; haUrl?: string; hasHaToken: boolean;
  background: { module: string; dim: number; blur: number; pauseHidden: boolean; pauseWhenApp: boolean };
  unmountAfterMinutes: number; sidebarCollapsed: boolean;
  allowSignup: boolean; loginBackground: { module: string; dim: number; blur: number };
}

export interface Me { id: string; email: string; name: string; role: "admin" | "member" | "device"; status: string; created: number }
export const me = signal<Me | null>(null);
export const isAdmin = computed(() => me.value?.role === "admin");

export const stats = signal<Stats | null>(null);
export const containers = signal<ContainerInfo[]>([]);
export const apps = signal<App[]>([]);
export const boots = signal<Record<string, BootEvent & { lines: string[] }>>({});
export const settings = signal<Settings | null>(null);

/** "home" | "terminal" | "ai" | "store" | "settings" | app id */
export const view = signal<string>(location.hash.slice(1) || "home");
export const sidebarOpen = signal(false); // mobile drawer
export const dialog = signal<null | { kind: "discover" } | { kind: "add-app"; app?: App } | { kind: "logs"; container: string }>(null);

export const currentApp = computed(() => apps.value.find((a) => a.id === view.value) ?? null);

// Rolling history for charts (fed by the live channel, capped).
export const history = { cpu: [] as number[], mem: [] as number[], rx: [] as number[], tx: [] as number[], watts: [] as number[], temp: [] as number[] };
const CAP = 900; // 30 min at 2 s
const push = (a: number[], v: number) => { a.push(v); if (a.length > CAP) a.shift(); };

live.on((m) => {
  if (m.t === "stats") {
    stats.value = m.d;
    push(history.cpu, m.d.cpu.total);
    push(history.mem, (m.d.mem.used / m.d.mem.total) * 100);
    push(history.rx, m.d.net.rx);
    push(history.tx, m.d.net.tx);
    push(history.watts, m.d.power.watts);
    if (m.d.cpu.temp != null) push(history.temp, m.d.cpu.temp);
  } else if (m.t === "containers") containers.value = m.d;
  else if (m.t === "apps") apps.value = m.d;
  else if (m.t === "boot") {
    const prev = boots.value[m.d.app];
    const lines = m.d.phase === "starting" && !prev ? [] : [...(prev?.lines ?? [])];
    if (m.d.line && lines[lines.length - 1] !== m.d.line) lines.push(m.d.line);
    boots.value = { ...boots.value, [m.d.app]: { ...m.d, lines: lines.slice(-30) } };
  }
});

/** Apps that open in their own tab: the ones that refuse iframes, and plain-http apps
 *  while HarbourOS itself is on https (browsers block http pages inside https ones). */
export const opensInTab = (a: App) =>
  a.openMode === "tab" || (location.protocol === "https:" && (/^http:/i.test(a.url) || !!(a.stripFrameHeaders && a.framePort)));

export function navigate(v: string) {
  const tab = apps.value.find((a) => a.id === v && opensInTab(a));
  if (tab) { // the app refuses iframes: start it if needed and open it next to HarbourOS
    window.open(tab.url, "_blank", "noopener");
    if (tab.status !== "running" && tab.status !== "link") fetch(`/api/apps/${tab.id}/open`, { method: "POST" }).catch(() => {});
    sidebarOpen.value = false;
    return;
  }
  view.value = v;
  location.hash = v === "home" ? "" : v;
  sidebarOpen.value = false;
  const app = apps.value.find((a) => a.id === v);
  live.setViewing(app ? app.id : null);
}
window.addEventListener("hashchange", () => { const v = location.hash.slice(1) || "home"; if (v !== view.value) navigate(v); });

export async function loadSettings() { settings.value = await api<Settings>("/api/settings"); applyAccent(); }
export async function saveSettings(patch: Partial<Settings>) {
  settings.value = await api<Settings>("/api/settings", { method: "PUT", json: patch }); applyAccent();
}
/** Per-device look: UI scale and sidebar width (a tablet and a desktop want different ones). */
export interface UiPrefs { scale: number; sidebarWidth: number }
const uiKey = "harbor.ui";
const readUi = (): UiPrefs => { try { return { scale: 1, sidebarWidth: 232, ...JSON.parse(localStorage.getItem(uiKey) ?? "{}") }; } catch { return { scale: 1, sidebarWidth: 232 }; } };
export const uiPrefs = signal<UiPrefs>(readUi());
export const SIDEBAR_MIN = 180, SIDEBAR_MAX = 420;
export function setUiPrefs(p: Partial<UiPrefs>) {
  const n = { ...uiPrefs.value, ...p };
  n.scale = Math.min(1.5, Math.max(0.7, n.scale));
  n.sidebarWidth = Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, n.sidebarWidth)));
  uiPrefs.value = n;
  try { localStorage.setItem(uiKey, JSON.stringify(n)); } catch {}
  applyUi();
}
export function applyUi() {
  const r = document.documentElement.style;
  r.setProperty("zoom", uiPrefs.value.scale === 1 ? "" : String(uiPrefs.value.scale));
  r.setProperty("--sb-w", `${uiPrefs.value.sidebarWidth}px`);
}
applyUi();

/** Drag data type for a container dragged from the dashboard onto the sidebar. */
export const CONTAINER_DRAG = "application/x-harbor-container";

/** Make a sidebar app out of a container (its first published web port) and open it. */
export async function appFromContainer(name: string) {
  const c = containers.value.find((x) => x.name === name);
  if (!c) return;
  const existing = apps.value.find((a) => a.containers.includes(name));
  if (existing) { if (!existing.pinned) await api(`/api/apps/${existing.id}`, { method: "PUT", json: { pinned: true } }); return navigate(existing.id); }
  const port = (c.ports ?? []).find((p) => p.type === "tcp");
  const host = location.hostname.includes(":") ? `[${location.hostname}]` : location.hostname;
  let url = port ? `${[443, 8443, 9443].includes(port.private) ? "https" : "http"}://${host}:${port.public}` : "";
  if (!url) {
    url = prompt(`${name} doesn't publish a port. Which address opens it?`, `http://${host}:`) ?? "";
    if (!/^https?:\/\/.+/.test(url)) return;
  }
  const label = name.replace(/[-_](app|server|web|ui)$/i, "").replace(/[-_]+/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase());
  const a = await api<App>("/api/apps/new", { method: "PUT", json: {
    name: label, url, containers: [name], section: "Apps", pinned: true, startOnDemand: true, idleStopMinutes: 0,
  } });
  apps.value = [...apps.value.filter((x) => x.id !== a.id), { ...a, status: c.state === "running" ? "running" : "stopped" }];
  navigate(a.id);
}

function applyAccent() { if (settings.value) document.documentElement.style.setProperty("--acc", settings.value.accent); }

// ---------- self-update (admins) ----------
export interface UpdateStatus {
  current: string; latest: { version: string; notes: string; url: string; publishedAt: string } | null;
  available: boolean; checkedAt: number; error?: string; canApply: boolean; applyHint?: string;
  job: { state: "idle" | "running" | "restarting" | "failed"; step: string; log: string[]; error?: string; target?: string };
}
export const update = signal<UpdateStatus | null>(null);
/** The server went away mid-update (it is being replaced): keep the card in "restarting". */
export const updateLost = signal(false);
let updTimer: ReturnType<typeof setTimeout> | undefined;
export async function loadUpdate(force = false) {
  clearTimeout(updTimer);
  try {
    const before = update.value;
    const u = await api<UpdateStatus>(`/api/update${force ? "?force=1" : ""}`);
    const wasBusy = updateLost.value || before?.job.state === "running" || before?.job.state === "restarting";
    update.value = u; updateLost.value = false;
    if (wasBusy && u.job.state === "idle" && before && u.current !== before.current) { location.reload(); return; } // new version is up
  } catch { if (update.value && update.value.job.state !== "idle") updateLost.value = true; }
  const busy = updateLost.value || update.value?.job.state === "running" || update.value?.job.state === "restarting";
  updTimer = setTimeout(() => loadUpdate(), busy ? 1500 : 3600_000);
}
export async function applyUpdate() { await api("/api/update/apply", { method: "POST" }); await loadUpdate(); }
