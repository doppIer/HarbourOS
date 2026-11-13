// Big layered area chart (RAM / CPU / Network) with a hover crosshair and a
// "Trend analyzer" card. Swap the series or the card text to taste.
export default {
  title: "System load",
  sizes: ["l", "w", "m"],
  mount(el, { ui, size }) {
    el.style.margin = "-12px -14px";
    el.style.position = "relative";
    const head = ui.h("div", { style: { position: "absolute", top: "14px", left: "18px", zIndex: 1, pointerEvents: "none" } },
      ui.h("div", { style: { fontWeight: "600", fontSize: "14px" } }, "System load"),
      ui.h("div", { class: "k" }, "last 30 min · hover for details"));
    const leg = ui.h("div", { style: { position: "absolute", bottom: "14px", left: "18px", zIndex: 1, pointerEvents: "none" } });
    ui.legend(leg, [{ label: "RAM", color: ui.theme.teal }, { label: "CPU", color: ui.theme.violet }, { label: "Network", color: ui.theme.green }]);
    const plot = ui.h("div", { style: { position: "absolute", inset: "0" } });
    el.append(plot, head, leg);

    let watts = [];
    const chart = ui.area(plot, {
      max: 100,
      trend: (i, s) => ({
        title: "Trend analyzer",
        value: `${(watts[i] ?? 0).toFixed(1)} W`,
        lines: [`CPU ${s[1].data[i].toFixed(1)}% · RAM ${s[0].data[i].toFixed(0)}%`, `Network ${s[2].data[i].toFixed(0)}% of peak`],
      }),
    });
    return {
      update({ history }) {
        const peak = Math.max(1, ...history.rx.map((v, i) => v + (history.tx[i] ?? 0)));
        const netPct = history.rx.map((v, i) => ((v + (history.tx[i] ?? 0)) / peak) * 60);
        const n = Math.min(48, history.cpu.length);
        watts = history.watts.length > n ? sample(history.watts, n) : history.watts;
        chart.set([
          { label: "RAM", color: ui.theme.teal, data: history.mem },
          { label: "CPU", color: ui.theme.violet, data: history.cpu },
          { label: "Network", color: ui.theme.green, data: netPct },
        ]);
      },
    };
  },
};
function sample(a, n) { const out = [], step = a.length / n; for (let i = 0; i < n; i++) out.push(a[Math.floor(i * step)]); return out; }
