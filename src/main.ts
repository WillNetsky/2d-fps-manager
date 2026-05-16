import "./styles.css";
import { MapEditor } from "./editor/mapEditor.ts";
import { initGame } from "./game.ts";

const app = document.getElementById("app")!;
app.innerHTML = "";

if (window.location.hash === "#editor") {
  new MapEditor(app);
  // Reload when hash changes so we can transition between editor and game cleanly.
  window.addEventListener("hashchange", () => window.location.reload());
} else {
  initGame(app);
  window.addEventListener("hashchange", () => window.location.reload());
}
