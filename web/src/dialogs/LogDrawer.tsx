import { useEffect, useRef, useState } from "preact/hooks";
import { dialog, containers } from "../store";
import { Icon } from "../icons/Icon";

export default function LogDrawer({ container }: { container: string }) {
  const [lines, setLines] = useState<string[]>([]);
  const [follow, setFollow] = useState(true);
  const box = useRef<HTMLDivElement>(null);
  const id = containers.value.find((c) => c.name === container)?.id ?? container;

  useEffect(() => {
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/logs/${encodeURIComponent(id)}`);
    let buf: string[] = [], t = 0;
    ws.onmessage = (e) => {
      buf.push(String(e.data));
      if (!t) t = requestAnimationFrame(() => { t = 0; const b = buf; buf = []; setLines((l) => [...l, ...b].slice(-2000)); });
    };
    return () => ws.close();
  }, [id]);
  useEffect(() => { if (follow) box.current?.scrollTo({ top: 1e9 }); }, [lines, follow]);

  const close = () => (dialog.value = null);
  return (
    <div class="scrim" style={{ alignItems: "flex-end", padding: 0 }} onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div class="dialog" style={{ width: "100%", maxWidth: 1100, height: "70%", borderRadius: "12px 12px 0 0", display: "flex", flexDirection: "column" }}>
        <header>
          <Icon name="solar:document-text-linear" /><span class="mono" style={{ marginLeft: 8 }}>{container}</span>
          <label class="check" style={{ marginLeft: "auto", fontSize: 12.5 }}><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.currentTarget.checked)} />Follow</label>
          <button class="iconbtn" aria-label="Close" onClick={close}><Icon name="solar:close-circle-linear" /></button>
        </header>
        <div ref={box} class="mono" style={{ flex: 1, overflow: "auto", padding: "12px 16px", fontSize: 12, lineHeight: 1.6, color: "var(--t2)", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
          {lines.length ? lines.map((l, i) => <div key={i} style={/error|fatal|panic|exception/i.test(l) ? { color: "var(--err)" } : undefined}>{l}</div>) : <span class="dim">Waiting for log lines…</span>}
        </div>
      </div>
    </div>
  );
}
