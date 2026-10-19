import { clock, h, money, mountCard } from "../lib/card.ts";

type Step = { label: string; detail?: string; status: "done" | "now" | "todo" | "fail" };

const ORDER = ["AGREED", "CHECKOUT_OPEN", "FUNDS_HELD", "PASS_ISSUED", "WINDOW_OPEN", "VERIFIED", "INSPECTION", "CAPTURED", "PAYOUT_RECORDED", "CLOSED"];

mountCard("handoff-timeline", (data: any, { root }) => {
  const deal = data.deal;
  if (!deal) {
    root.append(h("p", { class: "eyebrow" }, "Sale status"), h("h1", {}, "No sale in progress"));
    return;
  }
  const ev = deal.evidence ?? {};
  const reached = (s: string) => ORDER.indexOf(deal.state) >= ORDER.indexOf(s) || deal.history?.some((x: { state: string }) => x.state === s);
  const failed = ["VOIDED", "NO_SHOW", "PIRACY_SUSPECTED"].includes(deal.state);
  const presence = (ev.ringEvents ?? []).find((e: { kind: string; subType?: string }) => e.kind === "button_press" || !["vehicle", "package_delivery", "other_motion"].includes(e.subType ?? ""));
  const verified = reached("VERIFIED");
  const steps: Step[] = [
    { label: "Payment held", detail: money(deal.amountMinor), status: reached("FUNDS_HELD") ? "done" : "now" },
    { label: "Pickup pass sent", status: reached("PASS_ISSUED") ? "done" : "todo" },
    { label: "Window open", detail: deal.window ? `${clock(deal.window.start)}–${clock(deal.window.end)}` : undefined, status: reached("WINDOW_OPEN") ? "done" : "todo" },
    { label: "Item on porch (before)", detail: ev.before ? `${ev.before.presence} · ${ev.before.origin === "our_footage" ? "our footage" : ev.before.origin}` : undefined, status: ev.before?.presence === "present" ? "done" : reached("WINDOW_OPEN") ? "now" : "todo" },
    { label: "Buyer checked in", detail: ev.checkInAt ? clock(ev.checkInAt) : undefined, status: ev.checkInAt ? "done" : reached("WINDOW_OPEN") ? "now" : "todo" },
    { label: "Camera saw them", detail: presence ? `${presence.kind === "button_press" ? "doorbell press" : presence.subType} · ${presence.origin === "simulator" ? "simulator-signed" : presence.origin === "porchcam" ? "porch camera" : "Ring"}` : undefined, status: presence ? "done" : "todo" },
    { label: "Item gone (after)", detail: ev.after ? ev.after.presence : undefined, status: ev.after?.presence === "absent" ? "done" : ev.after?.presence === "present" ? "fail" : "todo" },
    { label: "Verified · receipt signed", status: verified ? "done" : failed ? "fail" : "todo" },
    { label: "Money released", status: reached("CAPTURED") ? "done" : verified ? "now" : "todo" },
  ];
  root.append(h("p", { class: "eyebrow" }, "Proof of handoff"), h("h1", {}, deal.title));
  if (verified && !failed) root.append(h("div", { class: "stamp" }, deal.state === "CLOSED" ? "SOLD · PAID" : "VERIFIED"));
  if (failed) root.append(h("div", { class: "stamp bad" }, deal.verdict === "PIRACY_SUSPECTED" ? "NOT RELEASED · ALERT" : "HOLD RELEASED"));
  const ul = h("ul", { class: "steps" });
  for (const s of steps) ul.append(h("li", { class: s.status }, h("span", { class: "dot" }), h("span", {}, s.label), h("span", { class: "num muted", style: "font-size:13px" }, s.detail ?? "")));
  root.append(ul);
  if (ev.camera && ev.camera !== "ok") root.append(h("p", { class: "muted" }, `Camera ${ev.camera}: both sides confirm instead (up to $150).`));
});
