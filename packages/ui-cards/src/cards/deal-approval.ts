import { add, h, money, mountCard } from "../lib/card.ts";

interface Offer {
  approvalId: string;
  title: string;
  amountMinor: number;
  askMinor: number;
  buyer: string;
}

mountCard("deal-approval", (data: any, { app, root }) => {
  if (data.kind === "checkout") {
    add(root, 
      h("p", { class: "eyebrow" }, "Confirm purchase"),
      h("h1", {}, data.title ?? ""),
      h("div", { class: "row" }, h("span", {}, "Item"), h("span", { class: "num" }, money(data.itemMinor))),
      h("div", { class: "row" }, h("span", {}, "Verified pickup"), h("span", { class: "num" }, money(data.feeMinor))),
      h("div", { class: "row" }, h("span", {}, "Tax"), h("span", { class: "num" }, money(data.taxMinor))),
      h("div", { class: "row" }, h("strong", {}, "Total"), h("strong", { class: "num" }, money(data.totalMinor))),
      h("p", { class: "muted" }, "Held, not charged, until your pickup is verified. Not verified: never charged."),
      data.needsVoiceCode ? h("span", { class: "pill amber" }, "Over $100 · purchase code needed") : null,
    );
    return;
  }
  if (data.kind === "offer") {
    add(root, 
      h("p", { class: "eyebrow" }, "Offer"),
      h("h1", {}, data.title ?? "Offer"),
      h("div", { class: "big" }, money(data.amountMinor)),
      h("div", { class: "row" }, h("span", {}, "You receive"), h("span", { class: "num" }, money(data.amountMinor - (data.feeMinor ?? 0)))),
      h("div", { class: "row" }, h("span", {}, "Buyer"), h("span", {}, data.buyer ?? "")),
      data.pickup ? h("div", { class: "row" }, h("span", {}, "Pickup"), h("span", {}, data.pickup)) : null,
    );
    return;
  }
  const offers: Offer[] = data.offers ?? [];
  if (!offers.length) {
    add(root, h("p", { class: "eyebrow" }, "Offers"), h("h1", {}, "No offers waiting"));
    return;
  }
  const o = offers[0]!;
  add(root, 
    h("p", { class: "eyebrow" }, `Offer${offers.length > 1 ? ` · 1 of ${offers.length}` : ""}`),
    h("h1", {}, o.title),
    h("div", { class: "big" }, money(o.amountMinor)),
    h("div", { class: "row" }, h("span", {}, "Buyer"), h("span", {}, o.buyer)),
    data.pickup ? h("div", { class: "row" }, h("span", {}, "Pickup"), h("span", {}, `${data.pickup} (your usual)`)) : null,
  );
  const btn = h("button", { class: "action" }, "Accept") as HTMLButtonElement;
  btn.onclick = async () => {
    btn.disabled = true;
    await app.callServerTool({ name: "respond_to_offer", arguments: { decision: "accept", approvalId: o.approvalId } });
    btn.textContent = "Accepted";
  };
  add(root, btn);
});
