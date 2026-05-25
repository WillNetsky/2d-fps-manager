import type { Loadout, Player, Team, UtilityId, WeaponId } from "../domain/types.ts";
import { HELMET_UPGRADE_COST, UTILITIES, VEST_COST, WEAPONS, defaultPistol } from "../domain/weapons.ts";
import { statSummary } from "../domain/statSummary.ts";

const ALL_WEAPONS: WeaponId[] = ["glock", "usp", "deagle", "mp9", "mac10", "m4", "ak", "awp"];
const UTILITY_OPTIONS: UtilityId[] = ["smoke", "flash", "he", "molotov"];

export interface BuyPanelHandlers {
  onStart: () => void;
  onSimNow: () => void;
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
    // Force pistols + clear helmet on the first round of each half.
    // Vest XOR util is enforced through UI disabled state, not here — let the player choose.
    if (n === 1 || n === 13) {
      for (const p of this.team.players) {
        const l = this.team.loadouts[p.id];
        if (WEAPONS[l.weapon].slot !== "pistol") l.weapon = defaultPistol(this.team.side);
        l.helmet = false;
      }
    }
    this.render();
  }

  private playerCost(p: Player): number {
    const l = this.team.loadouts[p.id];
    let total = 0;
    if (l.weapon !== l.keptWeapon) total += WEAPONS[l.weapon].cost;
    if (l.armor && !l.keptArmor) total += VEST_COST;
    if (l.helmet && !l.keptHelmet) total += HELMET_UPGRADE_COST;
    total += l.utility.reduce((s, u) => l.keptUtility.includes(u) ? s : s + UTILITIES[u].cost, 0);
    return total;
  }

  private setLoadout(p: Player, fn: (l: Loadout) => void) {
    fn(this.team.loadouts[p.id]);
    this.render();
  }

  private giveWeapon(from: Player, to: Player) {
    const fromL = this.team.loadouts[from.id];
    const toL = this.team.loadouts[to.id];
    const gun = fromL.keptWeapon;
    if (!gun) return;
    // Giver downgrades to pistol; loses kept gun.
    fromL.keptWeapon = null;
    if (fromL.weapon === gun) fromL.weapon = defaultPistol(this.team.side);
    // Recipient gains kept gun (free) and selects it as their loadout.
    toL.keptWeapon = gun;
    toL.weapon = gun;
    this.render();
  }

  private render() {
    let totalCost = 0;
    let totalBank = 0;
    let anyOver = false;
    for (const p of this.team.players) {
      const c = this.playerCost(p);
      totalCost += c;
      totalBank += p.money;
      if (c > p.money) anyOver = true;
    }

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
    econ.innerHTML = `<span>Team total</span><strong>$${totalBank}</strong>`;
    this.el.appendChild(econ);

    const spent = document.createElement("div");
    spent.className = "economy";
    spent.innerHTML = `<span>Spending</span><strong style="color:${anyOver ? "var(--bad)" : "var(--text)"}">$${totalCost}</strong>`;
    this.el.appendChild(spent);

    // CT strategy presets (only visible when this team is on CT side).
    if (this.team.side === "CT") {
      const stratRow = document.createElement("div");
      stratRow.className = "buy-toggle-row";
      const lab = document.createElement("div");
      lab.className = "buy-toggle-label";
      lab.textContent = "Setup";
      stratRow.appendChild(lab);
      const btns = document.createElement("div");
      btns.className = "buy-toggle-btns";
      const presets: { label: string; assign: (players: Player[]) => void }[] = [
        { label: "Auto",     assign: ps => ps.forEach(p => p.ctAssignment = "auto") },
        { label: "2A/2B/1M", assign: ps => assignByPattern(ps, ["A","A","B","B","mid"]) },
        { label: "A heavy",  assign: ps => assignByPattern(ps, ["A","A","A","B","mid"]) },
        { label: "B heavy",  assign: ps => assignByPattern(ps, ["A","B","B","B","mid"]) },
        { label: "Stack A",  assign: ps => ps.forEach(p => p.ctAssignment = p.role === "lurker" ? "B" : "A") },
        { label: "Stack B",  assign: ps => ps.forEach(p => p.ctAssignment = p.role === "lurker" ? "A" : "B") },
      ];
      for (const preset of presets) {
        const b = document.createElement("button");
        b.className = "buy-btn";
        b.innerHTML = `<span class="b-name">${preset.label}</span>`;
        b.onclick = () => { preset.assign(this.team.players); this.render(); };
        btns.appendChild(b);
      }
      stratRow.appendChild(btns);
      this.el.appendChild(stratRow);
    }
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

      const pCost = this.playerCost(p);
      const pRemaining = p.money - pCost;
      const pOver = pRemaining < 0;
      row.innerHTML = `<div class="name">${p.handle} <span class="role">${p.role}</span>
        <span class="player-bank" style="float:right;color:${pOver ? "var(--bad)" : "var(--text)"}">$${pRemaining} / $${p.money}</span>
      </div>
        ${topBlock}`;

      const buy = document.createElement("div");
      buy.className = "buy-grid";

      // CT site picker (per-player) — only when this team is currently on CT.
      if (this.team.side === "CT") {
        const siteRow = document.createElement("div");
        siteRow.className = "buy-toggle-row";
        const lab = document.createElement("div");
        lab.className = "buy-toggle-label";
        lab.textContent = "Site";
        siteRow.appendChild(lab);
        const btns = document.createElement("div");
        btns.className = "buy-toggle-btns";
        for (const opt of ["A", "B", "mid", "auto"] as const) {
          const b = document.createElement("button");
          const cls = ["buy-btn"];
          if (p.ctAssignment === opt) cls.push("active");
          b.className = cls.join(" ");
          b.innerHTML = `<span class="b-name">${opt}</span>`;
          b.onclick = () => { p.ctAssignment = opt; this.render(); };
          btns.appendChild(b);
        }
        siteRow.appendChild(btns);
        buy.appendChild(siteRow);
      }

      // Weapons row — filter to this team's faction (universal weapons always shown).
      const pistolRound = this.roundNumber === 1 || this.roundNumber === 13;
      const availableWeapons = ALL_WEAPONS.filter(w => {
        const fac = WEAPONS[w].faction;
        if (!fac || fac === this.team.side) return true;
        // Also show a captured/kept enemy-faction gun.
        return l.keptWeapon === w || l.weapon === w;
      });
      buy.appendChild(this.makeRow("Weapon", availableWeapons.map(w => ({
        label: WEAPONS[w].name,
        cost: WEAPONS[w].cost,
        active: l.weapon === w,
        free: l.keptWeapon === w || WEAPONS[w].cost === 0,
        disabled: pistolRound && WEAPONS[w].slot !== "pistol",
        onClick: () => this.setLoadout(p, ll => { ll.weapon = w; }),
      }))));

      // Pistol-round vest/util tradeoff is now enforced naturally by the
      // per-player bank ($800 — can't afford both).
      const utilDisabled = false;
      const vestDisabled = false;

      // Utility row (multi-select toggle)
      buy.appendChild(this.makeRow("Util", UTILITY_OPTIONS.map(u => ({
        label: UTILITIES[u].name,
        cost: UTILITIES[u].cost,
        active: l.utility.includes(u),
        free: l.keptUtility.includes(u),
        disabled: utilDisabled,
        onClick: () => this.setLoadout(p, ll => {
          const idx = ll.utility.indexOf(u);
          if (idx >= 0) ll.utility.splice(idx, 1);
          else ll.utility.push(u);
        }),
      }))));

      // Armor row: vest + helmet (helmet requires vest, both locked on pistol rounds)
      buy.appendChild(this.makeRow("Armor", [
        {
          label: "Vest",
          cost: VEST_COST,
          active: l.armor,
          free: l.keptArmor,
          disabled: vestDisabled,
          onClick: () => this.setLoadout(p, ll => {
            ll.armor = !ll.armor;
            if (!ll.armor) ll.helmet = false;
          }),
        },
        {
          label: "Helmet",
          cost: HELMET_UPGRADE_COST,
          active: l.helmet,
          free: l.keptHelmet,
          disabled: pistolRound,
          onClick: () => this.setLoadout(p, ll => {
            ll.helmet = !ll.helmet;
            if (ll.helmet) ll.armor = true;
          }),
        },
      ]));

      // Give weapon to teammate — coach action.
      // Only meaningful when this player has a kept gun better than pistol.
      const keptW = l.keptWeapon;
      if (keptW && WEAPONS[keptW].cost > 0 && !pistolRound) {
        const giveRow = document.createElement("div");
        giveRow.className = "buy-toggle-row";
        const lab = document.createElement("div");
        lab.className = "buy-toggle-label";
        lab.textContent = "Give";
        giveRow.appendChild(lab);
        const btns = document.createElement("div");
        btns.className = "buy-toggle-btns";
        for (const t of this.team.players) {
          if (t.id === p.id) continue;
          const tl = this.team.loadouts[t.id];
          const tKeptCost = tl.keptWeapon ? WEAPONS[tl.keptWeapon].cost : 0;
          const recipientHasBetter = tKeptCost >= WEAPONS[keptW].cost;
          const b = document.createElement("button");
          const classes = ["buy-btn"];
          if (recipientHasBetter) classes.push("locked");
          b.className = classes.join(" ");
          b.innerHTML = `<span class="b-name">→ ${t.handle}</span><span class="b-cost">${WEAPONS[keptW].name}</span>`;
          b.disabled = recipientHasBetter;
          if (!recipientHasBetter) b.onclick = () => this.giveWeapon(p, t);
          btns.appendChild(b);
        }
        giveRow.appendChild(btns);
        buy.appendChild(giveRow);
      }

      row.appendChild(buy);
      this.el.appendChild(row);
    }

    const btnRow = document.createElement("div");
    btnRow.className = "start-row";
    const startBtn = document.createElement("button");
    startBtn.className = "primary";
    startBtn.textContent = anyOver ? "Over budget" : "Start round";
    startBtn.disabled = anyOver;
    startBtn.onclick = () => {
      if (anyOver) return;
      for (const p of this.team.players) p.money -= this.playerCost(p);
      this.handlers.onStart();
    };
    btnRow.appendChild(startBtn);

    const simBtn = document.createElement("button");
    simBtn.className = "secondary";
    simBtn.textContent = "Sim round";
    simBtn.title = "Auto-buy for your team and run the next round headless, then watch the replay";
    // Sim round delegates buying to the AI, so the manual-loadout budget
    // check doesn't apply — leave the button enabled even when over budget.
    simBtn.onclick = () => this.handlers.onSimNow();
    btnRow.appendChild(simBtn);

    this.el.appendChild(btnRow);
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

// Assign by pattern — order CTs by role priority then map onto the pattern.
function assignByPattern(players: Player[], pattern: ("A" | "B" | "mid")[]) {
  const ROLE_ORDER: Record<string, number> = { awper: 0, igl: 1, support: 2, entry: 3, lurker: 4 };
  const sorted = [...players].sort((a, b) => (ROLE_ORDER[a.role] ?? 9) - (ROLE_ORDER[b.role] ?? 9));
  sorted.forEach((p, i) => { p.ctAssignment = pattern[i] ?? "auto"; });
}
