import { h, money, mountCard } from "../lib/card.ts";

mountCard("receipt", (data: any, { app, root }) => {
  root.append(
    h("p", { class: "eyebrow" }, "Signed receipt"),
    h("h1", {}, data.title ?? ""),
    h("div", { class: "stamp" }, `PROOF OF HANDOFF · ${data.verdict ?? ""}`),
    h("div", { class: "row" }, h("span", {}, "Sale"), h("span", { class: "num" }, money(data.amountMinor))),
    h("div", { class: "row" }, h("span", {}, "Receipt"), h("span", { class: "num" }, data.receiptId ?? "")),
    h("p", { class: "hash" }, `SHA-256 ${data.hash ?? ""}`),
    h("p", { class: "muted" }, "Hashes and timestamps only: no address, no images, no identities. Anyone can verify the ES256 signature."),
  );
  if (data.verifyUrl) {
    const btn = h("button", { class: "action" }, "Verify this receipt") as HTMLButtonElement;
    btn.onclick = () => void app.openLink({ url: data.verifyUrl });
    root.append(btn);
  }
});
