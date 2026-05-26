# 2D FPS Manager

A 2D top-down team-management game inspired by Counter-Strike (legally distinct). You play the coach: set the buy, watch the round play out, adapt for the next one. Built with TypeScript + Pixi.js v8 + Vite.

## What's in it

### Match sim
- Per-tick simulation of two 5-player teams on a grid map (default 32×20, 28px tiles)
- ~30 per-player ratings across aim, mechanical, cognitive, mental, utility, weapon prefs, and team categories — sim is ratings-driven, not trait-gated
- A* pathfinding, LOS raycasting with smoke + smoke-hole occlusion, BFS-based intel decay
- Utility: smokes (LOS block), flashes (blind cone), molotovs (DOT, extinguished by smokes), HEs (damage + temporary smoke hole). Landing positions auto-detected from map chokepoints
- Two movement speeds: walk (slow, quiet) and run (fast, loud) — footsteps are audible intel without LOS
- Engagement stances (hold / rush / disengage) chosen from visible-enemy and nearby-ally counts
- Saving logic: agents that decide a round is unwinnable hide and try to keep their weapon

### Weapons (CS2-style math)
- Glock (T) and USP-S (CT) as side-specific free pistols, plus Deagle, MP9, MAC-10, M4, AK, AWP
- CS2 damage falloff: `dmg *= rangeModifier ^ (distance / 500)`
- CS2 armor formula: `dmg *= armorPen` on armored hits — AK one-taps helmets, M4 does not, Deagle one-shots headshots through helmet, AWP one-shots body through vest
- Headshot multiplier (×4 for most guns); helmet halves HS via armorPen rather than a separate constant

### Rules & economy
- MR12 ruleset: first to 13 over 24 rounds, halftime side swap
- $3000 starting bank, weapon/armor carryover for survivors, free side pistols, vest XOR utility on pistol rounds
- T strategies: rush-A, rush-B, default, split-A, split-B
- CT setup shapes: 2A/2B/1M (55%), 3A/2B (25%), 2A/3B (20%); per-player CT assignment (`A`/`B`/`mid`/`auto`) is coach-settable

### UI / UX
- Live round view with CS-style overlays: kill feed in the top-right of the map, centered MVP card on round end (winner, outcome, duration, MVP + what they did)
- Verbose round log: kills, pickups (weapon swaps), util throws, save/re-engage toggles, bomb pickups, plant/defuse/detonate
- Round timeline scrubber with per-tick replay and event markers; kill feed entries persist during replay playback
- "Sim round" button autobuys for both sides and fast-forwards the round
- Built-in map editor at `#editor` with localStorage persistence, validation, "Copy JSON" export, color customization, multiple built-in maps

### Universe mode (MVP)
- Persistent ecosystem: procedurally generated players — each with a real name (locale-flavored), an in-game handle, nationality/flag, and age — drawn from a shared pool and saved to localStorage across multiple universes
- Configurable creation: a New Universe screen lets you set the name, pick which competitive regions to include, choose the player count per region (default 100), and assemble the starting map rotation before generating the pool
- Region-based matchmaking: players are partitioned into competitive regions (Europe, CIS, NA, SA, Asia, Oceania) and only matchmake within their own scene; the matchup board groups lobbies by region
- Daily matchups: each day generates region-grouped 5v5 matchups (skill-banded by Elo within each region); friends who queue together are kept on one team and marked with a 🔗 stack badge on the board; play them out live or sim instantly
- Elo ratings per player, updated from match results; standings screen ranks the pool
- Persistent form: each player's morale carries between matches and seeds their in-game mood (so streaks affect aim). How they react is personality-driven — high-recovery players shake off losses, low-composure/tilt-prone players stay tilted until they win, and low-ambition "fun" players stay cheerful regardless
- Pre-match matchup screen shows both rosters with team name + average Elo above each
- Postgame results screen with final score, round-by-round breakdown, per-player kills/deaths/**assists**, and per-round MVPs
- Multiple saved universes via menu (create / load / delete)

### Balance lab
- Map balance tester runs N rounds per cell in a Web Worker (off the main thread) using neutralized stats by default
- Loadout matrix mode: pits preset buys (full / rifle-only / eco / etc.) against each other
- Per-T-strategy and per-CT-setup breakdowns with rounds played, win%, K/D, average kills, plant/defuse/detonation/timeout %, and average duration
- Mood/morale reset per round when neutralizing — avoids runaway feedback loops in long sweeps

## Requirements

- Node.js 18+ (Vite 6)
- npm

## Run it

```bash
npm run dev
```

Vite will print a local URL (default http://localhost:5173).

- Game: `/`
- Map editor: append `#editor` to the URL
- Balance lab: in-app from the game UI

## Build

```bash
npm run build      # type-check + production build into dist/
npm run preview    # serve the production build locally
```

## Project layout

```
src/
  domain/      types, factory (players, map, ratings), weapons, stat summaries
  sim/         RoundSim, pathfinding, map analysis (chokes), economy, replay
  render/      Pixi renderer (live + replay share a SimView interface)
  ui/          buy panel, team panel, timeline scrubber, kill feed
  editor/      hash-routed map editor
  balance/     balance mode UI + Web Worker
  universe/    universe mode: player pool, daily matchups, Elo, storage
  game.ts      glue between sim, UI, renderer
  main.ts      dispatcher: editor vs game
scripts/       Node-side helpers (damage tables, matrix runs) via esbuild
TODO.md        running checklist
```
