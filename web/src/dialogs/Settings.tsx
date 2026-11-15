import { useEffect, useState } from "preact/hooks";
import { settings, saveSettings, me, isAdmin, type Settings, type Me } from "../store";
import { api } from "../lib/ws";
import { Icon } from "../icons/Icon";
import { WeatherPlace } from "../wall/Wall";
import { ASCII_CREDIT } from "../shell/Background";

type Bg = { name: string; module: string };

export default function SettingsView() {
  return (
    <div class="home" style={{ maxWidth: 760 }}>
      <h1>Settings</h1>
      <div class="lede">{isAdmin.value ? "Stored on the server, shared by every device." : "Your account on this server."}</div>
      <Account />
      {isAdmin.value && <AdminSettings />}
    </div>
  );
}

// ---------------- account (everyone) ----------------
function Account() {
  const u = me.value!;
  const [name, setName] = useState(u.name);
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const [msg, setMsg] = useState<{ ok?: string; err?: string }>({});

  const saveName = async () => {
    if (!name.trim()) return setMsg({ err: "Enter a name." });
    try { me.value = await api<Me>("/api/me", { method: "PUT", json: { name } }); setMsg({ ok: "Name saved" }); }
    catch (e) { setMsg({ err: (e as Error).message }); }
  };
  const savePw = async () => {
    if (!cur) return setMsg({ err: "Enter your current password." });
    if (next.length < 8) return setMsg({ err: "Use at least 8 characters for the new password." });
    try { await api("/api/me/password", { method: "PUT", json: { current: cur, next } }); setCur(""); setNext(""); setMsg({ ok: "Password changed. Other devices were signed out." }); }
    catch (e) { setMsg({ err: (e as Error).message }); }
  };

  return (
    <>
      <div class="sec-title">Account</div>
      <div class="rows" style={{ padding: 16, display: "grid", gap: 16, gridTemplateColumns: "1fr 1fr" }}>
        <label class="field">Name<input class="input" value={name} onInput={(e) => { setName(e.currentTarget.value); setMsg({}); }} /></label>
        <label class="field">Email<input class="input" value={u.email} disabled /></label>
        <div style={{ gridColumn: "span 2" }}><button class="btn" onClick={saveName}>Save name</button></div>
        <label class="field">Current password<input class="input" type="password" autoComplete="current-password" value={cur} onInput={(e) => { setCur(e.currentTarget.value); setMsg({}); }} /></label>
        <label class="field">New password<input class="input" type="password" autoComplete="new-password" value={next} onInput={(e) => { setNext(e.currentTarget.value); setMsg({}); }} /></label>
        <div style={{ gridColumn: "span 2", display: "flex", gap: 12, alignItems: "center" }}>
          <button class="btn" onClick={savePw}>Change password</button>
          {msg.ok && <span class="muted">{msg.ok}</span>}
          {msg.err && <span class="err-text">{msg.err}</span>}
          <button class="btn" style={{ marginLeft: "auto" }} onClick={() => api("/api/logout", { method: "POST" }).then(() => location.reload())}>
            <Icon name="solar:logout-2-linear" size={15} />Sign out
          </button>
        </div>
      </div>
    </>
  );
}

