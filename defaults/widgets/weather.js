// Weather from Open-Meteo (no API key). The place is set in Settings → Wall.
// Edit freely: this file is loaded live by HarborOS.
const WMO = {
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
const look = (code, day = 1) => { const w = WMO[code] ?? ["–", "cloud-linear"]; return { text: w[0], icon: !day && w[2] ? w[2] : w[1] }; };

export default {
  title: "Weather",
  sizes: ["m", "w", "l", "s"],
  mount(el, { ui, api, size }) {
    const top = ui.h("div", { style: { display: "flex", alignItems: "center", gap: "14px" } });
    const ico = ui.h("div", { style: { color: ui.theme.cream, display: "flex" } });
    const temp = ui.h("div", { class: "big", style: { fontSize: size === "s" ? "34px" : "52px", lineHeight: "1" } });
    const side = ui.h("div", { style: { display: "grid", gap: "3px" } });
    const desc = ui.h("div", { style: { fontWeight: "600" } });
    const meta = ui.h("div", { class: "k" });
    side.append(desc, meta);
    top.append(ico, temp, side);
    const place = ui.h("div", { class: "k", style: { marginBottom: "10px" } });
    const days = ui.h("div", { style: { display: "flex", gap: "6px", marginTop: "auto", paddingTop: "14px" } });
    el.append(place, top);
    if (size !== "s") el.append(days);

    const draw = (w) => {
      if (!w.place) { place.textContent = "Weather"; desc.textContent = "No place set"; meta.textContent = "Settings → Wall → Weather"; return; }
      const c = w.current;
      const l = look(c.weather_code, c.is_day);
      place.textContent = w.place.name.split(",")[0];
      ico.replaceChildren(ui.icon(l.icon, size === "s" ? 34 : 52));
      temp.textContent = `${Math.round(c.temperature_2m)}°`;
      desc.textContent = l.text;
      meta.textContent = `Feels ${Math.round(c.apparent_temperature)}° · ${Math.round(c.wind_speed_10m)} km/h · ${c.relative_humidity_2m}%`;
      const n = size === "m" ? 4 : 6;
      days.replaceChildren(...w.daily.time.slice(0, n).map((t, i) => {
        const d = look(w.daily.weather_code[i]);
        return ui.h("div", { style: { flex: "1", display: "grid", justifyItems: "center", gap: "4px", padding: "8px 0", border: `1px solid ${ui.theme.line}` } },
          ui.h("div", { class: "k" }, i === 0 ? "Today" : new Date(t).toLocaleDateString([], { weekday: "short" })),
          ui.icon(d.icon, 22),
          ui.h("div", { class: "mono", style: { fontSize: "12.5px" } }, `${Math.round(w.daily.temperature_2m_max[i])}° ${Math.round(w.daily.temperature_2m_min[i])}°`));
      }));
    };
    const load = () => api("/api/weather").then(draw).catch((e) => { desc.textContent = "Weather unavailable"; meta.textContent = e.message; });
    load();
    const t = setInterval(load, 10 * 60_000);
    return { destroy() { clearInterval(t); } };
  },
};
