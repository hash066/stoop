// Proactive notifications for the two Alexa+ sims (the "notification light"). On real Alexa+ these
// would be proactive events; locally they are SSE streams filtered per actor.
import { inSentence } from "@stoop/shared";
import type { EventBus, PickupPrefs, Settlement, StoopEvent } from "./deps.ts";

export interface Notification {
  to: string; // "seller:<householdId>" | "buyer:<buyerId>"
  kind: string;
  text: string;
  data: Record<string, unknown>;
  at: number;
}

const $ = (minor: number) => `$${(minor / 100).toFixed(minor % 100 ? 2 : 0)}`;

export class NotificationHub {
  private listeners = new Set<(n: Notification) => void>();
  private recent: Notification[] = [];

  constructor(
    private s: Settlement,
    bus: EventBus,
    private prefs: { get(hh: string): Promise<PickupPrefs | undefined> },
  ) {
    bus.on((e) => void this.route(e).catch(() => undefined));
  }

  on(fn: (n: Notification) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  history(to: string) {
    return this.recent.filter((n) => n.to === to).slice(-20);
  }

  private push(n: Omit<Notification, "at">, at: number) {
    const full = { ...n, at };
    this.recent.push(full);
    if (this.recent.length > 500) this.recent.shift();
    for (const l of this.listeners) l(full);
  }

  private async route(e: StoopEvent) {
    switch (e.type) {
      case "approval_requested": {
        const approver = String(e.approver ?? "");
        if (!approver.startsWith("seller:")) return;
        const appr = await this.s.getApproval(String(e.approvalId));
        if (appr.terms.action !== "accept_offer") return;
        const hh = approver.slice(7);
        const prefs = await this.prefs.get(hh);
        const listing = await this.s.getListing(appr.terms.listingId!);
        const text = `${appr.terms.buyerPseudonym} offers ${$(appr.terms.amountMinor!)} for the ${inSentence(listing.title)}${prefs ? `, pickup ${prefs.label} like last time` : ""}. Accept?`;
        this.push({ to: approver, kind: "offer", text, data: { approvalId: appr.id, listingId: listing.id } }, e.at);
        return;
      }
      case "deal_created": {
        const deal = await this.s.getDeal(String(e.dealId));
        this.push({ to: `buyer:${deal.buyerId}`, kind: "deal", text: `The owner accepted ${$(deal.amountMinor)} for the ${inSentence(deal.itemTitle)}. Say check out to pay.`, data: { dealId: deal.id } }, e.at);
        return;
      }
      case "pass_issued": {
        const deal = await this.s.getDeal(String(e.dealId));
        this.push({ to: `buyer:${deal.buyerId}`, kind: "pass", text: "Your pickup pass is ready. Say send my pickup pass to open it on your phone.", data: { dealId: deal.id } }, e.at);
        return;
      }
      case "handoff_verified": {
        const deal = await this.s.getDeal(String(e.dealId));
        this.push({ to: `seller:${deal.householdId}`, kind: "verified", text: `Your doorbell verified the pickup of the ${inSentence(deal.itemTitle)}.`, data: { dealId: deal.id } }, e.at);
        this.push({ to: `buyer:${deal.buyerId}`, kind: "verified", text: "Pickup verified. Tap got it on your pass once you've checked the item.", data: { dealId: deal.id } }, e.at);
        return;
      }
      case "sale_completed": {
        const deal = await this.s.getDeal(String(e.dealId));
        this.push({ to: `seller:${deal.householdId}`, kind: "sold", text: `Sold. ${$(Number(e.payoutMinor))} is on its way to you.`, data: { dealId: deal.id } }, e.at);
        this.push({ to: `buyer:${deal.buyerId}`, kind: "sold", text: `All done. Enjoy the ${inSentence(deal.itemTitle)}!`, data: { dealId: deal.id } }, e.at);
        return;
      }
      case "piracy_alert": {
        const deal = await this.s.getDeal(String(e.dealId));
        this.push({ to: `seller:${deal.householdId}`, kind: "alert", text: `Heads up: your ${inSentence(deal.itemTitle)} was taken without a verified pickup. No money moved and I saved the doorbell evidence.`, data: { dealId: deal.id } }, e.at);
        return;
      }
      case "no_show": {
        const deal = await this.s.getDeal(String(e.dealId));
        this.push({ to: `seller:${deal.householdId}`, kind: "no_show", text: `The buyer didn't show up for the ${inSentence(deal.itemTitle)}. It's listed again.`, data: { dealId: deal.id } }, e.at);
        this.push({ to: `buyer:${deal.buyerId}`, kind: "no_show", text: "Your pickup window closed, so your payment hold was released.", data: { dealId: deal.id } }, e.at);
        return;
      }
      case "item_still_there": {
        const deal = await this.s.getDeal(String(e.dealId));
        this.push({ to: `buyer:${deal.buyerId}`, kind: "still_there", text: "The camera still sees the item on the porch. Grab it and I'll verify again.", data: { dealId: deal.id } }, e.at);
        return;
      }
      case "handoff_review": {
        const deal = await this.s.getDeal(String(e.dealId));
        this.push({ to: `seller:${deal.householdId}`, kind: "review", text: "I couldn't verify the pickup with the camera. If the buyer has it, say confirm pickup.", data: { dealId: deal.id } }, e.at);
        return;
      }
    }
  }
}
