// Upcoming events from a shared calendar link (Apple Calendar: share as a
// public calendar, then paste the webcal:// link in the tile's options).
export default {
  title: "Calendar",
  sizes: ["tall", "m", "l", "w", "s"],
  mount(el, { ui, api, size, opts }) {
    const head = ui.h("div", { class: "k", style: { marginBottom: "12px" } });
    const list = ui.h("div", { style: { display: "grid", gap: "10px", alignContent: "start", overflow: "hidden" } });
    el.append(head, list);
    const max = size === "s" ? 2 : size === "m" ? 3 : 8;
    const day = (t) => {
      const d = new Date(t), today = new Date(); today.setHours(0, 0, 0, 0);
      const diff = Math.round((new Date(d).setHours(0, 0, 0, 0) - today) / 86400000);
      return diff === 0 ? "Today" : diff === 1 ? "Tomorrow" : d.toLocaleDateString([], { weekday: "long", day: "numeric", month: "short" });
    };
    const hm = (t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const draw = ({ events }) => {
      const now = Date.now();
      const up = events.filter((e) => e.end > now).slice(0, max);
      head.replaceChildren(ui.icon("calendar-linear", 15), up[0]?.cal || "Calendar");
      if (!up.length) { list.replaceChildren(ui.h("div", { class: "muted" }, "Nothing coming up.")); return; }
      let last = "";
      list.replaceChildren(...up.flatMap((e) => {
        const d = day(e.start), out = [];
        if (d !== last) { out.push(ui.h("div", { class: "k", style: { marginTop: last ? "4px" : "0" } }, d)); last = d; }
        out.push(ui.h("div", { style: { display: "flex", gap: "12px", alignItems: "baseline" } },
          ui.h("span", { class: "mono", style: { minWidth: "48px", color: "var(--t3)", fontSize: "13px" } }, e.allDay ? "all day" : hm(e.start)),
          ui.h("span", { style: { display: "grid", minWidth: "0" } },
            ui.h("span", { style: { fontWeight: "500", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, e.title),
            e.where ? ui.h("span", { class: "k", style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, e.where) : "")));
        return out;
      }));
    };
    const load = () => {
      if (!opts.url) { head.textContent = "Calendar"; list.replaceChildren(ui.h("div", { class: "muted" }, "Long press → Options: paste your calendar's share link.")); return; }
      api(`/api/calendar?${new URLSearchParams({ url: opts.url, days: opts.days || "7" })}`).then(draw)
        .catch((e) => { head.textContent = "Calendar"; list.replaceChildren(ui.h("div", { class: "muted" }, e.message)); });
    };
    load();
    const t = setInterval(load, 5 * 60_000);
    return { destroy() { clearInterval(t); } };
  },
};
