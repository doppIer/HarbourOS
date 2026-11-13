export default {
  title: "Power",
  sizes: ["s", "m"],
  mount(el, { ui }) {
    const num = ui.bigNumber(el, { label: "Power · estimate", unit: " W" });
    const sub = ui.h("div", { class: "k mono" });
    el.append(sub);
    const spark = ui.sparkline(el, { color: ui.theme.cream, height: 26 });
    return {
      update({ stats, history }) {
        const p = stats.power;
        num.set(Math.round(p.watts));
        sub.textContent = `${p.kwhToday.toFixed(2)} kWh today · ~${p.currency}${p.monthlyCost.toFixed(2)}/mo`;
        sub.title = p.source === "plug" ? "Measured by smart plug" : "Estimate: Intel RAPL package power + configured baseline";
        spark.set(history.watts);
      },
    };
  },
};
