// Files: browse, view and edit files on the server. All operations go
// through /api/files, which runs them on the host as the terminal user.
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { api } from "../../lib/ws";
import { Icon } from "../../icons/Icon";
import { menuHandlers } from "../../shell/ContextMenu";
import { fmt } from "../../widgets/ui";

interface Entry { name: string; type: "dir" | "file" | "link" | "other"; target?: "dir" | "file" | "other"; size: number; mtime: number; mode: string; owner: string }
interface Opened { path: string; size: number; mtime: number; text?: string; binary?: boolean; tooLarge?: boolean }

const LAST = "harbor.files.path";
const join = (dir: string, name: string) => (dir === "/" ? "" : dir) + "/" + name;
const parent = (p: string) => p.replace(/\/[^/]+$/, "") || "/";
const isDir = (e: Entry) => e.type === "dir" || (e.type === "link" && e.target === "dir");
const ext = (n: string) => (n.includes(".") ? n.split(".").pop()!.toLowerCase() : "");
const IMG = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg"]);
const raw = (p: string, dl = false) => `/api/files/raw?path=${encodeURIComponent(p)}${dl ? "&dl=1" : ""}`;

function iconFor(e: Entry) {
  if (isDir(e)) return "solar:folder-linear";
  if (e.type === "link") return "solar:link-linear";
  const x = ext(e.name);
  if (IMG.has(x)) return "solar:gallery-linear";
  if (["mp4", "mkv", "mov", "avi", "webm"].includes(x)) return "solar:videocamera-record-linear";
  if (["mp3", "flac", "wav", "ogg", "m4a"].includes(x)) return "solar:music-note-linear";
  if (["zip", "gz", "tgz", "xz", "bz2", "7z", "rar", "tar", "zst"].includes(x)) return "solar:archive-linear";
  if (["db", "sqlite", "sqlite3"].includes(x)) return "solar:database-linear";
  if (["yml", "yaml", "json", "toml", "ini", "conf", "env", "sh", "js", "ts", "py", "go", "rs", "css", "html", "xml"].includes(x) || e.name.startsWith(".")) return "solar:code-linear";
  return "solar:file-text-linear";
}
const when = (ms: number) => {
  const d = new Date(ms), now = new Date();
  return d.toDateString() === now.toDateString() ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.getFullYear() === now.getFullYear() ? d.toLocaleDateString([], { month: "short", day: "numeric" }) : d.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
};