// ---------------- users (admin) ----------------
function Users() {
  const [list, setList] = useState<Me[]>([]);
  const [err, setErr] = useState("");
  const load = () => api<Me[]>("/api/users").then(setList).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);
  const patch = async (u: Me, p: Partial<Me>) => { setErr(""); try { await api(`/api/users/${u.id}`, { method: "PATCH", json: p }); load(); } catch (e) { setErr((e as Error).message); } };
  const remove = async (u: Me) => {
    if (!confirm(`Delete ${u.name} (${u.email})? They'll be signed out everywhere.`)) return;
    setErr(""); try { await api(`/api/users/${u.id}`, { method: "DELETE" }); load(); } catch (e) { setErr((e as Error).message); }
  };
  const pending = list.filter((u) => u.status === "pending");
  const [codes, setCodes] = useState<Record<string, string>>({});
  const resetCode = async (u: Me) => {
    setErr("");
    try { const r = await api<{ code: string }>(`/api/users/${u.id}/reset`, { method: "POST" }); setCodes((c) => ({ ...c, [u.id]: r.code })); }
    catch (e) { setErr((e as Error).message); }
  };

  return (
    <>
      <div class="sec-title">Users {pending.length > 0 && <span class="tag" style={{ background: "#3a3210", color: "var(--warn)" }}>{pending.length} waiting</span>}</div>
      <div class="rows">
        {list.map((u) => (
          <div class="row" key={u.id}>
            <span class="avatar">{u.name.slice(0, 1).toUpperCase()}</span>
            <div class="grow" style={{ minWidth: 0 }}>
              <div>{u.name} {u.id === me.value?.id && <span class="dim">(you)</span>}</div>
              <div class="dim mono" style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis" }}>{u.email}</div>
              {codes[u.id] && (
                <div style={{ fontSize: 12.5, marginTop: 4, color: "var(--t2)" }}>
                  Reset code <span class="mono" style={{ color: "var(--t1)", userSelect: "all" }}>{codes[u.id]}</span>
                  <span class="dim"> · give it to {u.name.split(" ")[0]}; they use "Forgot password?" on the sign-in screen. Valid 15 minutes.</span>
                </div>
              )}
            </div>
            {u.status === "pending" ? (
              <>
                <button class="btn primary" onClick={() => patch(u, { status: "active" })}>Approve</button>
                <button class="btn danger" onClick={() => remove(u)}>Decline</button>
              </>
            ) : (
              <>
                <select class="input" style={{ width: 110, height: 28 }} value={u.role} onChange={(e) => patch(u, { role: e.currentTarget.value as Me["role"] })}>
                  <option value="admin">Admin</option><option value="member">Member</option>
                </select>
                <button class="btn" onClick={() => resetCode(u)} title="Make a one-time code they can use to set a new password">Reset password</button>
                <button class="iconbtn" aria-label={`Delete ${u.name}`} disabled={u.id === me.value?.id} onClick={() => remove(u)}>
                  <Icon name="solar:trash-bin-minimalistic-linear" size={15} />
                </button>
              </>
            )}
          </div>
        ))}
      </div>
      <div class="dim" style={{ fontSize: 12.5, marginTop: 8 }}>
        Members can see the dashboard and open apps. Admins can also use the terminal, Claude, container controls and settings.
      </div>
      {err && <div class="err-text" style={{ marginTop: 6 }}>{err}</div>}
    </>
  );
}

// ---------------- everything else (admin) ----------------
export function Credit() {
  return <span class="dim" style={{ fontSize: 12 }}>ASCII animals: <a href={ASCII_CREDIT.url} target="_blank" rel="noopener">{ASCII_CREDIT.name}</a> (MIT)</span>;
}

function BgPicker({ list, value, onChange, extra }: { list: Bg[]; value: string; onChange: (m: string) => void; extra?: Bg[] }) {
  const all = [...(extra ?? []), ...list];
  const known = all.some((b) => b.module === value);
  return (
    <>
      <select class="input" value={known ? value : "__custom"} onChange={(e) => e.currentTarget.value !== "__custom" && onChange(e.currentTarget.value)}>
        {all.map((b) => <option key={b.module} value={b.module}>{b.name}</option>)}
        <option value="__custom">Custom URL…</option>
      </select>
      {!known && <input class="input" placeholder="/user-backgrounds/my-scene/index.js or an image/video URL" value={value} onInput={(e) => onChange(e.currentTarget.value)} />}
      {value.startsWith("ascii:") && <Credit />}
    </>
  );
}

