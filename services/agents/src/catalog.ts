// Offline knowledge used when no vision model / marketplace keys are configured.
// Every price here is labelled "cached asking-price comps" in the UI, with the capture date.
// Titles are generic (no brand or model names): they appear on screen in the demo and the video.

export interface CatalogEntry {
  /** Lowercase hints matched against the photo filename or a caller-supplied hint. */
  hints: string[];
  title: string;
  category: string;
  condition: "A" | "B" | "C" | "D";
  /** Cached asking prices (USD cents) for similar used items, captured 2026-10. */
  comps: Array<{ title: string; priceMinor: number; source: string }>;
}

export const COMPS_CAPTURED = "2026-10 (cached asking prices, not sold prices)";

export const CATALOG: CatalogEntry[] = [
  {
    hints: ["stroller", "jogging", "bob", "pram"],
    title: "Three-wheel jogging stroller",
    category: "stroller",
    condition: "B",
    comps: [
      { title: "Three-wheel jogging stroller, used", priceMinor: 140_00, source: "cached:marketplace" },
      { title: "Jogging stroller, good condition", priceMinor: 125_00, source: "cached:marketplace" },
      { title: "Jogging stroller, some wear", priceMinor: 99_00, source: "cached:marketplace" },
      { title: "Premium jogging stroller, like new", priceMinor: 185_00, source: "cached:marketplace" },
    ],
  },
  {
    hints: ["bike", "bicycle", "trek", "cycle"],
    title: "Hybrid bike (medium frame)",
    category: "bicycle",
    condition: "B",
    comps: [
      { title: "Hybrid bike, medium frame", priceMinor: 220_00, source: "cached:marketplace" },
      { title: "Entry-level hybrid bike", priceMinor: 160_00, source: "cached:marketplace" },
      { title: "Hybrid bike with disc brakes, used", priceMinor: 260_00, source: "cached:marketplace" },
      { title: "Hybrid commuter bike, medium", priceMinor: 180_00, source: "cached:marketplace" },
    ],
  },
  {
    hints: ["crib", "drop-side", "dropside", "cot"],
    title: "Wooden drop-side crib",
    category: "crib",
    condition: "B",
    comps: [],
  },
  {
    hints: ["carseat", "car-seat", "car_seat", "infant seat"],
    title: "Infant car seat",
    category: "car_seat",
    condition: "B",
    comps: [{ title: "Infant car seat, used", priceMinor: 40_00, source: "cached:marketplace" }],
  },
  {
    hints: ["mixer", "kitchenaid", "stand mixer"],
    title: "Tilt-head stand mixer (4.5 qt)",
    category: "kitchen",
    condition: "B",
    comps: [
      { title: "Tilt-head stand mixer, 4.5 qt", priceMinor: 120_00, source: "cached:marketplace" },
      { title: "Stand mixer, used", priceMinor: 95_00, source: "cached:marketplace" },
      { title: "Stand mixer, 5 qt", priceMinor: 160_00, source: "cached:marketplace" },
    ],
  },
  {
    hints: ["desk", "standing desk", "table"],
    title: "Standing desk (48 in, electric)",
    category: "furniture",
    condition: "B",
    comps: [
      { title: "Electric standing desk 48in", priceMinor: 150_00, source: "cached:marketplace" },
      { title: "Sit-stand desk, used", priceMinor: 110_00, source: "cached:marketplace" },
      { title: "Electric standing desk, 60in", priceMinor: 220_00, source: "cached:marketplace" },
    ],
  },
  {
    hints: ["guitar", "acoustic"],
    title: "Acoustic guitar (dreadnought)",
    category: "music",
    condition: "B",
    comps: [
      { title: "Dreadnought acoustic guitar", priceMinor: 130_00, source: "cached:marketplace" },
      { title: "Acoustic guitar, used", priceMinor: 110_00, source: "cached:marketplace" },
      { title: "Acoustic guitar, solid top", priceMinor: 160_00, source: "cached:marketplace" },
    ],
  },
];

export function matchCatalog(hint: string): CatalogEntry | undefined {
  const h = hint.toLowerCase();
  return CATALOG.find((e) => e.hints.some((x) => h.includes(x)));
}
