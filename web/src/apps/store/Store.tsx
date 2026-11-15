// App store: CasaOS catalog, sorted by Docker Hub pulls. Installing renders a
// compose file for this host on the server and runs it over SSH; progress
// arrives on the live channel ("store" topic).
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { api, live } from "../../lib/ws";
import { navigate } from "../../store";
import { Icon } from "../../icons/Icon";
import type { StoreApp, StoreInstall, StoreJob } from "../../../../server/src/protocol";

interface Payload { updated: number; source?: string; refreshing: boolean; apps: StoreApp[]; installed: StoreInstall[]; jobs: (StoreJob & { lines: string[] })[] }
type Job = StoreJob & { lines: string[] };

const compact = (n?: number) => n == null ? "–" : n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${Math.round(n / 1e6)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n);
const memText = (mb?: number) => mb == null ? null : mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`;
/** Catalog tips are markdown; show them as plain text. */
const plain = (md: string) => md.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)").replace(/^#+\s*/gm, "").replace(/\s*#{2,}\s*/g, "\n").replace(/[*_`]{1,2}/g, "");
const ago = (t: number) => { const d = (Date.now() - t) / 864e5; return d < 1 ? "today" : d < 2 ? "yesterday" : `${Math.floor(d)} days ago`; };

export default function Store() {
  const [data, setData] = useState<Payload | null>(null);
  const [jobs, setJobs] = useState<Record<string, Job>>({});
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("Popular");
  const [open, setOpen] = useState<StoreApp | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const load = () => api<Payload>("/api/store").then((d) => {
    setData(d);
    setJobs((j) => ({ ...Object.fromEntries(d.jobs.map((x) => [x.project, x])), ...j }));
    return d;
  }).catch((e) => setErr(e.message));

  useEffect(() => { load(); }, []);
  // First visit fetches the catalog in the background; poll until it's there.
  useEffect(() => {
    if (!data?.refreshing) return;
    const t = setInterval(() => load().then((d) => d && !d.refreshing && clearInterval(t)), 2500);
    return () => clearInterval(t);
  }, [data?.refreshing]);
  useEffect(() => live.on((m) => {
    if (m.t !== "store") return;
    setJobs((all) => {
      const prev = all[m.d.project];
      const lines = prev && prev.op === m.d.op && prev.phase === "running" ? [...prev.lines] : [];
      if (m.d.line) lines.push(m.d.line);
      return { ...all, [m.d.project]: { ...m.d, lines: lines.slice(-300) } };
    });
    if (m.d.phase !== "running") load();
  }), []);

  const refresh = async () => { setBusy(true); setErr(""); try { await api("/api/store/refresh", { method: "POST" }); await load(); } catch (e) { setErr((e as Error).message); } setBusy(false); };

  const apps = data?.apps ?? [];
  const installedBy = useMemo(() => {
    const m = new Map<string, StoreInstall[]>();
    for (const i of data?.installed ?? []) m.set(i.app, [...(m.get(i.app) ?? []), i]);
    return m;
  }, [data]);
  const cats = useMemo(() => [...new Set(apps.map((a) => a.category))].sort(), [apps]);
  const popular = useMemo(() => [...apps].filter((a) => a.pulls).sort((a, b) => b.pulls! - a.pulls!), [apps]);
  // Top row: the most-pulled app of each category, so it isn't four databases.
  const heroes = useMemo(() => { const seen = new Set<string>(); return popular.filter((a) => !seen.has(a.category) && seen.add(a.category)).slice(0, 4); }, [popular]);
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    let l = cat === "Popular" ? [...apps].sort((a, b) => (b.pulls ?? 0) - (a.pulls ?? 0))
      : cat === "Installed" ? apps.filter((a) => installedBy.has(a.id))
      : apps.filter((a) => a.category === cat);
    if (s) l = apps.filter((a) => `${a.title} ${a.tagline} ${a.category} ${a.image}`.toLowerCase().includes(s));
    return l;
  }, [apps, q, cat, installedBy]);

  const running = Object.values(jobs).filter((j) => j.phase === "running");

  return (
    <div class="home store">
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
        <div style={{ flex: 1 }}>
          <h1>Store</h1>
          <div class="lede">
            {!data ? "Loading…" : data.refreshing && !apps.length ? "Fetching the catalog for the first time. This takes about 20 seconds."
              : <><b>{apps.length}</b> apps from the CasaOS catalog, sorted by Docker Hub downloads. Updated {ago(data.updated)}.</>}
          </div>
        </div>
        <button class="btn" onClick={refresh} disabled={busy || data?.refreshing}>
          <Icon name="solar:refresh-linear" size={15} class={busy || data?.refreshing ? "rot" : undefined} />{busy || data?.refreshing ? "Updating…" : "Update catalog"}
        </button>
      </div>
      {err && <div class="err-text" style={{ marginBottom: 12 }}>{err}</div>}

      {running.map((j) => <JobRow key={j.project} j={j} />)}

      {!q && cat === "Popular" && popular.length > 0 && (
        <div class="grid store-top">
          {heroes.map((a) => (
            <button key={a.id} class="tile s st-hero" onClick={() => setOpen(a)}>
              <div class="k"><img src={a.icon} width={18} height={18} alt="" />{a.title}</div>
              <div class="big" style={{ fontSize: 34, margin: "10px 0 4px" }}>{compact(a.pulls)}<small> pulls</small></div>
              <div class="k">{a.category}{installedBy.has(a.id) && <span class="ok-dot">Installed</span>}</div>
            </button>
          ))}
        </div>
      )}

      <div class="st-bar">
        <div class="st-search">
          <Icon name="solar:magnifier-linear" size={15} />
          <input value={q} onInput={(e) => setQ(e.currentTarget.value)} placeholder="Search apps" aria-label="Search apps" />
        </div>
        <div class="st-tabs" role="tablist">
          {["Popular", ...cats, "Installed"].map((c) => (
            <button key={c} role="tab" aria-selected={cat === c} class={cat === c ? "on" : ""} onClick={() => { setCat(c); setQ(""); }}>
              {c}{c === "Installed" && data?.installed.length ? <span class="dim"> {data.installed.length}</span> : null}
            </button>
          ))}
        </div>
      </div>

      <div class="st-grid">
        {list.map((a) => <Card key={a.id} a={a} installed={installedBy.has(a.id)} onOpen={() => setOpen(a)} />)}
        {data && !list.length && <div class="muted" style={{ padding: "24px 0" }}>{q ? `No apps match "${q}".` : cat === "Installed" ? "Apps you install from the store show up here." : "Nothing here."}</div>}
      </div>

      {open && <Detail a={open} installs={installedBy.get(open.id) ?? []} jobs={jobs} onClose={() => setOpen(null)} />}
    </div>
  );
}

