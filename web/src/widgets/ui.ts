// Helpers handed to every widget as `ctx.ui`. All charts draw on canvas in a
// single shared requestAnimationFrame loop that only runs when something
// changed and the tab is visible.

const dirty = new Set<() => void>();
let raf = 0;
function schedule() {
  if (raf || document.hidden) return;
  raf = requestAnimationFrame(() => { raf = 0; const fns = [...dirty]; dirty.clear(); fns.forEach((f) => f()); });
}
document.addEventListener("visibilitychange", () => { if (!document.hidden && dirty.size) schedule(); });
const invalidate = (f: () => void) => { dirty.add(f); schedule(); };

export const theme = {
  acc: () => getComputedStyle(document.documentElement).getPropertyValue("--acc").trim() || "#7b7bf0",
  teal: "#2ee6c5", violet: "#8b5cf6", green: "#4cb782", cream: "#f3e9dc", blue: "#1f4e8c",
  ok: "#4cb782", warn: "#f2c94c", err: "#eb5757", t1: "#f7f8f8", t2: "#d0d6e0", t3: "#8a8f98", t4: "#62666d", line: "rgba(255,255,255,.07)",
};

// ---------- formatting ----------
export const fmt = {
  pct: (v: number, d = 1) => `${(v ?? 0).toFixed(d)}`,
  bytes(b: number, d = 1) {
    const u = ["B", "KB", "MB", "GB", "TB"]; let i = 0; b = b ?? 0;
    while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
    return { v: b.toFixed(i < 2 ? 0 : d), u: u[i], toString() { return `${this.v} ${this.u}`; } };
  },
  rate(b: number) { const x = fmt.bytes(b); return { v: x.v, u: x.u + "/s", toString() { return `${x.v} ${x.u}/s`; } }; },
  dur(s: number) {
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
  },
  ago(ms: number) { return fmt.dur((Date.now() - ms) / 1000); },
};

// ---------- tiny DOM helper ----------
export function h(tag: string, props: Record<string, any> = {}, ...kids: (Node | string | null | undefined)[]) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k.startsWith("on")) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "class") el.className = v;
    else if (v != null) el.setAttribute(k, String(v));
  }
  kids.forEach((c) => c != null && el.append(c));
  return el;
}

// ---------- big number ----------
export function bigNumber(parent: HTMLElement, o: { label?: string; unit?: string; size?: number; glow?: boolean } = {}) {
  const label = o.label ? h("div", { class: "k" }, o.label) : null;
  const num = h("div", { class: `big ${o.glow ? "glow" : ""}`, style: { fontSize: `${o.size ?? 34}px`, margin: "6px 0 4px" } });
  const val = document.createTextNode("–");
  const unit = h("small", {}, o.unit ?? "");
  num.append(val, unit);
  if (label) parent.append(label);
  parent.append(num);
  return {
    el: num,
    set(v: string | number, u?: string) { val.data = String(v); if (u != null) unit.textContent = u; },
    color(c: string) { num.style.color = c; },
  };
}

// ---------- canvas base ----------
function canvas(parent: HTMLElement, height: number | "fill") {
  const c = h("canvas", { style: { width: "100%", height: height === "fill" ? "100%" : `${height}px`, display: "block" } }) as HTMLCanvasElement;
  parent.append(c);
  const ctx = c.getContext("2d")!;
  const size = () => {
    const r = c.getBoundingClientRect(), dpr = Math.min(devicePixelRatio || 1, 2);
    if (c.width !== Math.round(r.width * dpr) || c.height !== Math.round(r.height * dpr)) {
      c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w: r.width, h: r.height };
  };
  return { c, ctx, size };
}

function smoothPath(ctx: CanvasRenderingContext2D, pts: [number, number][]) {
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1], [x1, y1] = pts[i], mx = (x0 + x1) / 2;
    ctx.bezierCurveTo(mx, y0, mx, y1, x1, y1);
  }
}

function downsample(a: number[], n: number) {
  if (a.length <= n) return a;
  const out: number[] = [], step = a.length / n;
  for (let i = 0; i < n; i++) { const s = a.slice(Math.floor(i * step), Math.floor((i + 1) * step)); out.push(s.reduce((x, y) => x + y, 0) / s.length); }
  return out;
}

// ---------- sparkline (small tiles) ----------
export function sparkline(parent: HTMLElement, o: { color?: string; height?: number; max?: number; points?: number } = {}) {
  const { ctx, size, c } = canvas(parent, o.height ?? 30);
  let data: number[] = [];
  const draw = () => {
    const { w, h: H } = size();
    ctx.clearRect(0, 0, w, H);
    const d = downsample(data, o.points ?? 60);
    if (d.length < 2) return;
    const max = o.max ?? Math.max(...d, 1) * 1.15;
    const pts = d.map((v, i) => [(i / (d.length - 1)) * w, H - 2 - (v / max) * (H - 4)] as [number, number]);
    const col = o.color ?? theme.acc();
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, col + "55"); g.addColorStop(1, col + "00");
    ctx.beginPath(); smoothPath(ctx, pts); ctx.lineTo(w, H); ctx.lineTo(0, H); ctx.closePath(); ctx.fillStyle = g; ctx.fill();
    ctx.beginPath(); smoothPath(ctx, pts); ctx.strokeStyle = col; ctx.lineWidth = 1.4; ctx.stroke();
  };
  new ResizeObserver(() => invalidate(draw)).observe(c);
  return { set(a: number[]) { data = a; invalidate(draw); } };
}

