// Night view on the wall: during night mode the tiles step aside for a big
// clock and the weather, like a phone's stand-by screen at night. The red
// overlay turns it red. Tap to peek at the tiles for a moment.
import { useEffect, useState } from "preact/hooks";
import { api } from "../lib/ws";
import { Icon } from "../icons/Icon";

// Open-Meteo weather codes → text and Solar icon (night icon where it differs).
const WMO: Record<number, [string, string, string?]> = {
  0: ["Clear", "sun-2-linear", "moon-linear"], 1: ["Mostly clear", "sun-2-linear", "moon-linear"],
  2: ["Partly cloudy", "cloud-sun-2-linear", "cloudy-moon-linear"], 3: ["Cloudy", "cloud-linear"],
  45: ["Fog", "fog-linear"], 48: ["Fog", "fog-linear"],
  51: ["Drizzle", "cloud-rain-linear"], 53: ["Drizzle", "cloud-rain-linear"], 55: ["Drizzle", "cloud-rain-linear"],
  61: ["Rain", "cloud-rain-linear"], 63: ["Rain", "cloud-rain-linear"], 65: ["Heavy rain", "cloud-rain-linear"],
  66: ["Freezing rain", "cloud-rain-linear"], 67: ["Freezing rain", "cloud-rain-linear"],
  71: ["Snow", "cloud-snowfall-linear"], 73: ["Snow", "cloud-snowfall-linear"], 75: ["Heavy snow", "cloud-snowfall-linear"], 77: ["Snow", "cloud-snowfall-linear"],
  80: ["Showers", "cloud-rain-linear"], 81: ["Showers", "cloud-rain-linear"], 82: ["Heavy showers", "cloud-rain-linear"],
  85: ["Snow showers", "cloud-snowfall-linear"], 86: ["Snow showers", "cloud-snowfall-linear"],
  95: ["Thunderstorm", "cloud-bolt-linear"], 96: ["Thunderstorm", "cloud-bolt-linear"], 99: ["Thunderstorm", "cloud-bolt-linear"],
};

export function Night({ onPeek, face = false }: { onPeek: () => void; face?: boolean }) {
  const [now, setNow] = useState(new Date());
  const [wx, setWx] = useState<any>(null);
  // The watch face has a seconds hand, so it ticks every second.
  useEffect(() => { const t = setInterval(() => setNow(new Date()), face ? 1000 : 10_000); return () => clearInterval(t); }, [face]);
  useEffect(() => {
    const load = () => api<any>("/api/weather").then(setWx).catch(() => {});
    load(); const t = setInterval(load, 15 * 60_000); return () => clearInterval(t);
  }, []);

  const c = wx?.current;
  const w = c ? WMO[c.weather_code] ?? ["", "cloud-linear"] : null;
  const icon = w ? (!c.is_day && w[2] ? w[2] : w[1]) : null;
  const hi = wx?.daily?.temperature_2m_max?.[0], lo = wx?.daily?.temperature_2m_min?.[0];
  const hh = String(now.getHours()).padStart(2, "0"), mm = String(now.getMinutes()).padStart(2, "0");

  return (
    <div class="night" onClick={onPeek} role="button" aria-label="Show the tiles for a moment">
      {face ? <Face now={now} /> : <div class="night-clock" aria-label={`${hh}:${mm}`}>{hh}<span class="night-colon">:</span>{mm}</div>}
      <div class="night-date">{now.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" })}</div>
      {c && (
        <div class="night-wx">
          <Icon name={`solar:${icon}`} size={44} />
          <span class="night-temp">{Math.round(c.temperature_2m)}°</span>
          <span class="night-desc">
            <span>{w![0]}{wx.place?.name ? ` · ${wx.place.name.split(",")[0]}` : ""}</span>
            {hi != null && <span class="dim">H {Math.round(hi)}°  L {Math.round(lo)}°</span>}
          </span>
        </div>
      )}
    </div>
  );
}

/** The same watch face as the clock tile's "Watch face" style. */
const at = (deg: number, r: number) => { const a = (deg - 90) * Math.PI / 180; return [Math.cos(a) * r, Math.sin(a) * r]; };
const MARKS = Array.from({ length: 60 }, (_, i) => {
  const deg = i * 6;
  if (i % 5) { const [x1, y1] = at(deg, 79), [x2, y2] = at(deg, 84); return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke="rgba(255,255,255,.45)" stroke-width="1" stroke-linecap="round" />; }
  const [x1, y1] = at(deg, 74), [x2, y2] = at(deg, 85), [hx, hy] = at(deg, 60), flip = deg > 90 && deg < 270;
  return (
    <g key={i}>
      <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="rgba(255,255,255,.7)" stroke-width="3.2" stroke-linecap="round" />
      <text transform={`rotate(${flip ? deg + 180 : deg}) translate(0 ${flip ? 95 : -92})`} text-anchor="middle" dominant-baseline="middle" font-size="7" letter-spacing=".4" fill="rgba(255,255,255,.5)">{String(i === 0 ? 60 : i).padStart(2, "0")}</text>
      <text x={hx} y={hy} text-anchor="middle" dominant-baseline="central" font-size="15" font-weight="500" fill="#fff">{i === 0 ? 12 : i / 5}</text>
    </g>
  );
});
function Hand({ len, w, deg }: { len: number; w: number; deg: number }) {
  return (
    <g transform={`rotate(${deg})`}>
      <line x1="0" y1="4" x2="0" y2={-len} stroke="rgba(255,255,255,.85)" stroke-width={w} stroke-linecap="round" />
      <line x1="0" y1="4" x2="0" y2={-len * 0.28} stroke="rgba(255,255,255,.85)" stroke-width={w * 1.9} stroke-linecap="round" />
    </g>
  );
}
function Face({ now }: { now: Date }) {
  const sec = now.getSeconds(), min = now.getMinutes() + sec / 60, hr = (now.getHours() % 12) + min / 60;
  return (
    <div class="night-face" aria-label={now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}>
      <svg viewBox="-100 -100 200 200">
        {MARKS}
        <Hand len={42} w={2.6} deg={hr * 30} />
        <Hand len={74} w={2} deg={min * 6} />
        <g transform={`rotate(${sec * 6})`}><line x1="0" y1="18" x2="0" y2="-80" stroke="rgba(255,255,255,.8)" stroke-width=".9" stroke-linecap="round" /></g>
        <circle r="3.4" fill="rgba(255,255,255,.9)" /><circle r="1.4" fill="#000" />
      </svg>
    </div>
  );
}