function Card({ a, installed, onOpen }: { a: StoreApp; installed: boolean; onOpen: () => void }) {
  return (
    <button class="st-card" onClick={onOpen}>
      <img class="st-icon" src={a.icon} width={36} height={36} alt="" loading="lazy" />
      <div class="st-body">
        <div class="st-title">{a.title}{installed && <span class="ok-dot">Installed</span>}</div>
        <div class="st-tag">{a.tagline || a.category}</div>
        <div class="st-meta mono">
          <span><Icon name="solar:download-minimalistic-linear" size={12} />{compact(a.pulls)}</span>
          {a.memMB != null && <span>{memText(a.memMB)}</span>}
          {a.services > 1 && <span>{a.services} containers</span>}
        </div>
      </div>
    </button>
  );
}

function JobRow({ j }: { j: Job }) {
  return (
    <div class="rows" style={{ marginBottom: 12 }}>
      <div class="row">
        <span class="spin" style={{ borderColor: "var(--line-2)", borderTopColor: "var(--acc)" }} />
        <b style={{ fontWeight: 500 }}>{j.op === "install" ? "Installing" : "Removing"} {j.project}</b>
        <span class="muted grow mono" style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{j.lines[j.lines.length - 1]}</span>
      </div>
    </div>
  );
}

// ---------------- detail + install panel ----------------

interface Form { project: string; ports: Record<string, number>; dataRoot: string; mediaRoot: string; sleep: boolean; acceptRisk: boolean }
interface Preview { yaml: string; notes: string[]; risks: string[]; mounts: string[]; usesMedia: boolean }

