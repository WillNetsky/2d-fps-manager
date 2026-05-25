import type { Agent, Team } from "../domain/types.ts";
import { statSummary } from "../domain/statSummary.ts";

type View = "ratings" | "match";

export class TeamPanel {
  el: HTMLElement;
  private team: Team;
  private logEl: HTMLElement;
  private bodyEl: HTMLElement;
  private view: View = "ratings";
  private agents: Agent[] | null = null;
  private toggleEl!: HTMLElement;

  constructor(parent: HTMLElement, team: Team) {
    this.team = team;
    this.el = document.createElement("div");
    this.el.className = "panel";
    parent.appendChild(this.el);

    const header = document.createElement("div");
    header.className = "panel-header";
    const h = document.createElement("h2");
    h.textContent = team.name;
    header.appendChild(h);

    this.toggleEl = document.createElement("div");
    this.toggleEl.className = "view-toggle";
    header.appendChild(this.toggleEl);
    this.el.appendChild(header);

    this.bodyEl = document.createElement("div");
    this.el.appendChild(this.bodyEl);

    const lh = document.createElement("h2");
    lh.textContent = "Round Log";
    lh.style.marginTop = "16px";
    this.el.appendChild(lh);
    this.logEl = document.createElement("div");
    this.logEl.className = "log";
    this.el.appendChild(this.logEl);

    this.renderToggle();
    this.render();
  }

  setAgents(agents: Agent[] | null) {
    this.agents = agents;
    this.render();
  }

  log(line: string) {
    const d = document.createElement("div");
    d.textContent = line;
    this.logEl.appendChild(d);
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  clearLog() { this.logEl.innerHTML = ""; }

  refresh() { this.render(); }

  private renderToggle() {
    this.toggleEl.innerHTML = "";
    for (const v of ["ratings", "match"] as const) {
      const b = document.createElement("button");
      b.textContent = v === "ratings" ? "Ratings" : "Match";
      b.className = "view-btn" + (this.view === v ? " active" : "");
      b.onclick = () => { this.view = v; this.renderToggle(); this.render(); };
      this.toggleEl.appendChild(b);
    }
  }

  private render() {
    this.bodyEl.innerHTML = "";
    for (const p of this.team.players) {
      const agent = this.agents?.find(a => a.playerId === p.id);
      const dead = agent && !agent.alive;
      const card = document.createElement("div");
      card.className = "player-card" + (dead ? " dead" : "");

      const l = this.team.loadouts[p.id];
      const armorTag = l && l.armor ? (l.helmet ? "armor+hlm" : "armor") : null;
      const loadoutLine = l
        ? [l.weapon.toUpperCase(), armorTag, ...l.utility].filter(Boolean).join(" · ")
        : "—";

      let body: string;
      if (this.view === "ratings") {
        const s = statSummary(p.stats);
        body = `
          <div class="traits">${p.traits.join(" · ")}</div>
          <div class="loadout">${loadoutLine}</div>
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
        body = `
          <div class="loadout">${loadoutLine}</div>
          <div class="stats stats-match">
            <div>${ms.kills}<span>K</span></div>
            <div>${ms.deaths}<span>D</span></div>
            <div class="${diff >= 0 ? "pos" : "neg"}">${diffStr}<span>+/-</span></div>
            <div>${adr}<span>ADR</span></div>
            <div>${Math.round(ms.damage)}<span>DMG</span></div>
          </div>`;
      }

      card.innerHTML = `
        <div class="name">${p.handle} <span class="role">${p.role}</span></div>
        ${body}
      `;
      this.bodyEl.appendChild(card);
    }
  }
}
