// Wikilinks, link resolution and backlinks. No React and no bridge here, so it can be compiled
// and checked by vault.check.mjs without Deck running.

/** A file in the vault, as the tree and the link index see it. */
export interface Note {
  /** Absolute path on disk. */
  path: string;
  /** Path relative to the vault root, with forward slashes — what a wikilink can name. */
  rel: string;
}

/** One `[[target|alias]]` occurrence in a document. */
export interface WikiLink {
  /** Offset of the opening `[[`. */
  from: number;
  /** Offset just past the closing `]]`. */
  to: number;
  /** The note being named, without a heading or an alias. May be empty for `[[#heading]]`. */
  target: string;
  /** The `#heading` part, without the hash. Empty when absent. */
  heading: string;
  /** What to display: the alias when given, otherwise the target (plus heading). */
  text: string;
}

// `[[` ... `]]` with no newline and no nested bracket. Lazy so `[[a]] [[b]]` is two matches
// rather than one that swallows the gap.
const LINK = /\[\[([^\[\]\n]*)\]\]/g;

/**
 * Every wikilink in a document, in order.
 *
 * Obsidian's own precedence: the alias is split on the LAST `|`, and the heading on the FIRST `#`
 * of what remains. That ordering matters for `[[Note#a|b|c]]`, where the alias is `c` — splitting
 * on the first pipe instead would make the alias `b|c` and lose the rest.
 */
export function wikiLinks(text: string): WikiLink[] {
  const out: WikiLink[] = [];
  LINK.lastIndex = 0;
  for (let m = LINK.exec(text); m; m = LINK.exec(text)) {
    const body = m[1];
    const bar = body.lastIndexOf("|");
    const alias = bar === -1 ? "" : body.slice(bar + 1).trim();
    const ref = (bar === -1 ? body : body.slice(0, bar)).trim();
    const hash = ref.indexOf("#");
    const target = (hash === -1 ? ref : ref.slice(0, hash)).trim();
    const heading = hash === -1 ? "" : ref.slice(hash + 1).trim();
    // An empty `[[]]` names nothing and is not a link.
    if (!target && !heading) continue;
    out.push({
      from: m.index,
      to: m.index + m[0].length,
      target,
      heading,
      text: alias || ref,
    });
  }
  return out;
}

/**
 * A note's basename without the .md extension — what a bare `[[Name]]` matches.
 *
 * Case is PRESERVED: this is also what backlinkQuery searches for and what the UI displays, and
 * a lowercased name would neither match a real document nor read correctly in a heading.
 * Callers comparing two names fold the case themselves.
 */
export function baseName(rel: string): string {
  const name = rel.slice(rel.lastIndexOf("/") + 1);
  return name.toLowerCase().endsWith(".md") ? name.slice(0, -3) : name;
}

/**
 * Resolve a wikilink target against the vault, returning the note or null.
 *
 * Obsidian's rule, which this follows:
 *  - a target containing a slash is a path, tried from the vault root and then relative to the
 *    linking note (with or without .md);
 *  - a bare target matches any note's basename, case-insensitively;
 *  - when several match, the SHALLOWEST wins, and ties break alphabetically so the answer does
 *    not depend on the order the directory happened to be read in.
 *
 * `from` is the linking note, so a link resolves to a sibling before a stranger — the one case
 * where two notes of the same name in different folders should not both lose to alphabetical
 * order.
 */
export function resolveLink(target: string, notes: Note[], from?: string): Note | null {
  const want = target.replace(/\\/g, "/").trim();
  if (!want) return null;
  const norm = (s: string) => (s.toLowerCase().endsWith(".md") ? s.slice(0, -3) : s).toLowerCase();

  // A slashed target is a path. Obsidian resolves one both from the vault root AND relative to
  // the linking note, so `[[hapster/_index]]` in dev/_index.md finds dev/hapster/_index.md —
  // which is how the vault's own index files link to their subfolders.
  let candidates: Note[];
  if (want.includes("/")) {
    candidates = notes.filter((n) => norm(n.rel) === norm(want));
    if (!candidates.length && from) {
      const dir = from.replace(/\\/g, "/");
      const base = dir.slice(0, dir.lastIndexOf("/") + 1);
      if (base) {
        const joined = collapse(base + want);
        candidates = notes.filter((n) => norm(n.rel) === norm(joined));
      }
    }
  } else {
    candidates = notes.filter((n) => baseName(n.rel).toLowerCase() === want.toLowerCase());
  }
  if (!candidates.length) return null;
  if (candidates.length === 1) return candidates[0];

  // A sibling of the linking note wins outright.
  if (from) {
    const dir = from.replace(/\\/g, "/").slice(0, from.replace(/\\/g, "/").lastIndexOf("/") + 1);
    const sibling = candidates.filter((n) => n.rel.startsWith(dir) && !n.rel.slice(dir.length).includes("/"));
    if (sibling.length === 1) return sibling[0];
    if (sibling.length > 1) return shallowest(sibling);
  }
  return shallowest(candidates);
}

/**
 * Resolve `.` and `..` inside a joined path.
 *
 * A note written as `[[../_index]]` is how the vault's own index files point at their parent, and
 * without this every one of them resolves to nothing — the literal ".." never matches a real
 * path. A `..` that would climb past the root is dropped rather than escaping the vault.
 */
