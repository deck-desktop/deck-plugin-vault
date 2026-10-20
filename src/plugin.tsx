// The Vault tab: the Obsidian vault as a tree, a live-preview markdown editor, and backlinks.
//
// Deliberately NOT a second markdown editor. MarkdownLive is Deck's own, reached through
// window.__deck.ui — the same editor the Editor module uses for a .md file, so a note looks and
// behaves the same whichever way it was opened. TreeRow is the same row the Editor's explorer and
// the HTTP client's collections draw, and dragrow is the same pointer-drag behind them.
//
// Only markdown is EDITABLE here. Images, media and source files are shown read-only: editing a
// source file is the Editor module's job, and a second editing path would mean a second autosave
// racing the first over the same folder.
//
// The vault is the user's own Obsidian vault, which Obsidian and whatever syncs it also write to,
// so nothing is cached across sessions and the open note is written back on a debounce, as
// Notes.tsx does it.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronRight, ChevronDown, FileText, Folder, FolderOpen, RefreshCw, Search,
  Link2, Loader2, X, FilePlus2, FolderPlus, Pencil, Trash2, Image as ImageIcon,
  Music, Video, FileCode2, FileQuestion, Eye, Copy, PanelLeft,
} from "lucide-react";
import {
  configRead, configWrite, pickFolder, fsList, fsRead, fsWrite, fsSearch, convertFileSrc, fsReveal,
  fsCreateFile, fsCreateDir, fsRename, fsDelete, fsMove,
  type FsEntry,
} from "../shim/bridge.js";
import {
  MarkdownLive, MarkdownToolbar, cmSurface, TreeRow, TabStrip, ContextMenu, ConfirmDialog,
  NamePrompt, Field, toast, useResize, useRowDrag,
  type MenuEntry, type ConfirmState, type NamePromptState, type TextSurface,
} from "../shim/ui.js";
import type { EditorView } from "@codemirror/view";
import { monaco } from "../shim/monaco.js";
import { listen } from "../shim/event.js";
import {
  resolveLink, backlinkQuery, linksTo, keepEntry, sortEntries, noteTitle, baseName,
  viewerFor, isNote, nameError, isInside, extOf,
  type Note, type Viewer,
} from "./vault";

/** One directory in the tree. `children` is null until the folder is first expanded. */
interface Dir {
  entry: FsEntry;
  children: Dir[] | null;
}

/** An open file. Each tab carries its own text, so switching away never loses an edit. */
interface Tab {
  /** Absolute path, normalised. Also the tab's id. */
  path: string;
  /** The editor's contents. Empty for anything not markdown, which is never read into state. */
  text: string;
  /** What is on disk, so the autosave can tell an edit from a load. */
  saved: string;
  /**
   * VS Code's italic tab: a file opened for a look. At most one exists, and the next preview
   * REPLACES it rather than adding a tab, so browsing the tree does not bury what you are
   * working on. Editing it, double-clicking it, or opening it again promotes it.
   */
  preview: boolean;
}

// Text size for the live markdown editor. The Editor's own numbers, so a note is the same size
// whichever surface it is opened in. Per machine — a font size is a property of this screen.
const ZOOM_KEY = "deck-vault-md-zoom";
const ZOOM_MIN = 10, ZOOM_MAX = 28, ZOOM_DEFAULT = 14;
const loadZoom = () => {
  const n = Number(localStorage.getItem(ZOOM_KEY));
  return Number.isFinite(n) && n >= ZOOM_MIN && n <= ZOOM_MAX ? n : ZOOM_DEFAULT;
};

/** Forward slashes, so a path compares the same whichever API produced it. */
const norm = (p: string) => p.replace(/\\/g, "/");
/** The folder holding a path. */
const dirOf = (p: string) => norm(p).slice(0, norm(p).lastIndexOf("/"));

/** A path relative to the vault root, which is what a wikilink names. */
function relTo(root: string, path: string): string {
  const r = norm(root).replace(/\/$/, "");
  const p = norm(path);
  return p.toLowerCase().startsWith(r.toLowerCase() + "/") ? p.slice(r.length + 1) : p;
}

/** List one directory, filtered and sorted the way the tree wants it. */
async function listDir(dir: string): Promise<FsEntry[]> {
  const raw = await fsList(dir).catch((e) => { console.warn("[vault] folder list failed", e); return [] as FsEntry[]; });
  const kept = raw.filter((e) => keepEntry(e.name, e.dir));
  // sortEntries is written against `isDir` so it can be checked without Deck's FsEntry type.
  return sortEntries(kept.map((e) => ({ ...e, isDir: e.dir })));
}

/**
 * Every note in the vault, walked once.
 *
 * Needed in full because a wikilink is resolved by NAME, not by path — `[[Architecture]]` can
 * only be answered by knowing every note called that. Walked breadth-first with the directories
 * of each level listed concurrently: a vault is wide and shallow, so the depth is small and the
 * fan-out is what costs, and doing a level at a time turns hundreds of serial IPC calls into a
 * handful of rounds.
 *
 * ponytail: no caching between opens and no file watching. A vault of a few thousand notes walks
 * in well under a second, and the alternative is an index that goes stale the moment anything
 * else writes to the vault. Revisit if a vault ever gets big enough to feel it.
 */
async function walkNotes(root: string): Promise<Note[]> {
  const out: Note[] = [];
  let level = [root];
  // A hard depth cap rather than a visited-set: a symlink loop inside a vault would otherwise
  // walk until it ran out of memory, and no real vault is twenty levels deep.
  for (let depth = 0; depth < 20 && level.length; depth++) {
    const listings = await Promise.all(level.map((d) => listDir(d)));
    const next: string[] = [];
    for (const entries of listings) {
      for (const e of entries) {
        if (e.dir) next.push(e.path);
        else out.push({ path: e.path, rel: relTo(root, e.path) });
      }
    }
    level = next;
  }
  return out;
}

/** The icon for a file, by what opening it would show. Lucide, not Deck's icon themes — those
 *  live behind core/icontheme, which uses Vite-only syntax a plugin cannot compile against. */
