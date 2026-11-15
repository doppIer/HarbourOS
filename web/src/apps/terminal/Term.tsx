// One xterm.js instance attached to one tmux session over WebSocket.
import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "../../lib/ws";
import { Icon } from "../../icons/Icon";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";

export interface TermHandle { send(s: string): void; focus(): void }

const theme = {
  background: "#0f1011", foreground: "#d0d6e0", cursor: "#7b7bf0", cursorAccent: "#0f1011",
  selectionBackground: "#7b7bf044", black: "#16171a", brightBlack: "#62666d",
  red: "#eb5757", green: "#4cb782", yellow: "#f2c94c", blue: "#7b7bf0", magenta: "#b18cf2", cyan: "#2ee6c5", white: "#d0d6e0",
  brightRed: "#ff7b7b", brightGreen: "#7fe0b0", brightYellow: "#ffe08a", brightBlue: "#a5a5ff", brightMagenta: "#cfb2ff", brightCyan: "#8ff5e3", brightWhite: "#f7f8f8",
};

export function Term({ session, program, visible, onReady, ctrl }: {
  session: string; program?: string; visible: boolean; onReady?: (h: TermHandle) => void; ctrl?: { current: boolean };
}) {
  const el = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon>();
  const termRef = useRef<Terminal>();
  const [link, setLink] = useState<string | null>(null);

  useEffect(() => {
    const term = new Terminal({
      fontFamily: '"JetBrains Mono", ui-monospace, monospace', fontSize: innerWidth < 760 ? 12 : 13, lineHeight: 1.25,
      theme, cursorBlink: true, scrollback: 5000, allowProposedApi: true, macOptionIsMeta: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit); term.loadAddon(new WebLinksAddon());
    term.open(el.current!);
    fitRef.current = fit; termRef.current = term;

    // Long links (Claude Code's sign-in link) wrap over several lines or get cut
    // at the edge, so xterm can't make them clickable. Watch the screen for one
    // and offer an "Open" button instead.
    let scanT: number | undefined;
    const scan = () => { clearTimeout(scanT); scanT = window.setTimeout(() => setLink(findLink(term)), 250); };

    let ws: WebSocket | null = null;
    let closed = false;
    const sendResize = () => ws?.readyState === 1 && ws.send("\u0000" + JSON.stringify({ t: "resize", cols: term.cols, rows: term.rows }));
    const open = () => {
      const q = program ? `?program=${encodeURIComponent(program)}` : "";
      ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/term/${encodeURIComponent(session)}${q}`);
      ws.onopen = () => { fit.fit(); sendResize(); };
      ws.onmessage = (e) => { term.write(typeof e.data === "string" ? e.data : new Uint8Array(e.data)); scan(); };
      ws.onclose = () => { if (!closed) { term.write("\r\n\x1b[90m[disconnected — reconnecting…]\x1b[0m\r\n"); setTimeout(open, 1500); } };
    };
    open();

    term.onData((d) => {
      // Sticky Ctrl from the touch key row: turn the next letter into a control char.
      if (ctrl?.current && d.length === 1) {
        ctrl.current = false;
        const c = d.toUpperCase().charCodeAt(0);
        if (c >= 64 && c <= 95) d = String.fromCharCode(c - 64);
      }
      ws?.readyState === 1 && ws.send(d);
    });
    term.onResize(sendResize);
    onReady?.({ send: (s) => ws?.readyState === 1 && ws.send(s), focus: () => term.focus() });

    const ro = new ResizeObserver(() => { if (el.current?.offsetParent) fit.fit(); });
    ro.observe(el.current!);
    return () => { closed = true; ro.disconnect(); ws?.close(); term.dispose(); };
  }, [session, program]);

  useEffect(() => { if (visible) requestAnimationFrame(() => { fitRef.current?.fit(); termRef.current?.focus(); }); }, [visible]);

  const openLink = async (copy = false) => {
    if (!link) return;
    // Open the tab right away (inside the click) so the popup blocker allows it.
    const w = copy ? null : window.open("about:blank", "_blank");
    if (w) w.opener = null;
    // The screen copy may be cut off; tmux's buffer has the whole link when the program copied it.
    let url = link;
    try {
      const { text } = await api<{ text: string }>("/api/terminal/buffer");
      const full = text.match(/https?:\/\/\S+/)?.[0];
      if (full && full.startsWith(link.slice(0, 40))) url = full;
    } catch {}
    if (copy) copyText(url); else if (w) w.location.href = url; else window.open(url, "_blank", "noopener");
  };

  return (
    <>
      <div ref={el} style={{ position: "absolute", inset: "8px 8px 8px 12px", display: visible ? "block" : "none" }} />
      {visible && link && (
        <div class="term-link">
          <Icon name="solar:link-linear" size={15} />
          <span class="mono">{new URL(link).host}</span>
          <button class="btn primary" onClick={() => openLink()}>Open link</button>
          <button class="btn" onClick={() => openLink(true)}>Copy</button>
          <button class="iconbtn" aria-label="Hide" onClick={() => setLink(null)}><Icon name="solar:close-circle-linear" size={16} /></button>
        </div>
      )}
    </>
  );
}

/** The last long link on screen, with lines that a program wrapped joined back up. */
function findLink(term: Terminal): string | null {
  const b = term.buffer.active, lines: string[] = [];
  for (let y = Math.max(0, b.length - term.rows - 20); y < b.length; y++) lines.push(b.getLine(y)?.translateToString(true) ?? "");
  let found: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/https?:\/\/[^\s]+$/);
    if (!m) continue;
    let url = m[0];
    // Following lines that are nothing but URL characters continue it.
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j].trim();
      if (!t || !/^[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+$/.test(t)) break;
      url += t; i = j;
    }
    if (url.length > 60) found = url;
  }
  return found;
}

/** navigator.clipboard is missing over plain http, so fall back to a hidden textarea. */
function copyText(t: string) {
  if (navigator.clipboard && window.isSecureContext) { navigator.clipboard.writeText(t); return; }
  const a = document.createElement("textarea"); a.value = t; a.style.position = "fixed"; a.style.opacity = "0";
  document.body.append(a); a.select(); document.execCommand("copy"); a.remove();
}
