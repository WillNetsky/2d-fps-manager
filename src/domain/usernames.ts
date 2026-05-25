// l33t-speak username generator. Picks a noun (sometimes a noun + qualifier)
// and applies random letter substitutions plus the occasional suffix to get
// something gamer-handle shaped — "z3r0", "n1ghtfox", "v0idK1ng", etc.
//
// Tracks issued names so callers can guarantee uniqueness across a universe.

const NOUNS = [
  "ace","ash","atom","axe","bane","bear","beast","bird","blade","blaze","blitz","blood","boar",
  "bolt","boom","brick","bug","bull","burn","byte","cat","chaos","chrome","cinder","cipher","claw",
  "cloud","coil","cobra","comet","crash","crow","crown","cyber","dart","dash","dawn","death","demon",
  "devil","diesel","dire","doom","drift","drone","dusk","eagle","echo","edge","ember","exile","fade",
  "fang","fate","fear","feral","fire","fist","flame","flash","flux","fog","fox","fury","ghost","glitch",
  "gloom","glow","gold","grim","gust","hack","hail","hawk","haze","heart","hex","hive","hollow","host",
  "howl","husk","ice","idol","iron","jade","jet","karma","king","knight","lance","laser","leap","lich",
  "limit","lion","lobo","logic","lone","lord","lost","loud","luna","lynx","mace","mage","mask","matrix",
  "maze","mech","mind","mist","moon","mute","myth","neon","nerve","nest","null","ocean","omega","onyx",
  "orbit","owl","pact","panic","peak","phantom","phase","pike","pixel","plague","plasma","prime","prism",
  "proxy","pulse","punk","quartz","quasar","quick","racer","rage","raid","rain","raven","raze","rebel",
  "reflex","rift","riot","rip","river","rogue","root","rune","rush","sable","saint","sand","savage",
  "scar","scope","seer","serpent","shade","shadow","shard","shark","shift","shock","shrike","silent",
  "silk","skull","sky","slash","slate","sleet","slime","smoke","snake","snipe","sonic","soul","spark",
  "spear","spectre","speed","spike","spirit","spite","stalker","star","static","steel","sting","stone",
  "storm","strike","sun","swarm","swift","sword","talon","tempest","thorn","thunder","tide","titan",
  "torch","torque","toxic","trace","trick","triton","truth","turret","umbra","valor","vapor","veil",
  "venom","verse","vex","viper","virus","vision","void","vortex","wake","warden","wasp","watcher","wave",
  "wing","wisp","wolf","wraith","wrath","yeti","zenith","zero","zone",
];

const PREFIXES = ["", "", "", "x", "the", "mr", "dr", "lil", "big", "dark", "neo", "cyber", "old"];
const SUFFIXES = ["", "", "", "", "x", "z", "y", "ie", "er", "or", "ino", "san", "kid"];

function applyLeet(word: string, intensity: number, rand: () => number): string {
  // Light leet — only the canonical vowel swaps. No symbols, no z/b/g
  // substitutions. Aim is "l3et speak" not "|<3wL h4xX0rz".
  const subs: Record<string, string> = { e: "3", o: "0", i: "1" };
  let out = "";
  for (const ch of word) {
    const lower = ch.toLowerCase();
    if (subs[lower] && rand() < intensity) {
      out += subs[lower];
    } else {
      out += ch;
    }
  }
  return out;
}

function pickFrom<T>(arr: T[], rand: () => number): T {
  return arr[Math.floor(rand() * arr.length)];
}

function rollHandle(rand: () => number): string {
  const noun = pickFrom(NOUNS, rand);
  const second = rand() < 0.25 ? pickFrom(NOUNS, rand) : "";
  const prefix = rand() < 0.18 ? pickFrom(PREFIXES, rand) : "";
  const suffix = rand() < 0.35 ? pickFrom(SUFFIXES, rand) : "";

  const stem = `${prefix}${noun}${second}${suffix}`;
  // Most names get no leet at all; a chunk get one swap. Keeps it readable.
  const intensity = rand() < 0.5 ? 0.35 : 0.0;
  let h = applyLeet(stem, intensity, rand);

  // Occasional trailing digits.
  if (rand() < 0.15) h += String(Math.floor(rand() * 100));
  return h;
}

const used = new Set<string>();

// Reset the uniqueness ledger. Call at the start of a fresh universe so reused
// handles from previous generations don't trigger needless re-rolls.
export function resetUsernames(): void {
  used.clear();
}

// Produce a unique l33t-style handle. Re-rolls on collision; falls back to a
// numeric tail once we've exhausted reasonable variation.
export function generateUsername(rand: () => number): string {
  for (let i = 0; i < 30; i++) {
    const h = rollHandle(rand);
    if (!used.has(h)) {
      used.add(h);
      return h;
    }
  }
  // Last resort — append an incrementing index.
  let i = 1;
  while (true) {
    const candidate = `${rollHandle(rand)}${i}`;
    if (!used.has(candidate)) { used.add(candidate); return candidate; }
    i++;
  }
}
