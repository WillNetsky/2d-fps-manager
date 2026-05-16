import type { Loadout, Player, Team, UtilityId, WeaponId } from "../domain/types.ts";
import { HELMET_UPGRADE_COST, UTILITIES, VEST_COST, WEAPONS } from "../domain/weapons.ts";
import { statSummary } from "../domain/statSummary.ts";

const WEAPON_OPTIONS: WeaponId[] = ["pistol", "smg", "rifle", "awp"];
const UTILITY_OPTIONS: UtilityId[] = ["smoke", "flash", "he", "molotov"];

export interface BuyPanelHandlers {
  onStart: () => void;
}

type View = "ratings" | "match";

export class BuyPanel {
  el: HTMLElement;
  private team: Team;
  private handlers: BuyPanelHandlers;
  private view: View = "ratings";
  private roundNumber = 1;

  constructor(parent: HTMLElement, team: Team, handlers: BuyPanelHandlers) {
    this.team = team;
    this.handlers = handlers;
    this.el = document.createElement("div");
    this.el.className = "panel";
    parent.appendChild(this.el);
    this.render();
  }

  setRound(n: number) {
    this.roundNumber = n;
    // Force pistols on the first round of each half.
    if (n === 1 || n === 13) {
      for (const p of this.team.players) {
        const l = this.team.loadouts[p.id];
        if (l.weapon !== "pistol") l.weapon = "pistol";
      }
    }
    this.render();
  }

  private totalCost(): number {
    let total = 0;
    for (const p of this.team.players) {
      const l = this.team.loadouts[p.id];
      if (l.weapon !== l.keptWeapon) total += WEAPONS[l.weapon].cost;
      if (l.armor && !l.keptArmor) total += VEST_COST;
      if (l.helmet && !l.keptHelmet) total += HELMET_UPGRADE_COST;
      total += l.utility.reduce((s, u) => s + UTILITIES[u].cost, 0);
    }
    return total;
  }

  private setLoadout(p: Player, fn: (l: Loadout) => void) {
    fn(this.team.loadouts[p.id]);
    this.render();
  }

