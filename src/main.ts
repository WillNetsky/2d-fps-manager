import "./styles.css";
import { MapEditor, seedDefaultMaps, seedRecoveredMaps } from "./editor/mapEditor.ts";
import { UniverseMode } from "./universe/universeMode.ts";

// One-time seed of the default map into the saved-map store (no-op after first run).
seedDefaultMaps();
// One-time, merge-only restore of maps lost from localStorage (no-op after first run).
seedRecoveredMaps();

const app = document.getElementById("app")!;
app.innerHTML = "";
app.className = "";

// The map editor (which now hosts the balance tester / heatmaps in its analyze
// panel) opens as a separate workspace; everything else is Universe Mode, the
// home screen. #balance is kept as a back-compat alias for the editor.
if (window.location.hash === "#editor" || window.location.hash === "#balance") {
  new MapEditor(app);
} else {
  new UniverseMode(app);
}
window.addEventListener("hashchange", () => window.location.reload());