function iconFor(name: string) {
  switch (viewerFor(name)) {
    case "markdown": return FileText;
    case "image": return ImageIcon;
    case "audio": return Music;
    case "video": return Video;
    case "pdf": return Eye;
    case "binary": return FileQuestion;
    default: return FileCode2;
  }
}

/** A toolbar's icon button, the filled button for the one thing to do next, and the rest. */
const toolBtn = "grid size-7 shrink-0 place-items-center rounded-lg text-text-muted transition-colors hover:bg-white/5 hover:text-text-primary";
const primaryBtn = "flex h-8 items-center gap-1.5 rounded-lg px-3 text-[12.5px] font-medium text-white transition hover:brightness-110";
const secondaryBtn = "flex h-8 items-center gap-1.5 rounded-lg border border-subtle px-3 text-[12.5px] text-text-secondary transition-colors hover:border-strong hover:text-text-primary";

// ---- viewers ---------------------------------------------------------------------------------

/** A read-only Monaco for a text file that is not markdown. */
function TextViewer({ path, text }: { path: string; text: string }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!host.current) return;
    // The model is created with a file URI so Monaco infers the language from the extension —
    // no language map needed here, and it matches what the Editor shows for the same file.
    const uri = monaco.Uri.file(path);
    const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(text, undefined, uri);
    if (model.getValue() !== text) model.setValue(text);
    const ed = monaco.editor.create(host.current, {
      model, readOnly: true, theme: "deck-dark", automaticLayout: true,
      minimap: { enabled: false }, scrollBeyondLastLine: false, fontSize: 13,
    });
    return () => {
      ed.dispose();
      // The model outlives the editor unless disposed, and the next open of the same path would
      // then reuse a model holding the previous contents.
      model.dispose();
    };
  }, [path, text]);
  return <div ref={host} className="h-full w-full" />;
}

/** Whatever a non-markdown file needs. Everything here is read-only. */
function FileViewer({ path, kind }: { path: string; kind: Viewer }) {
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const src = useMemo(() => convertFileSrc(path), [path]);

  useEffect(() => {
    if (kind !== "text") return;
    let live = true;
    setText(null);
    setErr("");
    fsRead(path)
      .then((t) => { if (live) setText(t); })
      .catch((e) => { if (live) setErr(String(e)); });
    return () => { live = false; };
  }, [path, kind]);

  if (kind === "image") {
    return (
      <div className="flex h-full items-center justify-center overflow-auto p-4">
        <img src={src} alt={path} className="max-h-full max-w-full object-contain" />
      </div>
    );
  }
  if (kind === "video") {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <video src={src} controls className="max-h-full max-w-full" />
      </div>
    );
  }
  if (kind === "audio") {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <audio src={src} controls className="w-full max-w-lg" />
      </div>
    );
  }
  if (kind === "pdf") {
    // The webview's own PDF viewer. Nothing to build, and it has search and page navigation.
    return <iframe src={src} title={path} className="h-full w-full border-0" />;
  }
  if (kind === "binary") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1.5 text-[12.5px] text-text-muted">
        <FileQuestion size={18} className="opacity-60" />
        <span>No preview for .{extOf(path)} files.</span>
      </div>
    );
  }
  if (err) {
    return <div className="flex h-full items-center justify-center px-6 text-[12.5px] text-text-muted">{err}</div>;
  }
  if (text === null) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-[12.5px] text-text-muted">
        <Loader2 size={14} className="animate-spin" /> Reading…
      </div>
    );
  }
  return <TextViewer path={path} text={text} />;
}

// ---- the tree --------------------------------------------------------------------------------

function Row({ node, depth, root, openPath, expanded, drag, onToggle, onOpen, onOpenPermanent, onMenu }: {
  node: Dir; depth: number; root: string; openPath: string | null;
  expanded: Set<string>;
  drag: ReturnType<typeof useRowDrag>;
  onToggle: (d: Dir) => void; onOpen: (path: string) => void;
  /** Double-click: open in a tab that sticks, rather than the preview slot. */
  onOpenPermanent: (path: string) => void;
  onMenu: (e: React.MouseEvent, node: Dir) => void;
}) {
  const path = norm(node.entry.path);
  const isOpen = expanded.has(path);
  const Icon = node.entry.dir ? (isOpen ? FolderOpen : Folder) : iconFor(node.entry.name);
  return (
    <>
      <TreeRow
        depth={depth}
        active={openPath === path}
        dropHint={drag.over?.id === path && drag.dragId !== path}
        leading={node.entry.dir
          ? (isOpen ? <ChevronDown size={13} className="shrink-0 text-text-muted" />
                    : <ChevronRight size={13} className="shrink-0 text-text-muted" />)
          : <span className="w-[13px] shrink-0" />}
        label={
          <span className="flex min-w-0 items-center gap-1.5">
            <Icon size={14} className="shrink-0 opacity-70" />
            <span className="truncate">{node.entry.dir ? node.entry.name : noteTitle(node.entry.name)}</span>
          </span>
        }
        title={relTo(root, node.entry.path)}
        onClick={() => (node.entry.dir ? onToggle(node) : onOpen(node.entry.path))}
        onDoubleClick={() => { if (!node.entry.dir) onOpenPermanent(node.entry.path); }}
        onContextMenu={(e) => onMenu(e, node)}
        dragId={path}
        dragParentId={dirOf(node.entry.path)}
        dragKind={node.entry.dir ? "folder" : "file"}
        onMouseDown={drag.startDrag(path)}
      />
      {node.entry.dir && isOpen && node.children?.map((c) => (
        <Row key={c.entry.path} node={c} depth={depth + 1} root={root} openPath={openPath}
          expanded={expanded} drag={drag} onToggle={onToggle} onOpen={onOpen}
          onOpenPermanent={onOpenPermanent} onMenu={onMenu} />
      ))}
    </>
  );
}

// ---- the tab ---------------------------------------------------------------------------------

