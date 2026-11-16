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

export function Night({ onPeek }: { onPeek: () => void }) {
  const [now, setNow] = useState(new Date());
  const [wx, setWx] = useState<any>(null);
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 10_000); return () => clearInterval(t); }, []);
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
      <div class="night-clock" aria-label={`${hh}:${mm}`}>{hh}<span class="night-colon">:</span>{mm}</div>
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
