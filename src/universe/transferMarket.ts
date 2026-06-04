// Transfer market — the post-event roster shuffle. Pure (no DOM, no storage),
// mirroring lifecycle.ts: the day loop calls runTransferWindow once each event
// finishes, after income (prize money + sponsorship) is credited and wages are
// paid (so the spendable `balance` is current). An org buys an upgrade by paying
// a transfer fee (≈ market value) from its balance to the selling org; free
// agents are free. The fee flow also bails out a sellable org in financial
// trouble before the insolvency check folds it.
//
// One window:
//   1. Each active org, RICHEST first, makes at most one improving signing it can
//      afford — a free agent, or a poach from an equal/weaker org (players only
//      move sideways or up). The org's weakest player is released to free agency.
//   2. Orgs left short (they sold a player) backfill from the best free agent.
// Mutates teams (rosters/balance/identity), players (chemistry), and returns the
// transfers for logging + news.

import type { Player } from "../domain/types.ts";
import { regionOf } from "../domain/countries.ts";
import { seedCliqueBonds } from "./chemistry.ts";
import { formatMoney } from "./finance.ts";
import { STARTING_ELO, TEAM_SIZE, type TransferRecord, type UniverseTeam } from "./types.ts";

const MIN_UPGRADE_GAP = 30;  // elo improvement required to bother signing
const SIGNING_BOND = 55;     // seed cohesion across the new lineup (clears FRIEND_THRESHOLD)

export function runTransferWindow(
  teams: UniverseTeam[], players: Player[], elos: Record<string, number>, day: number,
): TransferRecord[] {
  const byId = new Map(players.map(p => [p.id, p] as const));
  const eloOf = (id: string) => elos[id] ?? STARTING_ELO;
  const valueOf = (id: string) => byId.get(id)?.value ?? 0;
  const teamElo = (t: UniverseTeam) => t.elo ?? STARTING_ELO;

  const active = teams.filter(t => !t.disbandedDay && t.playerIds.length > 0);
  const onOrg = new Set<string>();         // players currently committed to an org
  for (const t of active) for (const id of t.playerIds) onOrg.add(id);
  const moved = new Set<string>();          // players who already changed teams this window

  const transfers: TransferRecord[] = [];

  // Active, in-region, uncommitted, not-yet-moved players — the free-agent pool.
  const freeAgentsIn = (region: string): Player[] =>
    players.filter(p => !p.retired && !onOrg.has(p.id) && !moved.has(p.id) && regionOf(p.country) === region);

  const commit = (org: UniverseTeam): void => {
    org.rosterKey = [...org.playerIds].sort().join(",");
    org.elo = Math.round(org.playerIds.reduce((s, id) => s + eloOf(id), 0) / org.playerIds.length);
  };
  const seed = (org: UniverseTeam): void =>
    seedCliqueBonds(org.playerIds.map(id => byId.get(id)!).filter(Boolean), SIGNING_BOND);

  // --- Buying pass: richest first (prize money = buying power) ---
  const buyers = [...active].sort((a, b) =>
    (b.balance ?? 0) - (a.balance ?? 0) || (b.rankingPoints ?? 0) - (a.rankingPoints ?? 0));

  for (const org of buyers) {
    if (org.playerIds.length < TEAM_SIZE) continue; // short orgs are handled in backfill
    const budget = org.balance ?? 0;
    const weakestId = [...org.playerIds].sort((a, b) => eloOf(a) - eloOf(b))[0];
    const weakElo = eloOf(weakestId);

    // Best affordable, willing in-region upgrade (free agent or poach).
    let best: { id: string; from?: UniverseTeam; fee: number; elo: number } | null = null;
    const consider = (id: string, from?: UniverseTeam) => {
      if (moved.has(id) || id === weakestId) return;
      const e = eloOf(id);
      if (e < weakElo + MIN_UPGRADE_GAP) return;          // not enough of an upgrade
      if (from && teamElo(org) < teamElo(from)) return;   // players don't move to a weaker org
      const fee = from ? valueOf(id) : 0;                 // free agents are free
      if (fee > budget) return;
      if (!best || e > best.elo) best = { id, from, fee, elo: e };
    };
    for (const fa of freeAgentsIn(org.region)) consider(fa.id);
    for (const other of active) {
      if (other.id === org.id || other.region !== org.region) continue;
      for (const id of other.playerIds) consider(id, other);
    }
    if (!best) continue;
    const pick: { id: string; from?: UniverseTeam; fee: number } = best;

    // Execute: pay the fee, pull the player, release the weakest.
    const signing = byId.get(pick.id)!;
    if (pick.from) {
      pick.from.playerIds = pick.from.playerIds.filter(id => id !== pick.id);
      pick.from.balance = (pick.from.balance ?? 0) + pick.fee; // selling org banks the fee
      org.balance = (org.balance ?? 0) - pick.fee;
      commit(pick.from);
    }
    org.playerIds = [...org.playerIds.filter(id => id !== weakestId), pick.id];
    onOrg.delete(weakestId);   // released to free agency
    onOrg.add(pick.id);
    moved.add(pick.id);
    seed(org);
    commit(org);

    transfers.push({
      day, playerId: pick.id, playerHandle: signing.handle,
      fromTeamId: pick.from?.id, fromTeamName: pick.from?.name,
      toTeamId: org.id, toTeamName: org.name, fee: pick.fee,
    });
    (org.rosterHistory ??= []).push({
      day, playerIds: [...org.playerIds],
      note: pick.from
        ? `Signed ${signing.handle} from ${pick.from.name} (${formatMoney(pick.fee)})`
        : `Signed ${signing.handle} (free agent)`,
    });
  }

  // --- Backfill pass: orgs that sold a player grab the best free agent ---
  for (const org of active) {
    while (org.playerIds.length < TEAM_SIZE) {
      const fa = freeAgentsIn(org.region).sort((a, b) => eloOf(b.id) - eloOf(a.id))[0];
      if (!fa) break;
      org.playerIds.push(fa.id);
      onOrg.add(fa.id);
      moved.add(fa.id);
      seed(org);
      commit(org);
      transfers.push({
        day, playerId: fa.id, playerHandle: fa.handle,
        toTeamId: org.id, toTeamName: org.name, fee: 0,
      });
      (org.rosterHistory ??= []).push({
        day, playerIds: [...org.playerIds], note: `Signed ${fa.handle} (free agent)`,
      });
    }
  }

  return transfers;
}
