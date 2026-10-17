import { h, money, mountCard } from "../lib/card.ts";

interface Item {
  itemId: string;
  title: string;
  condition: string;
  listMinor: number;
  quickSaleMinor: number;
  comps: number;
  confidence: string;
  blocked: boolean;
  blockedReason?: string;
}

mountCard("appraisal-grid", (data: { items?: Item[]; totalListMinor?: number; compsSource?: string; identifier?: string }, { app, root }) => {
  const items = data.items ?? [];
  const sellable = items.filter((i) => !i.blocked);
  root.append(
    h("p", { class: "eyebrow" }, "Your garage, appraised"),
    h("div", { class: "big" }, money(data.totalListMinor ?? 0)),
    h("p", { class: "muted" }, `${sellable.length} sellable item${sellable.length === 1 ? "" : "s"} · prices from ${data.compsSource === "cached-asking-prices" ? "cached asking prices" : (data.compsSource ?? "comps")}`),
  );
  const grid = h("div", { class: "grid" });
  for (const it of items) {
    grid.append(
      h(
        "div",
        { class: `tile${it.blocked ? " blocked" : ""}` },
        h("div", { class: "t" }, it.title),
        it.blocked
          ? h("div", {}, h("span", { class: "pill bad" }, "Can't be sold"), h("p", { class: "muted", style: "font-size:13px;margin:6px 0 0" }, it.blockedReason ?? ""))
          : h("div", {}, h("div", { class: "num", style: "font-size:22px;margin-top:6px" }, money(it.listMinor)), h("div", { class: "muted", style: "font-size:13px" }, `Cond. ${it.condition} · ${it.comps} comps${it.confidence === "low" ? " · low confidence" : ""}`)),
      ),
    );
  }
  root.append(grid);
  if (sellable.length) {
    const btn = h("button", { class: "action" }, `Sell ${sellable.length === 1 ? "it" : `all ${sellable.length}`}`) as HTMLButtonElement;
    btn.onclick = async () => {
      btn.disabled = true;
      btn.textContent = "Asking for your approval…";
      await app.callServerTool({ name: "list_items", arguments: { items: sellable.slice(0, 5).map((i) => i.itemId) } });
      btn.textContent = "Done";
    };
    root.append(btn);
  }
});