function AdminSettings() {
  const s = settings.value;
  const [f, setF] = useState<Settings | null>(s);
  const [haToken, setHaToken] = useState("");
  const [saved, setSaved] = useState("");
  const [err, setErr] = useState("");
  const [bgList, setBgList] = useState<Bg[]>([]);
  useEffect(() => { setF(s); }, [s]);
  useEffect(() => { api<Bg[]>("/api/backgrounds").then(setBgList).catch(() => setBgList([{ name: "None", module: "none" }])); }, []);
  if (!f) return null;
  const set = (p: Partial<Settings>) => { setF({ ...f, ...p }); setSaved(""); setErr(""); };
  const setBg = (p: Partial<Settings["background"]>) => set({ background: { ...f.background, ...p } });
  const setLbg = (p: Partial<Settings["loginBackground"]>) => set({ loginBackground: { ...f.loginBackground, ...p } });
  const aura = [{ name: "Aura (default glow)", module: "aura" }];

  const save = async () => {
    if (!(f.pricePerKwh >= 0)) return setErr("Price per kWh must be a number.");
    try { await saveSettings({ ...f, ...(haToken ? { haToken } as any : {}) }); setHaToken(""); setSaved("Saved"); }
    catch (e) { setErr((e as Error).message); }
  };

  return (
    <>
      <Users />
      <Tablets />

      <div class="sec-title">Sign-in screen</div>
      <div class="rows" style={{ padding: 16, display: "grid", gap: 16 }}>
        <label class="check"><input type="checkbox" checked={f.allowSignup} onChange={(e) => set({ allowSignup: e.currentTarget.checked })} />
          Show "Sign up" on the sign-in screen (new accounts wait for your approval)</label>
        <label class="field">Background<BgPicker list={bgList} extra={aura} value={f.loginBackground.module} onChange={(m) => setLbg({ module: m })} /></label>
        <label class="field">Dim {Math.round(f.loginBackground.dim * 100)}%<input type="range" min={0} max={0.9} step={0.05} value={f.loginBackground.dim} onInput={(e) => setLbg({ dim: Number(e.currentTarget.value) })} /></label>
        <label class="field">Blur {f.loginBackground.blur}px<input type="range" min={0} max={20} step={1} value={f.loginBackground.blur} onInput={(e) => setLbg({ blur: Number(e.currentTarget.value) })} /></label>
      </div>

      <MusicSettings f={f} set={set} />

      <div class="sec-title">Appearance</div>
      <div class="rows" style={{ padding: 16, display: "grid", gap: 16 }}>
        <label class="field">Accent color
          <div style={{ display: "flex", gap: 8 }}>
            <input type="color" value={f.accent} onInput={(e) => set({ accent: e.currentTarget.value })} style={{ width: 44, height: 34, border: 0, background: "none" }} />
            {["#7B7BF0", "#3F3DB8", "#F3E9DC", "#2EE6C5", "#4CB782"].map((c) => (
              <button key={c} aria-label={c} onClick={() => set({ accent: c })} style={{ width: 28, height: 28, border: "1px solid var(--line-2)", background: c, cursor: "pointer" }} />
            ))}
          </div>
        </label>
        <label class="field">Desktop background<BgPicker list={bgList} extra={aura} value={f.background.module} onChange={(m) => setBg({ module: m })} /></label>
        <label class="field">Dim {Math.round(f.background.dim * 100)}%<input type="range" min={0} max={0.9} step={0.05} value={f.background.dim} onInput={(e) => setBg({ dim: Number(e.currentTarget.value) })} /></label>
        <label class="field">Blur {f.background.blur}px<input type="range" min={0} max={20} step={1} value={f.background.blur} onInput={(e) => setBg({ blur: Number(e.currentTarget.value) })} /></label>
        <label class="check"><input type="checkbox" checked={f.background.pauseHidden} onChange={(e) => setBg({ pauseHidden: e.currentTarget.checked })} />Pause animation when the tab is hidden</label>
        <label class="check"><input type="checkbox" checked={f.background.pauseWhenApp} onChange={(e) => setBg({ pauseWhenApp: e.currentTarget.checked })} />Pause animation while an app is open</label>
      </div>

      <div class="sec-title">Power</div>
      <div class="rows" style={{ padding: 16, display: "grid", gap: 16, gridTemplateColumns: "1fr 1fr" }}>
        <label class="field">Price per kWh<input class="input mono" type="number" step="0.01" value={f.pricePerKwh} onInput={(e) => set({ pricePerKwh: Number(e.currentTarget.value) })} /></label>
        <label class="field">Currency<input class="input" value={f.currency} onInput={(e) => set({ currency: e.currentTarget.value })} /></label>
        <label class="field" style={{ gridColumn: "span 2" }}>Baseline watts (board, disks, fans, PSU loss; added to CPU package power)
          <input class="input mono" type="number" value={f.baselineWatts} onInput={(e) => set({ baselineWatts: Number(e.currentTarget.value) })} /></label>
        <div class="dim" style={{ gridColumn: "span 2", fontSize: 12.5 }}>Optional: read a smart plug through Home Assistant instead of estimating.</div>
        <label class="field">Home Assistant URL<input class="input" placeholder="http://100.64.0.7:8123" value={f.haUrl ?? ""} onInput={(e) => set({ haUrl: e.currentTarget.value })} /></label>
        <label class="field">Plug entity<input class="input mono" placeholder="sensor.server_plug_power" value={f.plugEntity ?? ""} onInput={(e) => set({ plugEntity: e.currentTarget.value })} /></label>
        <label class="field" style={{ gridColumn: "span 2" }}>Long-lived access token {f.hasHaToken && <span class="dim">(saved; leave empty to keep)</span>}
          <input class="input" type="password" value={haToken} onInput={(e) => setHaToken(e.currentTarget.value)} /></label>
      </div>

      <div class="sec-title">Memory</div>
      <div class="rows" style={{ padding: 16 }}>
        <label class="field">Unload apps not viewed for (minutes)
          <input class="input mono" type="number" min={1} value={f.unmountAfterMinutes} onInput={(e) => set({ unmountAfterMinutes: Number(e.currentTarget.value) })} /></label>
      </div>

      <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 20 }}>
        <button class="btn primary" onClick={save}>Save settings</button>
        {saved && <span class="muted">{saved}</span>}
        {err && <span class="err-text">{err}</span>}
      </div>
    </>
  );
}

