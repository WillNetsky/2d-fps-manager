// Country pool for player generation. Weighted CS-heavy with a long tail of
// less common scenes — picking feels authentic but not monocultural.
//
// Each entry maps to a faker locale module that supplies first/last names with
// the right cultural flavor. Locales are loaded on demand via a dynamic lookup
// at call time (see factory.ts) so we don't drag the whole faker locale tree
// into the bundle eagerly.

import {
  fakerCS_CZ, fakerDA, fakerDE, fakerEN, fakerEN_AU, fakerEN_CA, fakerEN_GB,
  fakerES, fakerFI, fakerFR, fakerHR, fakerID_ID, fakerIT, fakerJA, fakerKO,
  fakerNB_NO, fakerNL, fakerPL, fakerPT_BR, fakerRO, fakerRU, fakerSV, fakerTR,
  fakerUK, fakerZH_CN, type Faker,
} from "@faker-js/faker";

// Competitive CS regions. Players only matchmake within their own region, so
// every country maps to exactly one. Order here is the canonical display order.
export type Region = "EU" | "CIS" | "NA" | "SA" | "ASIA" | "OCE";

export const REGION_ORDER: Region[] = ["EU", "CIS", "NA", "SA", "ASIA", "OCE"];

export const REGION_LABELS: Record<Region, string> = {
  EU: "Europe",
  CIS: "CIS",
  NA: "North America",
  SA: "South America",
  ASIA: "Asia",
  OCE: "Oceania",
};

export interface Country {
  code: string;   // ISO-3166 alpha-2 (used for flag emoji + storage)
  name: string;
  faker: Faker;
  weight: number; // relative pick weight
  region: Region;
}

// Weights are tuned so the CS scene dominates but the long tail still surfaces.
// Big scenes (~10), strong regulars (~6), occasional (~3), rare (~1).
export const COUNTRIES: Country[] = [
  // --- Tier 1: CS heavyweights ---
  { code: "SE", name: "Sweden",         faker: fakerSV,    weight: 10, region: "EU"  },
  { code: "DK", name: "Denmark",        faker: fakerDA,    weight: 10, region: "EU"  },
  { code: "RU", name: "Russia",         faker: fakerRU,    weight: 10, region: "CIS" },
  { code: "UA", name: "Ukraine",        faker: fakerUK,    weight: 9,  region: "CIS" },
  { code: "BR", name: "Brazil",         faker: fakerPT_BR, weight: 10, region: "SA"  },
  { code: "US", name: "United States",  faker: fakerEN,    weight: 9,  region: "NA"  },
  { code: "FR", name: "France",         faker: fakerFR,    weight: 8,  region: "EU"  },
  { code: "PL", name: "Poland",         faker: fakerPL,    weight: 8,  region: "EU"  },
  { code: "FI", name: "Finland",        faker: fakerFI,    weight: 7,  region: "EU"  },
  { code: "DE", name: "Germany",        faker: fakerDE,    weight: 7,  region: "EU"  },
  // --- Tier 2: regular contenders ---
  { code: "NO", name: "Norway",         faker: fakerNB_NO, weight: 5,  region: "EU"  },
  { code: "GB", name: "United Kingdom", faker: fakerEN_GB, weight: 5,  region: "EU"  },
  { code: "CA", name: "Canada",         faker: fakerEN_CA, weight: 5,  region: "NA"  },
  { code: "AU", name: "Australia",      faker: fakerEN_AU, weight: 4,  region: "OCE" },
  { code: "KZ", name: "Kazakhstan",     faker: fakerRU,    weight: 4,  region: "CIS" },
  { code: "CZ", name: "Czechia",        faker: fakerCS_CZ, weight: 4,  region: "EU"  },
  { code: "TR", name: "Turkey",         faker: fakerTR,    weight: 4,  region: "EU"  },
  { code: "NL", name: "Netherlands",    faker: fakerNL,    weight: 4,  region: "EU"  },
  // --- Tier 3: occasional ---
  { code: "KR", name: "South Korea",    faker: fakerKO,    weight: 2,  region: "ASIA" },
  { code: "CN", name: "China",          faker: fakerZH_CN, weight: 2,  region: "ASIA" },
  { code: "JP", name: "Japan",          faker: fakerJA,    weight: 2,  region: "ASIA" },
  { code: "ES", name: "Spain",          faker: fakerES,    weight: 2,  region: "EU"  },
  { code: "IT", name: "Italy",          faker: fakerIT,    weight: 2,  region: "EU"  },
  { code: "ID", name: "Indonesia",      faker: fakerID_ID, weight: 2,  region: "ASIA" },
  // --- Tier 4: long tail (rare but possible) ---
  { code: "HR", name: "Croatia",        faker: fakerHR,    weight: 1,  region: "EU"  },
  { code: "RO", name: "Romania",        faker: fakerRO,    weight: 1,  region: "EU"  },
];

// code → region lookup, built once. Unknown codes fall back to EU so legacy
// saves never produce an orphaned, unmatchable player.
const REGION_BY_CODE: Record<string, Region> =
  Object.fromEntries(COUNTRIES.map(c => [c.code, c.region]));

export function regionOf(code: string): Region {
  return REGION_BY_CODE[code] ?? "EU";
}

export function pickCountry(rand: () => number): Country {
  const total = COUNTRIES.reduce((s, c) => s + c.weight, 0);
  let r = rand() * total;
  for (const c of COUNTRIES) {
    r -= c.weight;
    if (r <= 0) return c;
  }
  return COUNTRIES[0];
}

// Regional-indicator flag emoji from a 2-letter ISO code. Renders as a flag
// on platforms with emoji support, falls back to letters elsewhere.
export function flagEmoji(code: string): string {
  if (code.length !== 2) return "";
  const A = 0x1F1E6;
  const a = "A".charCodeAt(0);
  return String.fromCodePoint(A + code.charCodeAt(0) - a) +
         String.fromCodePoint(A + code.charCodeAt(1) - a);
}
