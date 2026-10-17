// Offline knowledge used when no vision model / marketplace keys are configured.
// Every price here is labelled "cached asking-price comps" in the UI, with the capture date.

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
    title: "BOB Revolution jogging stroller",
    category: "stroller",
    condition: "B",
    comps: [
      { title: "BOB Revolution Flex 3.0 jogging stroller, used", priceMinor: 135_00, source: "cached:marketplace" },
      { title: "BOB Revolution SE stroller, good condition", priceMinor: 110_00, source: "cached:marketplace" },
      { title: "BOB jogging stroller, some wear", priceMinor: 95_00, source: "cached:marketplace" },
      { title: "BOB Revolution Pro, like new", priceMinor: 180_00, source: "cached:marketplace" },
    ],
  },
  {
    hints: ["bike", "bicycle", "trek", "cycle"],
    title: "Trek FX 2 hybrid bike (medium)",
    category: "bicycle",
    condition: "B",
    comps: [
      { title: "Trek FX 2 hybrid, medium frame", priceMinor: 220_00, source: "cached:marketplace" },
      { title: "Trek FX 1 hybrid bike", priceMinor: 160_00, source: "cached:marketplace" },
      { title: "Trek FX 2 Disc, used", priceMinor: 260_00, source: "cached:marketplace" },
      { title: "Hybrid commuter bike, Trek, medium", priceMinor: 180_00, source: "cached:marketplace" },
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
    title: "KitchenAid stand mixer (4.5 qt)",
    category: "kitchen",
    condition: "B",
    comps: [
      { title: "KitchenAid Classic 4.5qt stand mixer", priceMinor: 120_00, source: "cached:marketplace" },
      { title: "KitchenAid stand mixer, used", priceMinor: 95_00, source: "cached:marketplace" },
      { title: "KitchenAid Artisan 5qt", priceMinor: 160_00, source: "cached:marketplace" },
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
      { title: "Uplift standing desk", priceMinor: 220_00, source: "cached:marketplace" },
    ],
  },
  {
    hints: ["guitar", "acoustic"],
    title: "Yamaha FG800 acoustic guitar",
    category: "music",
    condition: "B",
    comps: [
      { title: "Yamaha FG800 acoustic", priceMinor: 130_00, source: "cached:marketplace" },
      { title: "Yamaha acoustic guitar, used", priceMinor: 110_00, source: "cached:marketplace" },
      { title: "Yamaha FG820", priceMinor: 160_00, source: "cached:marketplace" },
    ],
  },
];

export function matchCatalog(hint: string): CatalogEntry | undefined {
  const h = hint.toLowerCase();
  return CATALOG.find((e) => e.hints.some((x) => h.includes(x)));
}
