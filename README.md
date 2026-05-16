# 2D FPS Manager

A 2D top-down team-management game inspired by Counter-Strike (legally distinct). You play the coach: set the buy, watch the round play out, adapt for the next one. Built with TypeScript + Pixi.js v8 + Vite.

## What's in it

- Per-tick simulation of two 5-player teams on a Dust2-shaped grid map (32×20, 28px tiles)
- ~30 fine-grained per-player ratings (aim, mechanical, cognitive, mental, utility, weapon prefs, team) — sim is ratings-driven, not trait-gated
- A* pathfinding, LOS raycasting with smoke + smoke-hole occlusion, BFS intel decay
- Four utility types: smokes (LOS block), flashes (blind cone), molotovs (DOT, extinguished by smokes), HEs (damage + temporary smoke hole) — landing positions auto-detected from map chokepoints
- Engagement stances (hold/rush/disengage) chosen from visible-enemy / nearby-ally count
- Walk vs run, audible footsteps as intel without LOS
- MR12 ruleset: first to 13 over 24 rounds, halftime side swap, $3000 starting bank, weapon/armor carryover for survivors, free pistols, vest XOR utility on pistol rounds
- Round timeline scrubber with per-tick replay
- Built-in map editor at `#editor` with localStorage persistence

## Requirements

- Node.js 18+ (Vite 6 requires it)
- npm

## Run it

```bash
npm run dev
```

Vite will print a local URL (default http://localhost:5173). Open it in a browser.

- Game: `/`
- Map editor: append `#editor` to the URL

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
  ui/          buy panel, team panel, timeline scrubber
  editor/      hash-routed map editor
  game.ts      glue between sim, UI, renderer
  main.ts      dispatcher: editor vs game
TODO.md        running checklist
```
