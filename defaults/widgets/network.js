export default {
  title: "Network",
  sizes: ["m", "l"],
  mount(el, { ui }) {
    const row = ui.h("div", { style: { display: "flex", gap: "24px", alignItems: "baseline" } });
    el.append(ui.h("div", { class: "k" }, "Network"), row);
    const down = ui.bigNumber(row, { size: 26 }), up = ui.bigNumber(row, { size: 26 });
    const sub = ui.h("div", { class: "k mono" });
    el.append(sub);
    const spark = ui.sparkline(el, { color: ui.theme.teal, height: 34 });
    return {
      update({ stats, history }) {
        const d = ui.fmt.rate(stats.net.rx), u = ui.fmt.rate(stats.net.tx);
        down.set("↓ " + d.v, " " + d.u); up.set("↑ " + u.v, " " + u.u);
        const ts = stats.tailscale;
        sub.textContent = `today ↓ ${ui.fmt.bytes(stats.net.rxToday)} ↑ ${ui.fmt.bytes(stats.net.txToday)} · tailscale ${ts?.online ? "● up" : "○ down"}${ts?.ip ? " " + ts.ip : ""}`;
        spark.set(history.rx);
      },
    };
  },
};