  private render() {
    const cost = this.totalCost();
    const remaining = this.team.money - cost;
    const overbudget = remaining < 0;

    this.el.innerHTML = "";
    const header = document.createElement("div");
    header.className = "panel-header";
    const h = document.createElement("h2");
    h.textContent = `${this.team.name} — Buy`;
    header.appendChild(h);
    const toggle = document.createElement("div");
    toggle.className = "view-toggle";
    for (const v of ["ratings", "match"] as const) {
      const b = document.createElement("button");
      b.textContent = v === "ratings" ? "Ratings" : "Match";
      b.className = "view-btn" + (this.view === v ? " active" : "");
      b.onclick = () => { this.view = v; this.render(); };
      toggle.appendChild(b);
    }
    header.appendChild(toggle);
    this.el.appendChild(header);

    const econ = document.createElement("div");
    econ.className = "economy";
    econ.innerHTML = `<span>Bank</span><strong>$${this.team.money}</strong>`;
    this.el.appendChild(econ);

    const spent = document.createElement("div");
    spent.className = "economy";
    spent.innerHTML = `<span>Spending</span><strong style="color:${overbudget ? "var(--bad)" : "var(--text)"}">$${cost} (left $${remaining})</strong>`;
    this.el.appendChild(spent);

    for (const p of this.team.players) {
      const l = this.team.loadouts[p.id];
      const row = document.createElement("div");
      row.className = "player-card";

      let topBlock: string;
      if (this.view === "ratings") {
        const s = statSummary(p.stats);
        topBlock = `
          <div class="traits">${p.traits.join(" · ") || "—"}</div>
          <div class="stats">
            <div>${s.aim}<span>AIM</span></div>
            <div>${s.reflexes}<span>RFX</span></div>
            <div>${s.gameSense}<span>GS</span></div>
            <div>${s.nerve}<span>NRV</span></div>
            <div>${s.utility}<span>UTL</span></div>
          </div>
          <div class="mood"><div style="width:${p.mood}%"></div></div>`;
      } else {
        const ms = this.team.matchStats[p.id];
        const rounds = Math.max(1, ms.roundsPlayed);
        const adr = Math.round(ms.damage / rounds);
        const diff = ms.kills - ms.deaths;
        const diffStr = diff >= 0 ? `+${diff}` : `${diff}`;
        topBlock = `
          <div class="stats stats-match">
            <div>${ms.kills}<span>K</span></div>
            <div>${ms.deaths}<span>D</span></div>
            <div class="${diff >= 0 ? "pos" : "neg"}">${diffStr}<span>+/-</span></div>
            <div>${adr}<span>ADR</span></div>
            <div>${Math.round(ms.damage)}<span>DMG</span></div>
          </div>`;
      }

      row.innerHTML = `<div class="name">${p.name} <span class="role">${p.role}</span></div>
        ${topBlock}`;

      const buy = document.createElement("div");
      buy.className = "buy-grid";

      // Weapons row
      const pistolRound = this.roundNumber === 1 || this.roundNumber === 13;
      buy.appendChild(this.makeRow("Weapon", WEAPON_OPTIONS.map(w => ({
        label: WEAPONS[w].name,
        cost: WEAPONS[w].cost,
        active: l.weapon === w,
        free: l.keptWeapon === w || WEAPONS[w].cost === 0,
        disabled: pistolRound && w !== "pistol",
        onClick: () => this.setLoadout(p, ll => { ll.weapon = w; }),
      }))));

      // Utility row (multi-select toggle)
      buy.appendChild(this.makeRow("Util", UTILITY_OPTIONS.map(u => ({
        label: UTILITIES[u].name,
        cost: UTILITIES[u].cost,
        active: l.utility.includes(u),
        free: false,
        disabled: false,
        onClick: () => this.setLoadout(p, ll => {
          const idx = ll.utility.indexOf(u);
          if (idx >= 0) ll.utility.splice(idx, 1);
          else ll.utility.push(u);
        }),
      }))));

      // Armor row: vest + helmet (helmet requires vest)
      buy.appendChild(this.makeRow("Armor", [
        {
          label: "Vest",
          cost: VEST_COST,
          active: l.armor,
          free: l.keptArmor,
          disabled: false,
          onClick: () => this.setLoadout(p, ll => {
            ll.armor = !ll.armor;
            if (!ll.armor) ll.helmet = false; // can't have helmet without vest
          }),
        },
        {
          label: "Helmet",
          cost: HELMET_UPGRADE_COST,
          active: l.helmet,
          free: l.keptHelmet,
          disabled: false,
          onClick: () => this.setLoadout(p, ll => {
            ll.helmet = !ll.helmet;
            if (ll.helmet) ll.armor = true; // helmet auto-enables vest
          }),
        },
      ]));

      row.appendChild(buy);
      this.el.appendChild(row);
    }

    const btn = document.createElement("button");
    btn.className = "primary";
    btn.textContent = overbudget ? "Over budget" : "Start round";
    btn.disabled = overbudget;
    btn.onclick = () => {
      if (!overbudget) {
        this.team.money -= cost;
        this.handlers.onStart();
      }
    };
    this.el.appendChild(btn);
  }

  private makeRow(
    label: string,
    opts: { label: string; cost: number; active: boolean; free: boolean; disabled: boolean; onClick: () => void }[],
  ): HTMLElement {
    const row = document.createElement("div");
    row.className = "buy-toggle-row";
    const lab = document.createElement("div");
    lab.className = "buy-toggle-label";
    lab.textContent = label;
    row.appendChild(lab);
    const btns = document.createElement("div");
    btns.className = "buy-toggle-btns";
    for (const o of opts) {
      const b = document.createElement("button");
      const classes = ["buy-btn"];
      if (o.active) classes.push("active");
      if (o.free) classes.push("kept");
      if (o.disabled) classes.push("locked");
      b.className = classes.join(" ");
      const costLabel = o.cost === 0 ? "FREE" : o.free ? "OWNED" : `$${o.cost}`;
      b.innerHTML = `<span class="b-name">${o.label}</span><span class="b-cost">${costLabel}</span>`;
      b.disabled = o.disabled;
      if (!o.disabled) b.onclick = o.onClick;
      btns.appendChild(b);
    }
    row.appendChild(btns);
    return row;
  }

  refresh() { this.render(); }
}
