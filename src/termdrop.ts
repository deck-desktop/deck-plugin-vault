// A note dragged out of the tree and let go over one of Deck's terminals: its path typed at the
// terminal's cursor, quoted where a shell needs it, with a space after, as Deck does for a drop from
// Windows Explorer (and for a drag from its own file trees).
import { termWrite } from "../shim/terminals.js";

/** While a note is dragged: the terminal (or the pane Deck shows as a chat) under the pointer
 *  outlined, as Deck does for a drop from Explorer; with no point, none. Deck's useRowDrag calls it
 *  on each move from 1.18 (an older Deck ignores it). */
let lit: Element | null = null;
export function paintTerminal(x?: number, y?: number, doc: Document = document) {
  const el = x === undefined || y === undefined ? null : doc.elementFromPoint(x, y);
  const pane = el && (el.closest("[data-drop-paths]") || el.closest(".xterm")) ? el.closest("[data-pane-id]") : null;
  if (pane === lit) return;
  lit?.classList.remove("drop-target");
  pane?.classList.add("drop-target");
  lit = pane;
}

/** True when (`x`, `y`) is over a terminal and the paths were typed there. */
export function dropOnTerminal(paths: string[], x: number, y: number, doc: Document = document): boolean {
  const el = doc.elementFromPoint(x, y);
  // A pane Deck shows as a chat takes the paths into its message box (Deck's filedrop.ts).
  const chat = paths.length ? el?.closest("[data-drop-paths]") : null;
  if (chat) { chat.dispatchEvent(new CustomEvent("deck-drop-paths", { detail: paths })); return true; }
  if (!paths.length || !el?.closest(".xterm")) return false;
  const pane = (el.closest("[data-pane-id]") as HTMLElement | null)?.dataset.paneId;
  if (!pane) return false;
  const quote = (p: string) => (/[\s"'`$&|<>();]/.test(p) ? `"${p.replace(/"/g, '\\"')}"` : p);
  void termWrite(pane, paths.map(quote).join(" ") + " ").catch((e) => console.warn("[vault] typing the path into the terminal failed", e));
  return true;
}
