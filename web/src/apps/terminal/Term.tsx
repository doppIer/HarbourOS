// One xterm.js instance attached to one tmux session over WebSocket.
import { useEffect, useRef } from "preact/hooks";
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

  useEffect(() => {
    const term = new Terminal({
      fontFamily: '"JetBrains Mono", ui-monospace, monospace', fontSize: innerWidth < 760 ? 12 : 13, lineHeight: 1.25,
      theme, cursorBlink: true, scrollback: 5000, allowProposedApi: true, macOptionIsMeta: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit); term.loadAddon(new WebLinksAddon());
    term.open(el.current!);
    fitRef.current = fit; termRef.current = term;

    let ws: WebSocket | null = null;
    let closed = false;
    const sendResize = () => ws?.readyState === 1 && ws.send("\u0000" + JSON.stringify({ t: "resize", cols: term.cols, rows: term.rows }));
    const open = () => {
      const q = program ? `?program=${program}` : "";
      ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/term/${encodeURIComponent(session)}${q}`);
      ws.onopen = () => { fit.fit(); sendResize(); };
      ws.onmessage = (e) => term.write(typeof e.data === "string" ? e.data : new Uint8Array(e.data));
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

  return <div ref={el} style={{ position: "absolute", inset: "8px 8px 8px 12px", display: visible ? "block" : "none" }} />;
}
