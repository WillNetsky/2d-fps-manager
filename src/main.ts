import "./styles.css";
import { MapEditor } from "./editor/mapEditor.ts";
import { BalanceMode } from "./balance/balanceMode.ts";
import { MainMenu } from "./menu/mainMenu.ts";
import { initGame } from "./game.ts";

const app = document.getElementById("app")!;
app.innerHTML = "";
app.className = "";

if (window.location.hash === "#editor") {
  new MapEditor(app);
} else if (window.location.hash === "#balance") {
  new BalanceMode(app);
} else if (window.location.hash === "#play") {
  initGame(app);
} else {
  new MainMenu(app);
}
window.addEventListener("hashchange", () => window.location.reload());
