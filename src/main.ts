import "./styles.css";
import { MapEditor } from "./editor/mapEditor.ts";
import { BalanceMode } from "./balance/balanceMode.ts";
import { initGame } from "./game.ts";

const app = document.getElementById("app")!;
app.innerHTML = "";

if (window.location.hash === "#editor") {
  new MapEditor(app);
} else if (window.location.hash === "#balance") {
  new BalanceMode(app);
} else {
  initGame(app);
}
window.addEventListener("hashchange", () => window.location.reload());