export default function Vault() {
  const [root, setRoot] = useState("");
  const [tree, setTree] = useState<Dir[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);

  // The open file. `text` is what the editor holds and `saved` what is on disk, so the autosave
  // can tell an edit from a load. Only markdown uses them; everything else is read-only.
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [openPath, setOpenPath] = useState<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const activeTab = tabs.find((t) => t.path === openPath) ?? null;
  const text = activeTab?.text ?? "";

  /** Replace one tab, by path. */
  const patchTab = useCallback((path: string, patch: Partial<Tab>) => {
    setTabs((ts) => ts.map((t) => (t.path === path ? { ...t, ...patch } : t)));
  }, []);

  const setText = useCallback((v: string) => {
    if (!openPath) return;
    setTabs((ts) => ts.map((t) => {
      if (t.path !== openPath) return t;
      // A REAL edit promotes a preview tab, exactly as double-clicking it would: you are no
      // longer glancing at the file, so the next single click must not replace it.
      //
      // Compared against what is on disk rather than promoting on any call: CodeMirror fires
      // onChange when the document is first set, so simply opening a note counted as an edit and
      // promoted its tab immediately — which made every note a permanent tab and left nothing
      // for the preview slot to replace.
      return { ...t, text: v, preview: t.preview && v === t.saved };
    }));
  }, [openPath]);

  const [filter, setFilter] = useState("");
  const [backlinks, setBacklinks] = useState<{ note: Note; line: string }[] | null>(null);

  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuEntry[] } | null>(null);
  const [naming, setNaming] = useState<NamePromptState | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);

  const [paneW, paneHandle] = useResize({ initial: 260, min: 0, max: 560, direction: "horizontal" });
  // In a narrow pane the tree is a drawer over the note, opened from the toggle above it, rather
  // than a column that would leave the note a sliver. Measured here rather than with a Deck hook so
  // the plugin keeps working on a Deck that has none.
  // A ref callback, so measuring starts whenever the element appears (it is not there while the
  // vault is loading, and an effect reading a ref on mount never ran again).
  const [rootEl, rootRef] = useState<HTMLDivElement | null>(null);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    if (!rootEl) return;
    const ro = new ResizeObserver(([e]) => setNarrow(e.contentRect.width < 620));
    ro.observe(rootEl);
    return () => ro.disconnect();
  }, [rootEl]);
  const [treeOpen, setTreeOpen] = useState(false);
  const drawer = narrow && treeOpen;
  useEffect(() => { setTreeOpen(false); }, [openPath]);

  // The live editor, handed out by MarkdownLive, so the toolbar can dispatch INTO it rather than
  // rewriting the string around it — which is what keeps one Ctrl+Z undoing one Bold.
  const [mdView, setMdView] = useState<EditorView | null>(null);
  const surface: TextSurface | null = useMemo(() => (mdView ? cmSurface(mdView) : null), [mdView]);

  const [zoom, setZoom] = useState(loadZoom);
  const nudgeZoom = useCallback((d: number) => setZoom((z) => {
    const next = d === 0 ? ZOOM_DEFAULT : Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z + d));
    localStorage.setItem(ZOOM_KEY, String(next));
    return next;
  }), []);

  const openKind: Viewer | null = openPath ? viewerFor(openPath) : null;

  // ---- loading -------------------------------------------------------------------------------

  const load = useCallback(async () => {
    setLoading(true);
    const r = await getVaultRoot().catch((e) => { console.warn("[vault] vault root read failed", e); return ""; });
    setRoot(r);
    if (!r) { setLoading(false); return; }
    const [top, all] = await Promise.all([listDir(r), walkNotes(r)]);
    setTree(top.map((entry) => ({ entry, children: null })));
    setNotes(all);
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);
  // The folder is chosen in this plugin's settings, or from the empty state below; either way
  // it lands in vault-root.json, and the tab follows.
  useEffect(() => {
    const un = listen<string[]>("config-changed", (e) => { if (e.payload.includes("vault-root")) void load(); });
    return () => { void un.then((f) => f()); };
  }, [load]);

  /**
   * Re-read the folders that are currently open, keeping them open.
   *
   * After a file operation, rather than reloading the whole tree: collapsing every folder because
   * a note was renamed loses the place you were working in.
   */
  const refreshTree = useCallback(async () => {
    if (!root) return;
    const top = await listDir(root);
    const build = async (entries: FsEntry[]): Promise<Dir[]> => Promise.all(
      entries.map(async (entry): Promise<Dir> => {
        if (!entry.dir || !expanded.has(norm(entry.path))) return { entry, children: null };
        return { entry, children: await build(await listDir(entry.path)) };
      }),
    );
    setTree(await build(top));
    setNotes(await walkNotes(root));
  }, [root, expanded]);

  const toggle = async (d: Dir) => {
    const path = norm(d.entry.path);
    const next = new Set(expanded);
    if (next.has(path)) { next.delete(path); setExpanded(next); return; }
    next.add(path);
    if (!d.children) {
      const kids = await listDir(d.entry.path);
      // Mutating the node and copying only the root array: rebuilding the whole tree on every
      // expand would discard the children of every other folder already open.
      d.children = kids.map((entry) => ({ entry, children: null }));
      setTree((t) => [...t]);
    }
    setExpanded(next);
  };

  // ---- opening and saving --------------------------------------------------------------------

  // The live tab list, for callbacks that run after an await and would otherwise act on the
  // array captured when they were created.
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  // The live tree, for the same reason — revealInTree walks it across awaits.
  const treeRef = useRef(tree);
  treeRef.current = tree;

  /** Write one tab to disk if it differs from what was read. */
  const writeTab = useCallback(async (t: Tab) => {
    if (!isNote(t.path) || t.text === t.saved) return;
    await fsWrite(t.path, t.text)
      .then(() => patchTab(t.path, { saved: t.text }))
      .catch((e) => toast(String(e), "error"));
  }, [patchTab]);

  /** Flush the pending edit before anything that would replace or discard it. */
  const flush = useCallback(async () => {
    if (saveTimer.current === undefined) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = undefined;
    if (activeTab) await writeTab(activeTab);
  }, [activeTab, writeTab]);

  /**
   * Open a file in a tab.
   *
   * `preview` follows VS Code: a single click opens the file in the one preview slot, and the
   * next single click REPLACES it rather than adding a tab. Opening a file that is already open
   * promotes it — asking for it twice is the "I actually want this" signal.
   */
  /**
   * Expand the folders above a file and scroll its row into view.
   *
   * The same shape as the Editor's revealInTree, including the two things that took it several
   * goes: the row is polled for rather than scrolled to immediately (expanding lazily-loaded
   * folders takes several renders), and only the tree's OWN scroll box is moved —
   * scrollIntoView bubbles to every scrollable ancestor and drags Deck's whole frame with it.
   */
  const revealInTree = useCallback(async (path: string) => {
    const nRoot = norm(root), nFile = norm(path);
    if (!nRoot || !nFile.toLowerCase().startsWith(nRoot.toLowerCase() + "/")) return;

    const rel = nFile.slice(nRoot.length + 1).split("/");
    const toOpen: string[] = [];
    let nodes = treeRef.current;
    let acc = nRoot;
    for (let i = 0; i < rel.length - 1; i++) {
      acc = `${acc}/${rel[i]}`;
      const node = nodes.find((n) => norm(n.entry.path).toLowerCase() === acc.toLowerCase());
      if (!node) break;
      toOpen.push(norm(node.entry.path));
      if (node.children === null) {
        node.children = (await listDir(node.entry.path)).map((entry) => ({ entry, children: null }));
        setTree((t) => [...t]);
      }
      nodes = node.children;
    }
    if (toOpen.length) setExpanded((s) => new Set([...s, ...toOpen]));

    let tries = 0;
    const tryScroll = () => {
      // Within this view: in a floating window the main page does not have the row.
      const el = (rootEl ?? document).querySelector<HTMLElement>(`[data-drag-id="${CSS.escape(nFile)}"]`);
      if (el) {
        let box: HTMLElement | null = el.parentElement;
        while (box && getComputedStyle(box).overflowY !== "auto") box = box.parentElement;
        if (box) {
          const er = el.getBoundingClientRect(), br = box.getBoundingClientRect();
          if (er.top < br.top || er.bottom > br.bottom) {
            box.scrollTop += er.top - br.top - box.clientHeight / 2 + el.clientHeight / 2;
          }
        }
        return;
      }
      if (tries++ < 20) requestAnimationFrame(tryScroll); // ~20 frames, then give up
    };
    requestAnimationFrame(tryScroll);
  }, [root, rootEl]);

  const open = useCallback(async (path: string, preview = true) => {
    await flush();
    setBacklinks(null);
    const p = norm(path);

    // tabsRef, never the `tabs` captured when this callback was made: there are two awaits below
    // and one above, so by the time any of this runs the captured array can be several opens out
    // of date — which showed up as the preview slot never being found and tabs piling up.
    const existing = tabsRef.current.find((t) => t.path === p);
    if (existing) {
      if (existing.preview) patchTab(p, { preview: false });
      setOpenPath(p);
      return;
    }

    // Only markdown is read into state. Everything else is handed to FileViewer, which reads it
    // itself or points an element at the file — fsRead decodes as UTF-8 and would mangle a binary.
    let body = "";
    if (isNote(p)) {
      const read = await fsRead(p).catch((e) => { toast(String(e), "error"); return null; });
      if (read === null) return;
      body = read;
    }
    const tab: Tab = { path: p, text: body, saved: body, preview };

    setTabs((ts) => {
      if (!preview) return [...ts, tab];
      // Never take the slot from a preview tab with unsaved edits: an edit promotes a tab, but
      // one arriving by some other path would otherwise be discarded silently. Falls through to
      // appending, so nothing is lost.
      const at = ts.findIndex((t) => t.preview && t.text === t.saved);
      if (at === -1) return [...ts, tab];
      const next = [...ts];
      next[at] = tab;
      return next;
    });
    setOpenPath(p);
  }, [flush, patchTab]);

  const closeTab = useCallback((path: string) => {
    const t = tabsRef.current.find((x) => x.path === path);
    // Write on the way out rather than prompting: this is a notes app over a synced folder, and
    // an unsaved-changes dialog for a note you were typing in would be the wrong question.
    if (t) void writeTab(t);
    setTabs((ts) => {
      const at = ts.findIndex((x) => x.path === path);
      const next = ts.filter((x) => x.path !== path);
      // Focus the neighbour, the way every editor does — the tab to the right, or the last one.
      if (openPath === path) setOpenPath(next.length ? (next[Math.min(at, next.length - 1)]?.path ?? null) : null);
      return next;
    });
  }, [openPath, writeTab]);

  /**
   * A file moved: point the tabs under `from` at `to`.
   *
   * Prefix-based rather than an equality check, so renaming a FOLDER carries the tabs of every
   * note inside it rather than leaving them pointing at paths that no longer exist.
   */
  const retarget = useCallback((from: string, to: string) => {
    const f = norm(from), t = norm(to);
    const moved = (p: string) => (p === f ? t : isInside(f, p) ? t + p.slice(f.length) : p);
    setTabs((ts) => ts.map((tab) => ({ ...tab, path: moved(tab.path) })));
    setOpenPath((cur) => (cur ? moved(cur) : cur));
  }, []);

  // Autosave. Same shape as Notes.tsx: a debounce, and the baseline set by whoever loaded the
  // text so a fresh load is never mistaken for an edit and written straight back.
  useEffect(() => {
    if (!activeTab || !isNote(activeTab.path) || activeTab.text === activeTab.saved) return;
    clearTimeout(saveTimer.current);
    const { path, text: body } = activeTab;
    saveTimer.current = setTimeout(() => {
      saveTimer.current = undefined;
      fsWrite(path, body).then(() => patchTab(path, { saved: body }))
        .catch((e) => toast(String(e), "error"));
    }, 600);
    return () => clearTimeout(saveTimer.current);
  }, [activeTab, patchTab]);

  // Edits still in the debounce must not be lost when the tab unmounts — modules and plugins both
  // unmount on navigation. EVERY dirty tab, not just the active one: switching tabs leaves the
  // previous one's edit written already, but a failed write would otherwise vanish here.
  useEffect(() => () => {
    clearTimeout(saveTimer.current);
    for (const t of tabsRef.current) {
      if (isNote(t.path) && t.text !== t.saved) void fsWrite(t.path, t.text);
    }
  }, []);

  // ---- file operations -----------------------------------------------------------------------

  /** Run a file operation, then re-read the tree and report a failure with what the OS said. */
  const act = useCallback(async (fn: () => Promise<unknown>, failed: string) => {
    try {
      await fn();
      await refreshTree();
    } catch (e) {
      toast(`${failed}: ${String(e).replace(/^Error:\s*/, "")}`, "error");
    }
  }, [refreshTree]);

  const askNew = (dir: string, kind: "note" | "folder") => {
    setNaming({
      title: kind === "note" ? "New note" : "New folder",
      subtitle: root ? relTo(root, dir) || "the vault root" : dir,
      placeholder: kind === "note" ? "Name" : "Folder name",
      confirmLabel: "Create",
      onSave: (value) => {
        const bad = nameError(value);
        if (bad) { toast(bad, "error"); return; }
        const name = value.trim();
        void act(async () => {
          if (kind === "folder") {
            await fsCreateDir(dir, name);
          } else {
            // .md unless a different extension was typed, so "Meeting" makes a note rather than
            // an extensionless file that then opens in the read-only viewer.
            const created = await fsCreateFile(dir, extOf(name) ? name : `${name}.md`);
            await open(created);
          }
          // The new item is inside this folder, so show it rather than leaving it collapsed.
          setExpanded((s) => new Set(s).add(norm(dir)));
        }, "Could not create it");
      },
    });
  };

  const askRename = (node: Dir) => {
    setNaming({
      title: "Rename",
      subtitle: root ? relTo(root, node.entry.path) : node.entry.path,
      initial: node.entry.name,
      confirmLabel: "Rename",
      onSave: (value) => {
        const bad = nameError(value);
        if (bad) { toast(bad, "error"); return; }
        const name = value.trim();
        if (name === node.entry.name) return;
        void act(async () => {
          const moved = await fsRename(node.entry.path, name);
          // Every tab under the old path follows it, or it would point at a file that no longer
          // exists — including tabs that are not the active one when a FOLDER was renamed.
          retarget(norm(node.entry.path), norm(moved));
        }, "Could not rename it");
      },
    });
  };

  const askDelete = (node: Dir) => {
    const rel = root ? relTo(root, node.entry.path) : node.entry.path;
    setConfirm({
      title: node.entry.dir ? "Delete this folder?" : "Delete this file?",
      body: (
        <>
          <p className="mb-2">
            {node.entry.dir
              ? "The folder and everything inside it are deleted."
              : "The file is deleted."}
            {" "}It goes to the Recycle Bin.
          </p>
          <p className="font-mono text-[12px] text-text-muted">{rel}</p>
        </>
      ),
      confirmLabel: "Delete",
      danger: true,
      onConfirm: () => void act(async () => {
        await fsDelete(node.entry.path);
        // Close every tab under what was deleted, not just the active one.
        const gone = norm(node.entry.path);
        setTabs((ts) => {
          const next = ts.filter((t) => !isInside(gone, t.path));
          setOpenPath((cur) => (cur && isInside(gone, cur) ? next[0]?.path ?? null : cur));
          return next;
        });
      }, "Could not delete it"),
    });
  };

  // Dragging a row onto a folder moves it there. The drop target is hit-tested from the cursor
  // (see components/dragrow.ts) because HTML5 drag does not work in this window at all.
  const drag = useRowDrag((dragId, target) => {
    if (!target || target.id === dragId) return;
    // A drop on a file means its folder — the row under the cursor is the insertion point, and
    // "into this note" is not a thing a filesystem can do.
    const dest = target.kind === "folder" ? target.id : dirOf(target.id);
    if (dirOf(dragId) === dest) return; // already there
    if (isInside(dragId, dest)) {
      toast("A folder cannot be moved inside itself", "error");
      return;
    }
    void act(async () => {
      // "rename" rather than "fail": two notes of the same name in different folders is normal,
      // and losing the drop because of it would be worse than a suffixed copy.
      await fsMove(dragId, dest, "rename");
      retarget(dragId, `${dest}/${dragId.slice(dragId.lastIndexOf("/") + 1)}`);
    }, "Could not move it");
  });

  const rowMenu = (e: React.MouseEvent, node: Dir) => {
    e.preventDefault();
    const dir = node.entry.dir ? node.entry.path : dirOf(node.entry.path);
    setMenu({
      x: e.clientX, y: e.clientY,
      items: [
        { label: "New note", icon: FilePlus2, onClick: () => askNew(dir, "note") },
        { label: "New folder", icon: FolderPlus, onClick: () => askNew(dir, "folder") },
        "sep",
        { label: "Rename", icon: Pencil, onClick: () => askRename(node) },
        { label: "Delete", icon: Trash2, danger: true, onClick: () => askDelete(node) },
        "sep",
        { label: "Reveal in Explorer", icon: FolderOpen, onClick: () => void fsReveal(node.entry.path).catch((err) => toast(String(err), "error")) },
        {
          label: "Copy path", icon: Copy,
          onClick: () => void navigator.clipboard.writeText(node.entry.path)
            .then(() => toast("Path copied"))
            .catch((err) => toast(String(err), "error")),
        },
        {
          label: "Copy vault path", icon: Copy,
          onClick: () => void navigator.clipboard.writeText(relTo(root, node.entry.path))
            .then(() => toast("Path copied"))
            .catch((err) => toast(String(err), "error")),
        },
        ...(node.entry.dir || !isNote(node.entry.path) ? [] : [{
          // What you paste into another note to link here.
          label: "Copy as wikilink", icon: Link2,
          onClick: () => void navigator.clipboard.writeText(`[[${noteTitle(node.entry.name)}]]`)
            .then(() => toast("Wikilink copied"))
            .catch((err) => toast(String(err), "error")),
        }]),
      ],
    });
  };

  // ---- wikilinks -----------------------------------------------------------------------------

  const openRel = openPath && root ? relTo(root, openPath) : "";

  /**
   * Notes to offer for a `[[` being typed.
   *
   * The target written into the document is the SHORTEST thing that resolves back to this note:
   * its basename when that is unambiguous, and the full path only when two notes share a name.
   * Writing the path every time would work and read badly.
   */
  const wikiOptions = useCallback((query: string) => {
    const q = query.trim().toLowerCase();
    const byName = new Map<string, number>();
    for (const n of notes) {
      const b = baseName(n.rel).toLowerCase();
      byName.set(b, (byName.get(b) ?? 0) + 1);
    }
    return notes
      .filter((n) => !q || n.rel.toLowerCase().includes(q))
      // A name match sorts above a match somewhere in the path, then shortest path first.
      .sort((a, b) => {
        const an = baseName(a.rel).toLowerCase().startsWith(q) ? 0 : 1;
        const bn = baseName(b.rel).toLowerCase().startsWith(q) ? 0 : 1;
        if (an !== bn) return an - bn;
        const d = a.rel.split("/").length - b.rel.split("/").length;
        return d !== 0 ? d : a.rel.localeCompare(b.rel);
      })
      .slice(0, 50)
      .map((n) => {
        const name = baseName(n.rel);
        const unique = (byName.get(name.toLowerCase()) ?? 0) <= 1;
        return {
          target: unique ? name : n.rel.replace(/\.md$/i, ""),
          label: name,
          detail: n.rel.slice(0, n.rel.lastIndexOf("/") + 1) || undefined,
        };
      });
  }, [notes]);

  /**
   * Where an `![[file.png]]` embed's file lives.
   *
   * By name across the whole vault, which is how Obsidian resolves an embed — an attachments
   * folder is the normal arrangement and a note rarely sits beside its images. A path with a
   * slash is honoured as written, from the vault root.
   */
  const resolveEmbed = useCallback((name: string): string | null => {
    const want = name.trim().replace(/\\/g, "/").toLowerCase();
    if (!want) return null;
    const hit = want.includes("/")
      ? notes.find((n) => n.rel.toLowerCase() === want)
      : notes.find((n) => n.rel.slice(n.rel.lastIndexOf("/") + 1).toLowerCase() === want);
    return hit?.path ?? null;
  }, [notes]);

  /** Does this wikilink point at a note that exists? Drives the dimming of a dead link. */
  const linkExists = useCallback(
    (target: string) => !!resolveLink(target, notes, openRel),
    [notes, openRel]);

  /**
   * Follow a wikilink. Bound through the DOM rather than a CodeMirror extension, because
   * MarkdownLive is Deck's component and this plugin does not get to add extensions to it.
   */
  const follow = useCallback((target: string) => {
    const hit = resolveLink(target, notes, openRel);
    if (!hit) { toast(`No note called "${target}"`, "error"); return; }
    void open(hit.path);
  }, [notes, openRel, open]);

  // The links in the open note, for the footer. Cheap enough to recompute on every keystroke —
  // it is one regex pass over one document.
  // Counts for the status bar. One pass over the document, recomputed as you type — cheap enough
  // that memoising it is only about not doing it on unrelated renders.
  const counts = useMemo(() => ({
    words: text.split(/\s+/).filter(Boolean).length,
    chars: text.length,
  }), [text]);

  // How many notes link here, counted when a note is opened so the status bar can say so without
  // being asked. `live` guards against a slow search for the previous note landing after this one
  // has already been opened.
  const [backCount, setBackCount] = useState<number | null>(null);
  useEffect(() => {
    if (!openPath || !root || !isNote(openPath)) { setBackCount(null); return; }
    let live = true;
    setBackCount(null);
    void backlinksFor(openPath).then((b) => { if (live) setBackCount(b.length); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openPath, root, notes]);

  /** Find every note linking to the open one. */
  /**
   * Every note linking to `path`, resolved rather than merely matching.
   *
   * One function for both the count in the status bar and the list it opens: the count IS the
   * length of the list, and computing it two ways is how the two drift apart.
   */
  const backlinksFor = useCallback(async (path: string): Promise<{ note: Note; line: string }[]> => {
    const rel = relTo(root, path);
    const target: Note = { path, rel };
    const hits = await fsSearch(root, backlinkQuery(rel), {
      caseSensitive: false, isRegex: false, wholeWord: false, includes: "*.md", excludes: "",
    }).catch((e) => { console.warn("[vault] backlink search failed", e); return []; });

    // fsSearch's query is a prefix, so every hit is re-checked by actually resolving its links —
    // otherwise [[Meeting Notes]] would come back as a backlink of [[Meeting]].
    const out: { note: Note; line: string }[] = [];
    const seen = new Set<string>();
    for (const h of hits as { path: string; line: number; text: string }[]) {
      const r = relTo(root, h.path);
      if (r === rel || seen.has(r)) continue; // a note linking to itself is not a backlink
      if (!linksTo(h.text, target, notes, r)) continue;
      seen.add(r);
      out.push({ note: { path: h.path, rel: r }, line: h.text.trim() });
    }
    return out;
  }, [root, notes]);

  const findBacklinks = async () => {
    if (!openPath || !root) return;
    setBacklinks(await backlinksFor(openPath));
  };

  // ---- render --------------------------------------------------------------------------------

  const shown = useMemo(() => {
    if (!filter.trim()) return null;
    const q = filter.trim().toLowerCase();
    return notes.filter((n) => n.rel.toLowerCase().includes(q)).slice(0, 200);
  }, [filter, notes]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-[12.5px] text-text-muted">
        <Loader2 size={14} className="animate-spin" /> Reading the vault…
      </div>
    );
  }

  if (!root) {
    return (
      <div className="flex h-full items-center justify-center px-6">
        <div className="flex max-w-[420px] items-start gap-2.5 rounded-lg border border-subtle px-3.5 py-3.5 text-[12.5px] leading-relaxed text-text-muted"
          style={{ background: "var(--bg-elev)" }}>
          <FolderOpen size={16} className="mt-0.5 shrink-0" />
          <div className="flex flex-col items-start gap-3">
            <span>No vault folder is set. Choose the folder that holds your notes; an Obsidian vault works as it is.</span>
            <button onClick={() => void chooseVault()} className={primaryBtn} style={{ background: "var(--accent)" }}>
              Choose folder…
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div ref={rootRef} className="relative flex h-full min-h-0">
      {/* The drawer's backdrop: a click beside it closes it. */}
      {drawer && <div className="absolute inset-0 z-20 bg-black/40" onClick={() => setTreeOpen(false)} />}
      {/* Tree */}
      <div className={"flex min-h-0 shrink-0 flex-col border-r border-subtle bg-panel/80 backdrop-blur-xl blur-surface "
          + (narrow ? (drawer ? "absolute inset-y-0 left-0 z-30 shadow-2xl" : "hidden") : "")}
        style={{ width: narrow ? `min(${paneW}px, 85%)` : paneW, ...(drawer ? { background: "var(--bg-panel)" } : {}) }}>
        <div className="flex shrink-0 items-center gap-0.5 px-2 pb-1 pt-2">
          {/* The filter, with its clear button inside the box. */}
          <div className="mr-0.5 flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-lg border border-subtle pl-2 pr-1 transition-colors focus-within:border-[var(--accent)]"
            style={{ background: "var(--bg-elev)" }}>
            <Search size={13} className="shrink-0 text-text-muted" />
            <input
              value={filter} onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter notes"
              className="min-w-0 flex-1 bg-transparent text-[12.5px] text-text-primary outline-none placeholder:text-text-muted"
            />
            {filter && (
              <button onClick={() => setFilter("")} title="Clear the filter"
                className="grid size-5 shrink-0 place-items-center rounded text-text-muted transition-colors hover:bg-white/10 hover:text-text-primary">
                <X size={12} />
              </button>
            )}
          </div>
          <button onClick={() => askNew(root, "note")} title="New note in the vault root" className={toolBtn}>
            <FilePlus2 size={14} />
          </button>
          <button onClick={() => askNew(root, "folder")} title="New folder in the vault root" className={toolBtn}>
            <FolderPlus size={14} />
          </button>
          <button onClick={() => void load()} title="Re-read the vault" className={toolBtn}>
            <RefreshCw size={14} />
          </button>
        </div>
        <div className="scroll-thin min-h-0 flex-1 overflow-auto px-1 py-1">
          {shown
            ? shown.map((n) => {
                const Icon = iconFor(n.rel);
                return (
                  <TreeRow key={n.rel} depth={0}
                    active={openPath === norm(n.path)}
                    leading={<span className="w-[13px] shrink-0" />}
                    label={
                      <span className="flex min-w-0 items-center gap-1.5">
                        <Icon size={14} className="shrink-0 opacity-70" />
                        <span className="truncate">{noteTitle(n.rel)}</span>
                      </span>
                    }
                    title={n.rel}
                    onClick={() => void open(n.path)}
                    onDoubleClick={() => void open(n.path, false)} />
                );
              })
            : tree.map((n) => (
                <Row key={n.entry.path} node={n} depth={0} root={root} openPath={openPath}
                  expanded={expanded} drag={drag}
                  onToggle={(d) => void toggle(d)} onOpen={(p) => void open(p)}
                  onOpenPermanent={(p) => void open(p, false)} onMenu={rowMenu} />
              ))}
          {shown?.length === 0 && (
            <p className="px-2.5 py-2 text-[12px] leading-relaxed text-text-muted">No note matches. Clear the filter to see the whole vault.</p>
          )}
        </div>
        <div className="shrink-0 px-3 py-1.5 text-[11px] text-text-muted">
          {notes.length} files
        </div>
      </div>

      {!narrow && <div {...paneHandle} className="w-1 shrink-0 cursor-col-resize hover:bg-accent/30" />}

      {/* Editor. Nearly opaque, unlike the tree, for the same reason the HTTP module's main pane
          is: prose is drawn straight onto the panel, so a wallpaper sits directly behind the text
          and makes it unreadable in a way a card-based layout never is. The strength is the
          "Panel opacity" setting, and with no wallpaper the variable is just the plain colour. */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col"
        style={{ background: "var(--bg-panel-glass)" }}>
        {/* In a narrow pane the tree's toggle sits at the start of the tab row. */}
        <div className="flex min-w-0 items-stretch">
        {narrow && (
          <div className="flex h-9 shrink-0 items-center border-b border-subtle pl-1.5">
            <button onClick={() => setTreeOpen((o) => !o)} title={treeOpen ? "Hide notes" : "Show notes"} aria-pressed={treeOpen}
              className={toolBtn} style={treeOpen ? { background: "var(--accent-soft)", color: "var(--text-primary)" } : undefined}>
              <PanelLeft size={15} />
            </button>
          </div>
        )}
        <div className="min-w-0 flex-1">
        {tabs.length > 0 && (
          <TabStrip
            chip
            tabs={tabs.map((t) => {
              const Icon = iconFor(t.path);
              return {
                id: t.path,
                title: noteTitle(relTo(root, t.path)),
                icon: <Icon size={13} className="shrink-0 opacity-70" />,
                dirty: t.text !== t.saved,
                preview: t.preview,
              };
            })}
            activeId={openPath}
            onSelect={(id) => { void open(id); void revealInTree(id); }}
            onClose={closeTab}
            // Double-clicking the tab promotes it, the same signal as double-clicking in the tree.
            onDoubleClick={(id) => patchTab(id, { preview: false })}
            onReorder={(from, to) => setTabs((ts) => {
              const a = ts.findIndex((t) => t.path === from);
              const b = ts.findIndex((t) => t.path === to);
              if (a < 0 || b < 0) return ts;
              const next = [...ts];
              next.splice(b, 0, ...next.splice(a, 1));
              return next;
            })}
            trailing={openKind === "markdown" ? (
              <button onClick={() => void findBacklinks()}
                title="Find notes linking here"
                className="flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-2 text-[12px] text-text-muted transition-colors hover:bg-white/5 hover:text-text-primary">
                <Link2 size={13} /> Backlinks
              </button>
            ) : openPath ? (
              // The one thing the removed path row said that the tab does not: this file cannot
              // be edited here.
              <span className="shrink-0 rounded-full px-1.5 py-px text-[10.5px] text-text-muted" style={{ background: "var(--bg-elev)" }}>
                Read-only
              </span>
            ) : undefined}
          />
        )}
        </div>
        </div>
        {openPath ? (
          <>
            {/* No path row: the tab already names the file, and its tooltip carries the full
                path for the times that is actually the question. */}
            <div className="min-h-0 flex-1">
              {openKind === "markdown" ? (
                // onClick on the wrapper, not the editor: MarkdownLive renders raw `[[Name]]`
                // text, so a click is caught here and the word under the caret parsed for a link.
                <div className="flex h-full flex-col"
                  onWheel={(e) => { if (e.ctrlKey) nudgeZoom(e.deltaY < 0 ? 1 : -1); }}>
                  {/* One toolbar, INSIDE the relative wrapper. It reads Deck's "Floating markdown
                      toolbar" setting and either sits above the note or floats over the
                      selection — and a floating bar is positioned against the nearest positioned
                      ancestor, so outside this wrapper it anchored to the window instead and
                      hung off the left of the pane. */}
                  <div className="relative flex min-h-0 flex-1 flex-col">
                    <MarkdownToolbar surface={surface} zoom={zoom} onZoom={nudgeZoom} view={mdView} />
                    {/* min-h-0 so the editor scrolls rather than growing the flex column. */}
                    <div className="min-h-0 flex-1">
                    <MarkdownLive value={text} path={openPath} onChange={setText}
                      onSave={() => void flush()} onView={setMdView} fontSize={zoom}
                      onWikiLink={follow} resolveWikiLink={linkExists}
                      wikiLinkOptions={wikiOptions} mermaid resolveEmbed={resolveEmbed}
                      // Left-aligned, not a centred document column: the pane is already narrowed
                      // by the tree beside it, and a second set of margins wastes what is left.
                      flush />
                    </div>
                  </div>
                </div>
              ) : (
                <FileViewer path={openPath} kind={openKind ?? "text"} />
              )}
            </div>
            {/* Status bar. The counts are always there; the backlinks list only opens when the
                count is clicked, so a note's own text keeps the height by default. */}
            <div className="flex shrink-0 flex-col border-t border-subtle">
              {backlinks && backlinks.length > 0 && (
                <div className="scroll-thin max-h-40 overflow-auto px-1.5 py-1.5 text-[12.5px]">
                  {backlinks.map((b) => (
                    <button key={b.note.rel} onClick={() => void open(b.note.path)}
                      className="flex w-full flex-col items-start rounded-md px-2 py-1 text-left transition-colors hover:bg-white/5">
                      <span className="text-text-primary">{noteTitle(b.note.rel)}</span>
                      <span className="w-full truncate text-[11px] text-text-muted">{b.line}</span>
                    </button>
                  ))}
                </div>
              )}
              <div className="flex h-7 items-center justify-end gap-0.5 px-2 text-[11px] text-text-muted">
                {openKind === "markdown" && (
                  <>
                    <button
                      onClick={() => (backlinks ? setBacklinks(null) : void findBacklinks())}
                      disabled={backCount === 0}
                      title={backCount === 0 ? "No notes link here" : "Show the notes linking here"}
                      aria-pressed={!!backlinks}
                      className="flex h-5 items-center rounded-md px-1.5 transition-colors hover:bg-white/5 hover:text-text-primary disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-text-muted"
                      style={backlinks ? { background: "var(--accent-soft)", color: "var(--text-primary)" } : undefined}>
                      {backCount === null ? "…" : `${backCount} backlink${backCount === 1 ? "" : "s"}`}
                    </button>
                    <i aria-hidden className="mx-1 h-3.5 w-px bg-white/10" />
                    <span className="px-1.5">{counts.words.toLocaleString()} words</span>
                    <span className="px-1.5">{counts.chars.toLocaleString()} characters</span>
                  </>
                )}
                {openKind !== "markdown" && <span className="px-1.5">Read-only</span>}
              </div>
            </div>
          </>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-[12.5px] text-text-muted">
            <span>Open a note from the tree, or start a new one.</span>
            <div className="flex flex-wrap justify-center gap-2">
              <button onClick={() => askNew(root, "note")} className={primaryBtn} style={{ background: "var(--accent)" }}>
                <FilePlus2 size={14} /> New note
              </button>
              {narrow && (
                <button onClick={() => setTreeOpen(true)} className={secondaryBtn} style={{ background: "var(--bg-elev)" }}>
                  <PanelLeft size={14} /> Show notes
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />
      )}
      <NamePrompt state={naming} onClose={() => setNaming(null)} />
      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}

/** The vault folder, "" when none is set. Its own config: a JSON string, `"C:\\Users\\me\\obsidian"`. */
async function getVaultRoot(): Promise<string> {
  const t = await configRead("vault-root");
  try { return t.trim() ? String(JSON.parse(t)) : ""; } catch { return t.trim().replace(/^"|"$/g, ""); }
}
const setVaultRoot = (dir: string) => configWrite("vault-root", dir.trim() ? JSON.stringify(dir.trim()) : "");

/** Pick the vault folder. The tab reloads on the change (config-changed). */
async function chooseVault(): Promise<string> {
  const dir = await pickFolder().catch((e) => { console.warn("[vault] folder picker failed", e); return ""; });
  if (dir) await setVaultRoot(dir).catch((e) => console.warn("[vault] vault root save failed", e));
  return dir;
}

/** Settings > Plugins > Vault: which folder the tab browses. */
export function Settings() {
  const [root, setRoot] = useState("");
  useEffect(() => { getVaultRoot().then(setRoot).catch((e) => console.warn("[vault] vault root read failed", e)); }, []);
  return (
    <Field label="Vault folder" hint="Any folder of markdown notes; an Obsidian vault works as it is.">
      <button onClick={async () => { const d = await chooseVault(); if (d) setRoot(d); }}
        className="flex h-8 w-full items-center gap-2 rounded-lg border border-subtle px-2.5 text-left text-[12.5px] text-text-primary transition-colors hover:border-strong"
        style={{ background: "var(--bg-elev)" }}>
        <FolderOpen size={14} className="shrink-0 text-text-muted" />
        <span className={"min-w-0 truncate " + (root ? "" : "text-text-muted")}>{root || "Not set — click to choose"}</span>
      </button>
    </Field>
  );
}
