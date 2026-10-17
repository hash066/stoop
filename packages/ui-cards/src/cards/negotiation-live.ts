import { h, money, mountCard } from "../lib/card.ts";

const STATUS: Record<string, [string, string]> = {
  counter: ["Counter-offer", "amber"],
  awaiting_seller: ["Owner deciding", "amber"],
  accepted: ["Deal", "ok"],
  declined: ["Too low", "bad"],
  refused: ["Refused by policy", "bad"],
  blocked: ["Blocked", "bad"],
  answered: ["Answered", "amber"],
};

mountCard("negotiation-live", (data: { title?: string; askMinor?: number; action?: string; reply?: string; ladder?: Array<{ by: string; amountMinor: number }> }, { root }) => {
  const [label, tone] = STATUS[data.action ?? "answered"] ?? ["", "amber"];
  root.append(h("p", { class: "eyebrow" }, "Negotiation · seller's AI assistant"), h("h1", {}, data.title ?? ""), h("span", { class: `pill ${tone}` }, label));
  const ladder = data.ladder ?? [];
  const max = Math.max(data.askMinor ?? 0, ...ladder.map((o) => o.amountMinor), 1);
  if (ladder.length) {
    const ul = h("ul", { class: "ladder" });
    ladder.forEach((o, i) => {
      const li = h("li", { class: o.by, style: `animation-delay:${i * 120}ms` }, h("span", { class: "who" }, o.by === "buyer" ? "Buyer" : "Seller AI"), h("span", { class: "bar" }, h("i", { style: `width:${Math.round((o.amountMinor / max) * 100)}%` })), h("span", { class: "num" }, money(o.amountMinor)));
      ul.append(li);
    });
    root.append(ul, h("div", { class: "row muted" }, h("span", {}, "Asking"), h("span", { class: "num" }, money(data.askMinor))));
  }
  if (data.reply) root.append(h("p", { class: "quote" }, data.reply));
});