function Detail({ a, installs, jobs, onClose }: { a: StoreApp; installs: StoreInstall[]; jobs: Record<string, Job>; onClose: () => void }) {
  const [f, setF] = useState<Form | null>(null);
  const [pv, setPv] = useState<Preview | null>(null);
  const [showYaml, setShowYaml] = useState(false);
  const [more, setMore] = useState(false);
  const [err, setErr] = useState("");
  const [project, setProject] = useState<string | null>(null); // job we started
  const [removeData, setRemoveData] = useState(false);
  const [confirmRm, setConfirmRm] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api<Omit<Form, "sleep" | "acceptRisk">>(`/api/store/apps/${encodeURIComponent(a.id)}/defaults`)
      .then((d) => setF({ ...d, sleep: true, acceptRisk: false })).catch((e) => setErr(e.message));
  }, [a.id]);
  // Re-render the compose preview whenever the form changes (debounced).
  useEffect(() => {
    if (!f) return;
    const t = setTimeout(() => api<Preview>(`/api/store/apps/${encodeURIComponent(a.id)}/preview`, { method: "POST", json: { ...f, host: location.hostname } }).then(setPv).catch(() => {}), 250);
    return () => clearTimeout(t);
  }, [f]);
  const job = project ? jobs[project] : undefined;
  useEffect(() => { logRef.current?.scrollTo({ top: 1e9 }); }, [job?.lines.length]);
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === "Escape" && onClose(); addEventListener("keydown", k); return () => removeEventListener("keydown", k); }, []);

  const install = async () => {
    if (!f) return;
    setErr("");
    try {
      const r = await api<{ project: string }>(`/api/store/apps/${encodeURIComponent(a.id)}/install`, { method: "POST", json: { ...f, host: location.hostname } });
      setProject(r.project);
    } catch (e) { setErr((e as Error).message); }
  };
  const uninstall = async (p: string) => {
    setErr("");
    try { await api(`/api/store/installed/${encodeURIComponent(p)}/uninstall`, { method: "POST", json: { removeData } }); setProject(p); setConfirmRm(null); }
    catch (e) { setErr((e as Error).message); }
  };

  const set = (p: Partial<Form>) => setF((x) => x && { ...x, ...p });
  const portsShown = a.ports.filter((p) => p.published);

  return (
    <div class="scrim st-scrim" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside class="st-panel" role="dialog" aria-label={a.title}>
        <header>
          <img src={a.icon} width={40} height={40} alt="" />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 16, fontWeight: 600 }}>{a.title}</div>
            <div class="k">{a.category}{a.author && ` · ${a.author}`}</div>
          </div>
          <button class="iconbtn" style={{ marginLeft: "auto" }} aria-label="Close" onClick={onClose}><Icon name="solar:close-circle-linear" /></button>
        </header>

        <div class="st-scroll">
          <div class="st-stats">
            <div><div class="k">Pulls</div><div class="big">{compact(a.pulls)}</div></div>
            <div><div class="k">Memory</div><div class="big">{memText(a.memMB) ?? "–"}</div></div>
            <div><div class="k">Containers</div><div class="big">{a.services}</div></div>
          </div>

          {a.tagline && <p class="st-lead">{a.tagline}</p>}
          {a.description && (
            <p class={`st-desc ${more ? "" : "clamp"}`} onClick={() => setMore(true)}>{a.description}</p>
          )}
          <div class="k mono" style={{ wordBreak: "break-all" }}>{a.image}</div>

          {installs.length > 0 && (
            <>
              <div class="st-h">Installed</div>
              <div class="rows">
                {installs.map((i) => (
                  <div key={i.project} class="row" style={{ flexWrap: "wrap" }}>
                    <span class="mono grow">{i.project}</span>
                    <button class="btn" onClick={() => { navigate(i.appId); onClose(); }}><Icon name="solar:arrow-right-up-linear" size={14} />Open</button>
                    {confirmRm === i.project ? (
                      <>
                        <label class="check" style={{ fontSize: 12.5, width: "100%" }}><input type="checkbox" checked={removeData} onChange={(e) => setRemoveData(e.currentTarget.checked)} />Also delete its data in {i.dataRoot}/{i.project}. This can't be undone.</label>
                        <button class="btn" onClick={() => setConfirmRm(null)}>Cancel</button>
                        <button class="btn danger" onClick={() => uninstall(i.project)}>Uninstall</button>
                      </>
                    ) : <button class="btn danger" onClick={() => { setConfirmRm(i.project); setRemoveData(false); }}>Uninstall</button>}
                  </div>
                ))}
              </div>
            </>
          )}

          {job ? (
            <>
              <div class="st-h">{job.op === "install" ? "Installing" : "Removing"} <span class="mono dim" style={{ fontWeight: 400 }}>{job.project}</span></div>
              {job.phase === "running" && <div class="boot-bar" style={{ marginTop: 0 }}><i /></div>}
              <div ref={logRef} class="st-log mono">{job.lines.map((l, i) => <div key={i}>{l}</div>)}</div>
              {job.phase === "done" && job.op === "install" && <button class="btn primary" style={{ justifySelf: "start" }} onClick={() => { navigate(job.project); onClose(); }}>Open {a.title}</button>}
              {job.phase === "error" && <div class="err-text">Failed. The log above has docker compose's output.</div>}
            </>
          ) : f && (
            <>
              <div class="st-h">{installs.length ? "Install another copy" : "Install"}</div>
              {a.tips && <div class={`st-note st-desc ${more ? "" : "clamp"}`} onClick={() => setMore(true)}>{plain(a.tips)}</div>}
              <label class="field">Stack name
                <input class="input mono" value={f.project} onInput={(e) => set({ project: e.currentTarget.value.toLowerCase() })} />
              </label>
              {portsShown.length > 0 && (
                <div class="field" style={{ display: "grid", gap: 8, fontSize: 12, color: "var(--t3)" }}>Ports
                  <div class="rows">
                    {portsShown.map((p) => {
                      const key = `${p.service}:${p.target}/${p.protocol}`;
                      return (
                        <div key={key} class="row" style={{ minHeight: 36 }}>
                          <span class="grow" style={{ color: "var(--t2)" }}>{p.description || `${p.service} ${p.target}/${p.protocol}`}{p.published === a.webPort && <span class="tag" style={{ marginLeft: 8 }}>web</span>}</span>
                          <input class="input mono" style={{ width: 84, height: 28 }} inputMode="numeric" value={f.ports[key] ?? ""}
                            onInput={(e) => set({ ports: { ...f.ports, [key]: Number(e.currentTarget.value) || 0 } })} aria-label={`Host port for ${p.target}`} />
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
              <label class="field">App data folder
                <input class="input mono" value={f.dataRoot} onInput={(e) => set({ dataRoot: e.currentTarget.value })} />
              </label>
              {pv?.usesMedia && (
                <label class="field">Media folder <span class="dim">(replaces /DATA in the catalog)</span>
                  <input class="input mono" value={f.mediaRoot} onInput={(e) => set({ mediaRoot: e.currentTarget.value })} />
                </label>
              )}
              <label class="check"><input type="checkbox" checked={f.sleep} onChange={(e) => set({ sleep: e.currentTarget.checked })} />
                <span>Sleep when idle <span class="dim">· stops after 30 min unused, starts when you open it</span></span>
              </label>

              {pv && pv.notes.length > 0 && <div class="st-note">{pv.notes.map((n) => <div key={n}>{n}</div>)}</div>}
              {pv && pv.risks.length > 0 && (
                <div class="st-risk">
                  <div style={{ display: "flex", gap: 8, alignItems: "center", fontWeight: 500 }}><Icon name="solar:danger-triangle-linear" size={16} />Needs elevated access</div>
                  {pv.risks.map((r) => <div key={r}>{r}</div>)}
                  <label class="check" style={{ color: "inherit", marginTop: 4 }}><input type="checkbox" checked={f.acceptRisk} onChange={(e) => set({ acceptRisk: e.currentTarget.checked })} />I trust this app with that access</label>
                </div>
              )}

              {showYaml && pv && <pre class="st-yaml mono">{pv.yaml}</pre>}
              {err && <div class="err-text">{err}</div>}
            </>
          )}
        </div>

        {!job && f && (
          <footer>
            <button class="btn" onClick={() => setShowYaml(!showYaml)}><Icon name="solar:code-linear" size={14} />{showYaml ? "Hide compose" : "View compose"}</button>
            <button class="btn primary" style={{ marginLeft: "auto" }} onClick={install} disabled={!!pv?.risks.length && !f.acceptRisk}>Install</button>
          </footer>
        )}
        {job && job.phase !== "running" && <footer><button class="btn" style={{ marginLeft: "auto" }} onClick={() => setProject(null)}>Back</button></footer>}
      </aside>
    </div>
  );
}
