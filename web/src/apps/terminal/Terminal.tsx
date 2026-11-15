import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "../../lib/ws";
import { Icon } from "../../icons/Icon";
import { Term, type TermHandle } from "./Term";

// Extra keys for iPhone keyboards.
const KEYS: [string, string][] = [["Esc", "\x1b"], ["Tab", "\t"], ["Ctrl", ""], ["←", "\x1b[D"], ["↑", "\x1b[A"], ["↓", "\x1b[B"], ["→", "\x1b[C"], ["|", "|"], ["~", "~"], ["/", "/"], ["-", "-"]];

export function TerminalTabs({ fixed }: { fixed?: { name: string; program: string } }) {
  const [tabs, setTabs] = useState<string[]>(fixed ? [fixed.name] : []);
  const [active, setActive] = useState(fixed?.name ?? "");
  const handles = useRef<Record<string, TermHandle>>({});
  const ctrl = useRef(false);
  const [ctrlOn, setCtrlOn] = useState(false);
  const touch = matchMedia("(pointer: coarse)").matches;

  useEffect(() => {
    if (fixed) return;
    api<string[]>("/api/terminal/sessions").then((s) => {
      const list = s.filter((x) => x !== "claude");
      const t = list.length ? list : ["main"];
      setTabs(t); setActive(t[0]);
    }).catch(() => { setTabs(["main"]); setActive("main"); });
  }, []);

  const add = () => {
    let n = 1; while (tabs.includes(`shell${n}`)) n++;
    const name = `shell${n}`; setTabs([...tabs, name]); setActive(name);
  };
  const close = async (t: string) => {
    if (!confirm(`End the tmux session "${t}"? Anything running in it stops.`)) return;
    await api(`/api/terminal/sessions/${t}`, { method: "DELETE" }).catch(() => {});
    const rest = tabs.filter((x) => x !== t);
    setTabs(rest.length ? rest : ["main"]); if (active === t) setActive(rest[0] ?? "main");
  };

  return (
    <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", background: "#0f1011" }}>
      {!fixed && (
        <div style={{ display: "flex", gap: 2, padding: "8px 8px", borderBottom: "1px solid var(--line)", overflowX: "auto" }}>
          {tabs.map((t) => (
            <div key={t} class={`it ${t === active ? "on" : ""}`} style={{ width: "auto", height: 28 }} onClick={() => setActive(t)}>
              <Icon name="solar:programming-linear" size={15} /><span class="mono" style={{ fontSize: 12 }}>{t}</span>
              <button class="iconbtn" style={{ width: 20, height: 20 }} aria-label={`End ${t}`} onClick={(e) => { e.stopPropagation(); close(t); }}>
                <Icon name="solar:close-circle-linear" size={13} />
              </button>
            </div>
          ))}
          <button class="iconbtn" aria-label="New tab" onClick={add}><Icon name="solar:add-square-linear" /></button>
          <span class="dim hide-sm" style={{ marginLeft: "auto", alignSelf: "center", fontSize: 12 }}>tmux sessions keep running when you close this page</span>
        </div>
      )}
      <div style={{ flex: 1, position: "relative", minHeight: 0 }}>
        {tabs.map((t) => (
          <Term key={t} session={t} program={fixed?.program} visible={t === active} ctrl={ctrl}
            onReady={(h) => (handles.current[t] = h)} />
        ))}
      </div>
      {touch && (
        <div style={{ display: "flex", gap: 4, padding: "8px 8px calc(8px + var(--sab))", borderTop: "1px solid var(--line)", overflowX: "auto" }}>
          {KEYS.map(([label, seq]) => (
            <button key={label} class="btn mono" style={{ minWidth: 40, justifyContent: "center", ...(label === "Ctrl" && ctrlOn ? { background: "var(--acc)", color: "#0b0b18" } : {}) }}
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => {
                if (label === "Ctrl") { ctrl.current = !ctrl.current; setCtrlOn(ctrl.current); handles.current[active]?.focus(); return; }
                handles.current[active]?.send(seq); handles.current[active]?.focus();
              }}>{label}</button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function TerminalApp() { return <TerminalTabs />; }