export default function Files() {
  const [cwd, setCwd] = useState<string | null>(null);
  const [home, setHome] = useState("/");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [filter, setFilter] = useState("");
  const [hidden, setHidden] = useState(false);
  const [editPath, setEditPath] = useState(false);
  const [creating, setCreating] = useState<null | "dir" | "file">(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [open, setOpen] = useState<Opened | null>(null);
  const [drag, setDrag] = useState(false);
  const [uploading, setUploading] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = async (dir: string) => {
    setLoading(true); setErr("");
    try {
      const r = await api<{ path: string; entries: Entry[] }>(`/api/files/list?path=${encodeURIComponent(dir)}`);
      setCwd(r.path); setEntries(r.entries); setFilter(""); setCreating(null); setRenaming(null);
      try { localStorage.setItem(LAST, r.path); } catch {}
    } catch (e) { setErr((e as Error).message); if (cwd == null) { setCwd("/"); } }
    setLoading(false);
  };

  useEffect(() => {
    api<{ home: string }>("/api/files/home").then((h) => {
      setHome(h.home);
      let last: string | null = null; try { last = localStorage.getItem(LAST); } catch {}
      load(last || h.home);
    }).catch((e) => setErr(e.message));
  }, []);

  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return entries.filter((e) => (hidden || !e.name.startsWith(".")) && (!f || e.name.toLowerCase().includes(f)));
  }, [entries, filter, hidden]);

  const openEntry = async (e: Entry) => {
    const p = join(cwd!, e.name);
    if (isDir(e)) return load(p);
    try { setOpen(await api<Opened>(`/api/files/read?path=${encodeURIComponent(p)}`)); }
    catch (x) { setErr((x as Error).message); }
  };

  const act = async (fn: () => Promise<unknown>) => { setErr(""); try { await fn(); await load(cwd!); } catch (e) { setErr((e as Error).message); } };
  const create = (name: string) => {
    if (!name.trim() || name.includes("/")) return setCreating(null);
    const p = join(cwd!, name.trim());
    act(() => api(creating === "dir" ? "/api/files/mkdir" : "/api/files/new", { method: "POST", json: { path: p } }))
      .then(() => { if (creating === "file") openEntry({ name: name.trim(), type: "file", size: 0, mtime: 0, mode: "", owner: "" }); });
  };
  const rename = (from: string, to: string) => {
    setRenaming(null);
    if (!to.trim() || to === from || to.includes("/")) return;
    act(() => api("/api/files/rename", { method: "POST", json: { from: join(cwd!, from), to: join(cwd!, to.trim()) } }));
  };
  const remove = (e: Entry) => {
    const p = join(cwd!, e.name);
    if (!confirm(`Delete ${p}${isDir(e) ? " and everything in it" : ""}? This can't be undone.`)) return;
    act(() => api("/api/files/delete", { method: "POST", json: { path: p } }));
    if (open?.path === p) setOpen(null);
  };
  const upload = async (files: FileList | File[]) => {
    for (const f of Array.from(files)) {
      setUploading(`${f.name} · ${fmt.bytes(f.size)}`);
      try {
        let r = await fetch(`/api/files/upload?dir=${encodeURIComponent(cwd!)}&name=${encodeURIComponent(f.name)}`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: f });
        if (r.status === 409 && confirm(`${f.name} already exists here. Replace it?`))
          r = await fetch(`/api/files/upload?dir=${encodeURIComponent(cwd!)}&name=${encodeURIComponent(f.name)}&replace=1`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: f });
        if (!r.ok && r.status !== 409) { const j = await r.json().catch(() => ({})); throw new Error(j.message ?? j.error ?? `Upload failed (${r.status})`); }
      } catch (e) { setErr((e as Error).message); }
    }
    setUploading(null); load(cwd!);
  };

  const menu = (e: Entry) => () => {
    const p = join(cwd!, e.name);
    return [
      { label: isDir(e) ? "Open" : "Open in editor", icon: isDir(e) ? "solar:folder-open-linear" : "solar:pen-linear", run: () => openEntry(e) },
      ...(!isDir(e) ? [{ label: "Download", icon: "solar:file-download-linear", run: () => { location.href = raw(p, true); } }] : []),
      { label: "Rename", icon: "solar:pen-linear", run: () => setRenaming(e.name) },
      { label: "Copy path", icon: "solar:copy-linear", run: () => copyText(p) },
      "-" as const,
      { label: "Delete", icon: "solar:trash-bin-minimalistic-linear", danger: true, run: () => remove(e) },
    ];
  };

  const crumbs = cwd ? cwd.split("/").filter(Boolean) : [];
  const places = [
    { label: "Home", icon: "solar:home-2-linear", path: home },
    { label: "Stacks", icon: "solar:server-square-linear", path: join(home, "harbor-stacks") },
    { label: "/", icon: "solar:folder-linear", path: "/" },
    { label: "/srv", icon: "solar:folder-linear", path: "/srv" },
    { label: "/etc", icon: "solar:settings-linear", path: "/etc" },
    { label: "Logs", icon: "solar:document-linear", path: "/var/log" },
  ].filter((p, i, a) => a.findIndex((x) => x.path === p.path) === i);

  return (
    <div class={`files ${open ? "has-editor" : ""}`}>
      <div class="fl-pane"
        onDragOver={(e) => { if (e.dataTransfer?.types.includes("Files")) { e.preventDefault(); setDrag(true); } }}
        onDragLeave={(e) => { if (e.currentTarget === e.target) setDrag(false); }}
        onDrop={(e) => { e.preventDefault(); setDrag(false); if (e.dataTransfer?.files.length) upload(e.dataTransfer.files); }}>

        <div class="fl-places">
          {places.map((p) => (
            <button key={p.path} class={`fl-place ${cwd === p.path ? "on" : ""}`} onClick={() => load(p.path)}><Icon name={p.icon} size={14} />{p.label}</button>
          ))}
        </div>

        <div class="fl-bar">
          <button class="iconbtn" aria-label="Up one folder" disabled={cwd === "/"} onClick={() => cwd && load(parent(cwd))}><Icon name="solar:alt-arrow-up-linear" size={16} /></button>
          {editPath ? (
            <form class="fl-path" onSubmit={(e) => { e.preventDefault(); const v = (e.currentTarget.elements[0] as HTMLInputElement).value.trim(); setEditPath(false); if (v.startsWith("/")) load(v); }}>
              <input class="mono" defaultValue={cwd ?? "/"} autoFocus onBlur={() => setEditPath(false)} aria-label="Path" />
            </form>
          ) : (
            <div class="fl-path" onDblClick={() => setEditPath(true)} title="Double-click to type a path">
              <button class="crumb-btn" onClick={() => load("/")}>/</button>
              {crumbs.map((c, i) => (
                <span key={i} style={{ display: "contents" }}>
                  {i > 0 && <span class="dim">/</span>}
                  <button class="crumb-btn" onClick={() => load("/" + crumbs.slice(0, i + 1).join("/"))}>{c}</button>
                </span>
              ))}
              <button class="iconbtn" style={{ marginLeft: "auto", width: 24, height: 24 }} aria-label="Type a path" onClick={() => setEditPath(true)}><Icon name="solar:pen-linear" size={13} /></button>
            </div>
          )}
          <div class="fl-actions">
            <input class="fl-filter" placeholder="Filter" value={filter} onInput={(e) => setFilter(e.currentTarget.value)} aria-label="Filter this folder" />
            <button class="iconbtn" aria-label={hidden ? "Hide hidden files" : "Show hidden files"} title={hidden ? "Hide dotfiles" : "Show dotfiles"} onClick={() => setHidden(!hidden)}><Icon name={hidden ? "solar:eye-linear" : "solar:eye-closed-linear"} size={16} /></button>
            <button class="iconbtn" aria-label="New folder" title="New folder" onClick={() => setCreating("dir")}><Icon name="solar:add-folder-linear" size={16} /></button>
            <button class="iconbtn" aria-label="New file" title="New file" onClick={() => setCreating("file")}><Icon name="solar:document-add-linear" size={16} /></button>
            <button class="iconbtn" aria-label="Upload" title="Upload (or drop files here)" onClick={() => fileInput.current?.click()}><Icon name="solar:upload-minimalistic-linear" size={16} /></button>
            <button class="iconbtn" aria-label="Refresh" onClick={() => cwd && load(cwd)}><Icon name="solar:refresh-linear" size={16} class={loading ? "rot" : undefined} /></button>
            <input ref={fileInput} type="file" multiple hidden onChange={(e) => { const f = e.currentTarget.files; if (f?.length) upload(f); e.currentTarget.value = ""; }} />
          </div>
        </div>

        {err && <div class="fl-err"><Icon name="solar:danger-triangle-linear" size={15} />{err}<button class="iconbtn" style={{ marginLeft: "auto", width: 22, height: 22 }} aria-label="Dismiss" onClick={() => setErr("")}><Icon name="solar:close-circle-linear" size={14} /></button></div>}
        {uploading && <div class="fl-note"><span class="spin" style={{ borderColor: "var(--line-2)", borderTopColor: "var(--acc)" }} />Uploading {uploading}</div>}

        <div class={`fl-list ${drag ? "drag" : ""}`}>
          <table class="ct fl-table">
            <thead><tr><th>Name</th><th class="r">Size</th><th class="hide-sm">Modified</th><th class="hide-sm">Owner</th><th class="hide-sm">Mode</th></tr></thead>
            <tbody>
              {creating && (
                <tr><td colSpan={5}>
                  <span class="fl-name"><Icon name={creating === "dir" ? "solar:folder-linear" : "solar:file-text-linear"} size={16} />
                    <input class="fl-inline mono" autoFocus placeholder={creating === "dir" ? "folder name" : "file name"}
                      onKeyDown={(e) => { if (e.key === "Enter") create(e.currentTarget.value); if (e.key === "Escape") setCreating(null); }}
                      onBlur={(e) => create(e.currentTarget.value)} />
                  </span>
                </td></tr>
              )}
              {shown.map((e) => {
                const p = join(cwd!, e.name);
                return (
                  <tr key={e.name} class={open?.path === p ? "sel" : ""} onClick={() => renaming !== e.name && openEntry(e)} {...menuHandlers(menu(e))}>
                    <td>
                      <span class="fl-name">
                        <span style={{ color: isDir(e) ? "var(--acc)" : "var(--t3)", display: "flex" }}><Icon name={iconFor(e)} size={16} /></span>
                        {renaming === e.name ? (
                          <input class="fl-inline mono" autoFocus defaultValue={e.name} onClick={(x) => x.stopPropagation()}
                            onKeyDown={(x) => { if (x.key === "Enter") rename(e.name, x.currentTarget.value); if (x.key === "Escape") setRenaming(null); }}
                            onBlur={(x) => rename(e.name, x.currentTarget.value)} />
                        ) : <span class="fl-n">{e.name}{e.type === "link" && <span class="dim"> →</span>}</span>}
                      </span>
                    </td>
                    <td class="r mono muted">{isDir(e) ? "–" : fmt.bytes(e.size).toString()}</td>
                    <td class="hide-sm muted">{when(e.mtime)}</td>
                    <td class="hide-sm muted mono">{e.owner}</td>
                    <td class="hide-sm dim mono">{e.mode}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!loading && cwd && !shown.length && !creating && (
            <div class="fl-empty">{filter ? `Nothing matches "${filter}".` : entries.length ? "Only hidden files here. Use the eye button to show them." : "This folder is empty. Drop files here to upload."}</div>
          )}
          {drag && <div class="fl-drop"><Icon name="solar:upload-minimalistic-linear" size={22} />Drop to upload to <span class="mono">{cwd}</span></div>}
        </div>
        <div class="fl-foot dim">{shown.length} item{shown.length === 1 ? "" : "s"}{entries.length !== shown.length && ` · ${entries.length - shown.length} hidden`} · right-click for more</div>
      </div>

      {open && <Editor key={open.path} file={open} onClose={() => setOpen(null)} onSaved={() => cwd && load(cwd)} />}
    </div>
  );
}

function Editor({ file, onClose, onSaved }: { file: Opened; onClose: () => void; onSaved: () => void }) {
  const [text, setText] = useState(file.text ?? "");
  const [mtime, setMtime] = useState(file.mtime);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const gutter = useRef<HTMLDivElement>(null);
  const dirty = text !== (file.text ?? "");
  const name = file.path.split("/").pop()!;
  const image = IMG.has(ext(name));
  const editable = file.text != null;
  const lines = useMemo(() => text.split("\n").length, [text]);

  const save = async () => {
    if (!editable || saving) return;
    setSaving(true); setMsg(null);
    try {
      const st = await api<{ mtime: number }>("/api/files/write", { method: "PUT", json: { path: file.path, content: text, mtime } });
      setMtime(st.mtime); file.text = text; setMsg({ ok: true, text: "Saved" }); onSaved();
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
    setSaving(false);
  };
  const close = () => { if (dirty && !confirm(`Discard your changes to ${name}?`)) return; onClose(); };

  useEffect(() => {
    const k = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); save(); } };
    addEventListener("keydown", k); return () => removeEventListener("keydown", k);
  });
  useEffect(() => { if (!dirty) return; const b = (e: BeforeUnloadEvent) => e.preventDefault(); addEventListener("beforeunload", b); return () => removeEventListener("beforeunload", b); }, [dirty]);

  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Tab") return;
    e.preventDefault();
    const t = e.currentTarget as HTMLTextAreaElement, s = t.selectionStart, en = t.selectionEnd;
    const v = t.value.slice(0, s) + "  " + t.value.slice(en);
    setText(v); requestAnimationFrame(() => { t.selectionStart = t.selectionEnd = s + 2; });
  };

  return (
    <section class="fl-editor" aria-label={`Editing ${name}`}>
      <header>
        <Icon name={image ? "solar:gallery-linear" : "solar:file-text-linear"} size={16} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div class="fl-ename">{name}{dirty && <span class="fl-dirty" title="Unsaved changes" />}</div>
          <div class="dim mono fl-epath">{file.path}</div>
        </div>
        {msg && <span class={msg.ok ? "muted" : "err-text"} style={{ fontSize: 12, maxWidth: 260 }}>{msg.text}</span>}
        <a class="iconbtn" href={raw(file.path, true)} aria-label="Download" title="Download"><Icon name="solar:file-download-linear" size={16} /></a>
        {editable && <button class="btn primary" onClick={save} disabled={!dirty || saving}><Icon name="solar:diskette-linear" size={14} />{saving ? "Saving…" : "Save"}</button>}
        <button class="iconbtn" aria-label="Close file" onClick={close}><Icon name="solar:close-circle-linear" size={17} /></button>
      </header>
      {image ? (
        <div class="fl-preview"><img src={raw(file.path)} alt={name} /></div>
      ) : editable ? (
        <div class="fl-code">
          <div ref={gutter} class="fl-gutter mono" aria-hidden="true">{Array.from({ length: lines }, (_, i) => <div key={i}>{i + 1}</div>)}</div>
          <textarea ref={area} class="mono" value={text} spellcheck={false} autoCapitalize="off" autoComplete="off"
            onInput={(e) => { setText(e.currentTarget.value); setMsg(null); }} onKeyDown={onKey}
            onScroll={(e) => { if (gutter.current) gutter.current.scrollTop = e.currentTarget.scrollTop; }} />
        </div>
      ) : (
        <div class="fl-preview muted">
          <Icon name="solar:file-linear" size={28} />
          <div>{file.tooLarge ? `This file is ${fmt.bytes(file.size)}, too large to edit here.` : "This looks like a binary file."}</div>
          <a class="btn" href={raw(file.path, true)}><Icon name="solar:file-download-linear" size={14} />Download</a>
        </div>
      )}
      <footer class="dim mono">{editable ? `${lines} lines · ${fmt.bytes(new Blob([text]).size)} · ⌘S / Ctrl+S to save` : fmt.bytes(file.size).toString()}</footer>
    </section>
  );
}

/** navigator.clipboard is missing over plain http, so fall back to a hidden textarea. */
function copyText(t: string) {
  if (navigator.clipboard && window.isSecureContext) { navigator.clipboard.writeText(t); return; }
  const a = document.createElement("textarea"); a.value = t; a.style.position = "fixed"; a.style.opacity = "0";
  document.body.append(a); a.select(); document.execCommand("copy"); a.remove();
}