// ---------- layered area chart with crosshair + trend card ----------
export interface Series { label: string; color: string; data: number[]; format?: (v: number) => string }
export function area(parent: HTMLElement, o: { max?: number; points?: number; trend?: (i: number, series: Series[]) => { title: string; value: string; lines: string[] } } = {}) {
  parent.style.position = "relative";
  const { ctx, size, c } = canvas(parent, "fill");
  const tip = h("div", { style: { position: "absolute", top: "40px", width: "190px", background: "#f4f4f4", color: "#161616", borderRadius: "0", padding: "12px 14px", display: "none", pointerEvents: "none", boxShadow: "0 12px 32px rgba(0,0,0,.45)", zIndex: 2 } });
  parent.append(tip);
  let series: Series[] = [];
  let hover: number | null = null;

  const draw = () => {
    const { w, h: H } = size();
    ctx.clearRect(0, 0, w, H);
    if (!series.length) return;
    const n = Math.min(o.points ?? 48, Math.max(...series.map((s) => s.data.length)));
    if (n < 2) return;
    const ds = series.map((s) => downsample(s.data, n));
    const max = o.max ?? Math.max(1, ...ds.flat()) * 1.25;
    const top = 50;
    // Draw the largest series first so smaller ones stay visible on top.
    const mean = (d: number[]) => d.reduce((a, b) => a + b, 0) / (d.length || 1);
    const order = ds.map((_, i) => i).sort((a, b) => mean(ds[b]) - mean(ds[a]));
    order.forEach((si) => {
      const d = ds[si];
      const col = series[si].color;
      const pts = d.map((v, i) => [(i / (d.length - 1)) * w, H - (v / max) * (H - top)] as [number, number]);
      const g = ctx.createLinearGradient(0, top, 0, H);
      g.addColorStop(0, col + "b0"); g.addColorStop(1, theme.blue + "40");
      ctx.beginPath(); smoothPath(ctx, pts); ctx.lineTo(w, H); ctx.lineTo(0, H); ctx.closePath();
      ctx.globalAlpha = 0.8; ctx.fillStyle = g; ctx.fill(); ctx.globalAlpha = 1;
      ctx.beginPath(); smoothPath(ctx, pts); ctx.strokeStyle = col; ctx.lineWidth = 1.5; ctx.stroke();
    });
    if (hover != null) {
      const x = hover * w;
      ctx.setLineDash([4, 5]); ctx.strokeStyle = "#fff"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, 18); ctx.lineTo(x, H - 6); ctx.stroke(); ctx.setLineDash([]);
      const i = Math.round(hover * (n - 1));
      ds.forEach((d, si) => {
        const y = H - (d[i] / max) * (H - top);
        ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2); ctx.fillStyle = "#fff"; ctx.fill();
        ctx.lineWidth = 2; ctx.strokeStyle = series[si].color; ctx.stroke();
      });
      if (o.trend) {
        const t = o.trend(i, series.map((s, si) => ({ ...s, data: ds[si] })));
        tip.innerHTML = "";
        tip.append(h("div", { style: { fontSize: "12px", fontWeight: "600" } }, t.title),
          h("div", { class: "big", style: { fontSize: "30px", margin: "6px 0 10px" } }, t.value),
          ...t.lines.map((l) => h("div", { style: { fontSize: "12px", lineHeight: "1.7" } }, l)));
        tip.style.display = "block";
        tip.style.left = `${Math.min(x + 14, w - 200)}px`;
      }
    } else tip.style.display = "none";
  };

  c.addEventListener("pointermove", (e) => { const r = c.getBoundingClientRect(); hover = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); invalidate(draw); });
  c.addEventListener("pointerleave", () => { hover = null; invalidate(draw); });
  new ResizeObserver(() => invalidate(draw)).observe(c);
  return { set(s: Series[]) { series = s; invalidate(draw); } };
}

// ---------- horizontal bar ----------
export function bar(parent: HTMLElement, o: { color?: string } = {}) {
  const fill = h("div", { style: { height: "100%", width: "0%", background: o.color ?? "var(--acc)", borderRadius: "2px", transition: "width .4s ease" } });
  parent.append(h("div", { style: { height: "4px", background: "var(--line)", borderRadius: "2px", margin: "10px 0" } }, fill));
  return { set(pct: number, color?: string) { fill.style.width = `${Math.max(0, Math.min(100, pct))}%`; if (color) fill.style.background = color; } };
}

export function legend(parent: HTMLElement, items: { label: string; color: string }[]) {
  const el = h("div", { style: { display: "flex", flexDirection: "column", gap: "6px" } },
    ...items.map((i) => h("div", { style: { display: "flex", alignItems: "center", gap: "8px", fontSize: "12.5px", fontWeight: "500" } },
      h("i", { style: { width: "10px", height: "10px", borderRadius: "3px", background: i.color, display: "inline-block" } }), i.label)));
  parent.append(el);
  return el;
}

export const ui = { h, bigNumber, sparkline, area, bar, legend, fmt, theme };
export type UI = typeof ui;
