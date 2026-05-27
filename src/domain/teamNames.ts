// Org-style team name generator. Produces names shaped like real esports orgs —
// "Vortex", "Team Eclipse", "Nordic Vipers", "Apex Esports", "9Kings" — rather
// than gamer handles (see usernames.ts for those). Tracks issued names so a
// universe never fields two teams with the same name.

const NOUNS = [
  "Vipers", "Wolves", "Ravens", "Titans", "Dragons", "Phantoms", "Sentinels", "Outlaws",
  "Reapers", "Knights", "Spectres", "Hunters", "Vandals", "Renegades", "Legion", "Dynasty",
  "Empire", "Syndicate", "Collective", "Union", "Order", "Pulse", "Surge", "Vortex",
  "Eclipse", "Nova", "Comet", "Meteor", "Storm", "Tempest", "Thunder", "Frost", "Inferno",
  "Mirage", "Apex", "Zenith", "Vertex", "Cipher", "Echo", "Catalyst", "Momentum", "Velocity",
  "Fnatics", "Liquids", "Falcons", "Cloud", "Astra", "Vitality", "Heroic", "Furia",
];

const ADJECTIVES = [
  "Nordic", "Crimson", "Azure", "Golden", "Iron", "Shadow", "Royal", "Eternal", "Savage",
  "Rogue", "Phantom", "Frozen", "Electric", "Lunar", "Solar", "Wild", "Silent", "Rising",
  "Atomic", "Cosmic", "Digital", "Quantum", "Toxic", "Brutal", "Elite", "Prime",
];

// Org suffixes that turn a stem into a full org name. No "Team" — crystallized
// orgs must never read like the "Team_Handle" labels used for pickup lobbies.
const SUFFIXES = ["Esports", "Gaming", "eSports", "GG", "Squad", "Five", "Club"];

function pickFrom<T>(arr: T[], rand: () => number): T {
  return arr[Math.floor(rand() * arr.length)];
}

function rollName(rand: () => number): string {
  const r = rand();
  if (r < 0.38) {
    // "Nordic Vipers"
    return `${pickFrom(ADJECTIVES, rand)} ${pickFrom(NOUNS, rand)}`;
  }
  if (r < 0.68) {
    // "Vortex Esports"
    return `${pickFrom(NOUNS, rand)} ${pickFrom(SUFFIXES, rand)}`;
  }
  if (r < 0.86) {
    // "9Kings" / "5Vipers" — number-prefixed, single token
    return `${1 + Math.floor(rand() * 9)}${pickFrom(NOUNS, rand)}`;
  }
  // Bare single word — "Vortex", "Eclipse"
  return pickFrom(NOUNS, rand);
}

const used = new Set<string>();

// Reset the uniqueness ledger. Call at the start of a fresh universe.
export function resetTeamNames(): void {
  used.clear();
}

// Seed the ledger with names already in use (e.g. when loading a saved universe
// that has teams) so newly crystallized teams don't collide with existing ones.
export function reserveTeamNames(names: Iterable<string>): void {
  for (const n of names) used.add(n);
}

// Produce a unique org-style team name. Re-rolls on collision; falls back to a
// numeric tail once reasonable variation is exhausted.
export function generateTeamName(rand: () => number): string {
  for (let i = 0; i < 40; i++) {
    const n = rollName(rand);
    if (!used.has(n)) { used.add(n); return n; }
  }
  let i = 2;
  while (true) {
    const candidate = `${rollName(rand)} ${i}`;
    if (!used.has(candidate)) { used.add(candidate); return candidate; }
    i++;
  }
}
