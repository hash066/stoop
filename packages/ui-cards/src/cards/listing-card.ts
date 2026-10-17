import { h, money, mountCard } from "../lib/card.ts";

interface L {
  listingId: string;
  title: string;
  askMinor: number;
  zip?: string;
  state?: string;
}

mountCard("listing-card", (data: { kind?: string; listings?: L[]; results?: L[]; title?: string; askMinor?: number }, { root }) => {
  if (data.kind === "mandate") {
    root.append(h("p", { class: "eyebrow" }, "Lowest price set"), h("h1", {}, data.title ?? ""), h("p", { class: "muted" }, `Asking ${money(data.askMinor)}. Your minimum stays private: buyers and the AI never see it.`));
    return;
  }
  const list = data.results ?? data.listings ?? [];
  if (!list.length) {
    root.append(h("p", { class: "eyebrow" }, "Stoop"), h("h1", {}, "Nothing here yet"));
    return;
  }
  const [first, ...rest] = list;
  const live = first!.state === "LIVE";
  root.append(
    h("p", { class: "eyebrow" }, data.results ? "Porch pickup near you" : live ? "Live on Stoop" : "Ready to list"),
    h("h1", {}, first!.title),
    h("div", { class: "row" }, h("span", { class: "big" }, money(first!.askMinor)), h("span", { class: `pill ${live || data.results ? "ok" : "amber"}` }, data.results ? `ZIP ${first!.zip ?? ""}` : live ? "Live" : "Awaiting approval")),
    h("p", { class: "muted" }, "Contactless porch pickup. Payment is held until the doorbell verifies the handoff."),
  );
  for (const l of rest.slice(0, 4)) root.append(h("div", { class: "row" }, h("span", {}, l.title), h("span", { class: "num" }, money(l.askMinor))));
});
