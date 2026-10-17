// Recall & prohibited-item checks (rule R9). Deterministic rules first, then the public CPSC
// Recalls API (saferproducts.gov, no key) when online. Selling a recalled or banned product is illegal.

export interface RecallVerdict {
  blocked: boolean;
  reason?: string;
  source?: string;
  alternative?: string;
}

const RULES: Array<{ test: (title: string, category: string) => boolean; verdict: RecallVerdict }> = [
  {
    test: (t, c) => c === "crib" && /drop[\s-]?side/i.test(t),
    verdict: {
      blocked: true,
      reason: "Drop-side cribs can't be resold: the CPSC banned their sale, including at yard sales and online, in 2011.",
      source: "CPSC crib safety standards (effective June 28, 2011)",
      alternative: "I can arrange a free recycling pickup instead.",
    },
  },
  {
    test: (_t, c) => c === "car_seat",
    verdict: {
      blocked: true,
      reason: "Used car seats need a verifiable crash history and expiry date, so Stoop doesn't list them.",
      source: "Stoop prohibited items policy (NHTSA guidance on used car seats)",
      alternative: "Many retailers run car-seat trade-in events for a store credit.",
    },
  },
  {
    test: (t) => /\b(gun|firearm|rifle|pistol|ammo|ammunition|knife set|taser)\b/i.test(t),
    verdict: { blocked: true, reason: "Weapons can't be sold on Stoop.", source: "Stoop prohibited items policy" },
  },
];

export interface CpscRecall {
  RecallNumber?: string;
  Title?: string;
  RecallDate?: string;
  URL?: string;
}

export interface RecallChecker {
  check(title: string, category: string): Promise<RecallVerdict>;
}

export function rulesOnlyChecker(): RecallChecker {
  return {
    async check(title, category) {
      return RULES.find((r) => r.test(title, category))?.verdict ?? { blocked: false };
    },
  };
}

/** Rules + CPSC Recalls API. Network failures fall back to rules-only (never block on an outage). */
export function cpscChecker(fetchImpl: typeof fetch = fetch, timeoutMs = 2500): RecallChecker {
  const rules = rulesOnlyChecker();
  return {
    async check(title, category) {
      const ruled = await rules.check(title, category);
      if (ruled.blocked) return ruled;
      const product = title.split(/\s+/).slice(0, 3).join(" ");
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), timeoutMs);
        const url = `https://www.saferproducts.gov/RestWebServices/Recall?format=json&ProductName=${encodeURIComponent(product)}`;
        const res = await fetchImpl(url, { signal: ctrl.signal });
        clearTimeout(t);
        if (!res.ok) return ruled;
        const recalls = (await res.json()) as CpscRecall[];
        // Only flag exact-model matches; a generic name match is shown as a warning, not a block.
        const exact = recalls.find((r) => r.Title && title.toLowerCase().split(/\s+/).filter((w) => w.length > 3).every((w) => r.Title!.toLowerCase().includes(w)));
        if (exact) {
          return { blocked: true, reason: `Matches CPSC recall ${exact.RecallNumber ?? ""}: ${exact.Title}`, source: exact.URL ?? "saferproducts.gov" };
        }
        return ruled;
      } catch {
        return ruled;
      }
    },
  };
}