// ---------------- tablets (wall screens) ----------------
interface Device { id: string; name: string; created: number; lastSeen: number | null }
function Tablets() {
  const [list, setList] = useState<Device[]>([]);
  const [name, setName] = useState("");
  const [pair, setPair] = useState<{ code: string; url: string | null; qr: string | null; expires: number } | null>(null);
  const load = () => api<Device[]>("/api/devices").then(setList).catch(() => {});
  useEffect(() => { load(); }, []);
  // Refresh while a code is showing, so the new tablet appears once it pairs.
  useEffect(() => { if (!pair) return; const t = setInterval(load, 3000); return () => clearInterval(t); }, [pair]);
  const make = async () => setPair(await api("/api/devices/pair-code", { method: "POST", json: { name: name || "Wall tablet", origin: location.origin } }));
  const ago = (t: number | null) => { if (!t) return "never"; const m = Math.round((Date.now() - t) / 60000); return m < 2 ? "online" : m < 60 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`; };
  return (
    <>
      <div class="sec-title">Tablets</div>
      <div class="rows">
        <div class="row muted" style={{ fontSize: 13 }}>
          <Icon name="solar:tablet-linear" />
          <span class="grow">A tablet on the wall shows <a href="/wall" target="_blank" class="mono">/wall</a>: big touch tiles, night dimming and burn-in protection. Paired tablets can only see the wall and open apps.</span>
        </div>
        {list.map((d) => (
          <div key={d.id} class="row">
            <Icon name="solar:tablet-linear" />
            <span class="grow">{d.name}</span>
            <span class="dim" style={{ fontSize: 12.5 }}>{ago(d.lastSeen)}</span>
            <button class="btn danger" onClick={() => api(`/api/devices/${d.id}`, { method: "DELETE" }).then(load)}>Remove</button>
          </div>
        ))}
        {!pair ? (
          <div class="row" style={{ gap: 8 }}>
            <input class="input" style={{ maxWidth: 240 }} placeholder="Kitchen tablet" value={name} onInput={(e) => setName(e.currentTarget.value)} />
            <button class="btn primary" onClick={make}><Icon name="solar:qr-code-linear" size={15} />Add tablet</button>
          </div>
        ) : (
          <div class="row" style={{ alignItems: "flex-start", gap: 20, padding: 16, flexWrap: "wrap" }}>
            {pair.qr && <div style={{ width: 168, height: 168, background: "#fff", padding: 8 }} dangerouslySetInnerHTML={{ __html: pair.qr }} />}
            <div style={{ display: "grid", gap: 8, flex: 1, minWidth: 220 }}>
              <div>Scan with the tablet's camera, or open <span class="mono">{location.origin}/wall</span> on it and type:</div>
              <div class="mono" style={{ fontSize: 30, letterSpacing: "0.2em" }}>{pair.code}</div>
              <div class="dim" style={{ fontSize: 12.5 }}>Works once, for 10 minutes.</div>
              <button class="btn" style={{ justifySelf: "start" }} onClick={() => { setPair(null); setName(""); }}>Done</button>
            </div>
          </div>
        )}
      </div>
      <div class="rows" style={{ padding: 16, marginTop: 10 }}><WeatherPlace /></div>
    </>
  );
}

// ---------------- music ----------------
function MusicSettings({ f, set }: { f: Settings; set: (p: Partial<Settings>) => void }) {
  const m = { navidromeUrl: "", navidromeUser: "", ...(f.music ?? {}) };
  const setM = (p: Partial<typeof m>) => set({ music: { ...m, ...p } });
  const [test, setTest] = useState("");
  return (
    <>
      <div class="sec-title">Music</div>
      <div class="rows" style={{ padding: 16, display: "grid", gap: 16 }}>
        <div class="muted" style={{ fontSize: 13 }}>DJ mode on wall tablets plays your Navidrome library on the tablet.</div>
        <label class="field">Navidrome address<input class="input mono" placeholder="http://navidrome:4533" value={m.navidromeUrl} onChange={(e) => setM({ navidromeUrl: e.currentTarget.value.trim() })} /></label>
        <label class="field">User<input class="input" value={m.navidromeUser} onChange={(e) => setM({ navidromeUser: e.currentTarget.value.trim() })} /></label>
        <label class="field">Password<input class="input" type="password" placeholder={f.hasMusicPass ? "Saved. Type to replace it." : ""} onChange={(e) => setM({ navidromePass: e.currentTarget.value })} /></label>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button class="btn" type="button" onClick={() => { setTest("Checking… (save first if you changed anything)"); api("/api/music/test").then(() => setTest("Connected.")).catch((e) => setTest((e as Error).message)); }}>Test connection</button>
          <span class="dim" style={{ fontSize: 13 }}>{test}</span>
        </div>
      </div>
    </>
  );
}
