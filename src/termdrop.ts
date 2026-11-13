// A note dragged out of the tree and let go over one of Deck's terminals: its path typed at the
// terminal's cursor, quoted where a shell needs it, with a space after, as Deck does for a drop from
// Windows Explorer (and for a drag from its own file trees).
import { termWrite } from "../shim/terminals.js";

/** True when (`x`, `y`) is over a terminal and the paths were typed there. */
export function dropOnTerminal(paths: string[], x: number, y: number, doc: Document = document): boolean {
  const el = doc.elementFromPoint(x, y);
  if (!paths.length || !el?.closest(".xterm")) return false;
  const pane = (el.closest("[data-pane-id]") as HTMLElement | null)?.dataset.paneId;
  if (!pane) return false;
  const quote = (p: string) => (/[\s"'`$&|<>();]/.test(p) ? `"${p.replace(/"/g, '\\"')}"` : p);
  void termWrite(pane, paths.map(quote).join(" ") + " ").catch((e) => console.warn("[vault] typing the path into the terminal failed", e));
  return true;
}
