import type { Player } from "../domain/types.ts";

export interface UniverseSummary {
  id: string;
  name: string;
  day: number;
  createdAt: number;
}

export interface Universe {
  id: string;
  name: string;
  createdAt: number;
  day: number;                              // current day index (1-based)
  players: Player[];                        // pool of players
  elos: Record<string, number>;             // playerId -> elo
  history: CompletedDay[];                  // all past days
  pendingDay: PendingDay | null;            // in-progress day (if any)
}

export interface PendingDay {
  day: number;
  matchups: Matchup[];                      // each Matchup tracks its own status
}

export interface Matchup {
  id: string;
  ctPlayerIds: string[];                    // 5 player ids
  tPlayerIds: string[];                     // 5 player ids
  status: "pending" | "completed";
  ctScore?: number;
  tScore?: number;
  winnerSide?: "CT" | "T";
  clutches?: Clutch[];                      // clutches won during this match
  playerStats?: Record<string, PlayerMatchStats>;
}

export interface Clutch {
  playerId: string;
  kills: number;                            // kills the player got while last alive
}

export interface PlayerMatchStats {
  kills: number;
  deaths: number;
  assists: number;
  damage: number;
  roundsPlayed: number;
  // Rounds in which the player got exactly N kills (for HLTV 1.0 rating).
  k1: number; k2: number; k3: number; k4: number; k5: number;
}

export interface CompletedDay {
  day: number;
  matchups: Matchup[];                      // all status: "completed"
}

export const STARTING_ELO = 1000;
export const PLAYER_COUNT = 100;
export const TEAM_SIZE = 5;
export const MATCHUPS_PER_DAY = PLAYER_COUNT / (TEAM_SIZE * 2);