function collapse(path: string): string {
  const out: string[] = [];
  for (const seg of path.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return out.join("/");
}

/** Fewest path segments, then alphabetical — a total order, so resolution is deterministic. */
function shallowest(notes: Note[]): Note {
  return [...notes].sort((a, b) => {
    const d = a.rel.split("/").length - b.rel.split("/").length;
    return d !== 0 ? d : a.rel.localeCompare(b.rel);
  })[0];
}

/**
 * The search needle that finds links TO a note.
 *
 * Deliberately just `[[<basename>` and not the closing brackets: the same note is reached by
 * `[[Name]]`, `[[Name|alias]]` and `[[Name#heading]]`, and one prefix covers all three. The hits
 * are filtered properly by parsing each one, so this only has to be a superset.
 */
export function backlinkQuery(rel: string): string {
  return `[[${baseName(rel)}`;
}

/**
 * Does `text` actually link to `target`? Applied to each search hit, because backlinkQuery is a
 * prefix match and would also catch `[[Meeting Notes]]` when looking for `[[Meeting]]`.
 */
export function linksTo(text: string, target: Note, notes: Note[], from: string): boolean {
  return wikiLinks(text).some((l) => resolveLink(l.target, notes, from)?.rel === target.rel);
}

/** Folders that are vault plumbing rather than notes. */
const SKIP_DIRS = new Set([".obsidian", ".trash", ".git", "node_modules"]);

/**
 * Should this directory entry appear in the tree?
 *
 * Everything except plumbing and hidden files, not just markdown: a vault holds the images and
 * PDFs its notes embed, and a tree that hides them makes an attachment impossible to find from
 * inside Deck. What each one does when opened is `viewerFor`'s decision, not this one.
 *
 * Syncthing's conflict copies (in a vault the user syncs with it) are real files but not anything
 * anyone wrote — `vault.rs::notes_list` filters them for the same reason.
 */
export function keepEntry(name: string, isDir: boolean): boolean {
  if (name.startsWith(".")) return false;
  if (isDir) return !SKIP_DIRS.has(name);
  return !name.includes(".sync-conflict-");
}

/** A file's lowercase extension without the dot, or "" when it has none. */
export function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

/** Is this a markdown note — the only thing the vault tab edits? */
export function isNote(name: string): boolean {
  return extOf(name) === "md";
}

// Extensions that are not text and must never be read with fsRead, which decodes as UTF-8 and
// would mangle them. Grouped by the element that renders each.
const IMAGE = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif", "svg"]);
const VIDEO = new Set(["mp4", "webm", "mov", "mkv", "m4v", "ogv"]);
const AUDIO = new Set(["mp3", "wav", "ogg", "flac", "m4a", "aac", "opus"]);
const BINARY = new Set(["zip", "gz", "7z", "rar", "tar", "exe", "dll", "so", "dylib",
  "ttf", "otf", "woff", "woff2", "bin", "wasm", "db", "sqlite", "sqlite3"]);

/** How a file should be shown. */
export type Viewer = "markdown" | "image" | "video" | "audio" | "pdf" | "text" | "binary";

/**
 * Which viewer a file gets.
 *
 * Only markdown is editable here; everything else is read-only, because editing a source file is
 * the Editor module's job and a second editing path would mean a second autosave over the same
 * folder.
 *
 * Anything unrecognised is treated as TEXT rather than binary: a vault is full of .yaml, .csv,
 * .canvas and extensionless files, and showing those as "cannot preview" would be wrong far more
 * often than reading a stray binary as text. The genuinely-not-text extensions are listed.
 */
export function viewerFor(name: string): Viewer {
  const ext = extOf(name);
  if (ext === "md") return "markdown";
  if (IMAGE.has(ext)) return "image";
  if (VIDEO.has(ext)) return "video";
  if (AUDIO.has(ext)) return "audio";
  if (ext === "pdf") return "pdf";
  if (BINARY.has(ext)) return "binary";
  return "text";
}

/**
 * Validate a name typed for a new or renamed file, returning an error or "".
 *
 * Checked here rather than only in Rust so the dialog can refuse before writing anything. The
 * reserved device names are Windows': a file called `con.md` cannot be created, and the failure
 * from the OS does not explain itself.
 */
const RESERVED = new Set(["con", "prn", "aux", "nul",
  "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
  "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9"]);

export function nameError(name: string): string {
  const t = name.trim();
  if (!t) return "A name is needed";
  if (/[<>:"/\\|?*]/.test(t)) return 'A name cannot contain \\ / : * ? " < > |';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(t)) return "A name cannot contain control characters";
  if (t === "." || t === "..") return "That name is reserved";
  if (t.endsWith(".") || t.endsWith(" ")) return "A name cannot end with a dot or a space";
  if (RESERVED.has(t.split(".")[0].toLowerCase())) return `${t} is a reserved name on Windows`;
  return "";
}

/**
 * Is `dir` the path of a folder that contains `path`, at any depth?
 *
 * The guard on a drag: dropping a folder into its own subtree would move it inside itself, which
 * either fails or, worse, succeeds and takes the subtree with it.
 */
export function isInside(dir: string, path: string): boolean {
  const d = dir.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
  const p = path.replace(/\\/g, "/").toLowerCase();
  return p === d || p.startsWith(d + "/");
}

/** Sort a directory listing: folders first, then case-insensitive by name. */
export function sortEntries<T extends { name: string; isDir: boolean }>(entries: T[]): T[] {
  return [...entries].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

/**
 * The label shown in the tree.
 *
 * A markdown note loses its extension, which is how Obsidian names notes. Everything else keeps
 * it: `logo.png` and `logo.md` are different files, and stripping both to "logo" would show two
 * identical rows.
 */
export function noteTitle(rel: string): string {
  const name = rel.slice(rel.lastIndexOf("/") + 1);
  return isNote(name) ? name.slice(0, -3) : name;
}
