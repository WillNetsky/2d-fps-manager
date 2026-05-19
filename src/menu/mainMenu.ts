type MenuItem = {
  label: string;
  desc: string;
  hash: string;
  disabled?: boolean;
  badge?: string;
};

const ITEMS: MenuItem[] = [
  { label: "Demo Match",     desc: "Quick match with random players on the current map", hash: "#play" },
  { label: "Universe Mode",  desc: "Career & franchise management", hash: "", disabled: true, badge: "Coming soon" },
  { label: "Map Editor",     desc: "Design and validate custom maps", hash: "#editor" },
  { label: "Balance Testing", desc: "Run loadout sims and balance experiments", hash: "#balance" },
];

export class MainMenu {
  constructor(root: HTMLElement) {
    root.className = "menu-app";
    root.innerHTML = "";

    const wrap = document.createElement("div");
    wrap.className = "menu-wrap";
    root.appendChild(wrap);

    const title = document.createElement("h1");
    title.className = "menu-title";
    title.textContent = "2D FPS Manager";
    wrap.appendChild(title);

    const sub = document.createElement("div");
    sub.className = "menu-sub";
    sub.textContent = "Top-down tactical team management";
    wrap.appendChild(sub);

    const list = document.createElement("div");
    list.className = "menu-list";
    wrap.appendChild(list);

    for (const item of ITEMS) {
      const btn = document.createElement("button");
      btn.className = "menu-item" + (item.disabled ? " disabled" : "");
      btn.disabled = !!item.disabled;

      const left = document.createElement("div");
      left.className = "menu-item-text";
      const lbl = document.createElement("div");
      lbl.className = "menu-item-label";
      lbl.textContent = item.label;
      const desc = document.createElement("div");
      desc.className = "menu-item-desc";
      desc.textContent = item.desc;
      left.appendChild(lbl);
      left.appendChild(desc);
      btn.appendChild(left);

      if (item.badge) {
        const b = document.createElement("span");
        b.className = "menu-item-badge";
        b.textContent = item.badge;
        btn.appendChild(b);
      }

      if (!item.disabled) {
        btn.onclick = () => {
          if (window.location.hash === item.hash) window.location.reload();
          else window.location.hash = item.hash;
        };
      }

      list.appendChild(btn);
    }
  }
}
