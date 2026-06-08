### TODO

## Overall
- [x] Git this project

## Simulation
- [x] Steal weapon math (damage, fire rate, accuracy, recoil, armor pen, HS multipliers) straight from CS2 (or CS 1.6) instead of hand-tuned guesses
- [x] Add headshots, kevlar+helmet
- [x] Figure out how CT smokes are effective
- [x] Flashes
- [x] Molotovs
- [x] HE
- [x] Grenades are thrown by players, show them leaving their hand and their trajectory. Grenade skills should affect both target choice and accuracy
- [x] Ammo, reloads
- [x] Different T and CT guns
- [x] Upgraded pistols (deagles,)
- [x] Agents should be aware of how many players are left
- [x] Agents should think about saving their gun
- [x] Agents should take cover and peek corners

## Match Logic
- [x] CT side needs to be able to choose strategies, and place players
- [x] MR12 rules, switch sides! it goes 13 straight CT right now
- [x] Per-player banks instead of a single team bankroll (each player's kills/wins/losses accrue to their own money; coach decides who buys what)
- [x] Drop guns for teammates — buy-phase action (give your gun to a teammate before round) and mid-round (agents pick up nearby teammates' drops); especially for AWP redistribution and upgrade hand-me-downs
- [x] Bomb drops on carrier death (yellow aura; T retrieves, CT guards)

## Match Display
- [x] MVPs for each round
- [x] Kill display in the top right
- [x] Timeline kill lines color coded by team
- [x] "Replay" displayed on top when its replaying "Live" when live
- [x] Buttons for moving between rounds are stuck behind the main menu button
- [x] Highlight the circle of the currently playing round

## Map Editor
- [x] Abillity to create new maps, edit saved maps
- [x] Load saved maps
- [x] Save as new map
- [x] Balancer should have the option to sim whole MR12 games, changes "rounds" to "series"
- [x] Grid tends to start missing both horizontal and vertical lines
- [x] Heatmaps should clear when loading a new map

## Universe
- [x] Pool of players
- [x] They play casual games (that are tracked) and skill up from them
- [x] Professional Teams 
- [x] Tournament prize money
- [x] Player's value money
- [x] Something to spend money on (better equipment? buy a team?)
- [x] Player pages should show their handle before their real names
- [x] Player pages relationship display should show "Handle" Real Name
- [x] Team pages should also show when they benched a player in the Roster history
- [x] Established orgs should have their own color (rather than default blue or orange)

## Issues
- [x] CTs don't seem to actually go defuse the bomb, time just runs out and they win by defusing
- [x] It appears that sometimes CTs try to save by sitting in spawn, but they're found and they dont fight back and just get killed

## Thoughts
- [x] Pistol rounds don't feel right, there should be the option to buy kevlar OR util for each player, and util should be more effective in those rounds