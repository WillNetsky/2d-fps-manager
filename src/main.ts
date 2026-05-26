import "./styles.css";
import { MapEditor } from "./editor/mapEditor.ts";
import { BalanceMode } from "./balance/balanceMode.ts";
import { UniverseMode } from "./universe/universeMode.ts";

const app = document.getElementById("app")!;
app.innerHTML = "";
app.className = "";

// Map editor and balance testing are launched from Universe Mode's settings as
// separate workspaces; everything else is Universe Mode, which is the home
// screen (#universe kept for back-compat links).
if (window.location.hash === "#editor") {
  new MapEditor(app);
} else if (window.location.hash === "#balance") {
  new BalanceMode(app);
} else {
  new UniverseMode(app);
}
window.addEventListener("hashchange", () => window.location.reload());
