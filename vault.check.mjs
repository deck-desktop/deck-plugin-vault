// node vault.check.mjs
//
// Wikilink parsing and resolution. The two things worth checking: the alias/heading split, which
// is wrong the moment a link carries both, and resolveLink's tie-break — two notes of the same
// name in different folders is normal in a real vault, and a resolution that depends on the order
// the directory was read in sends the same click to a different note on different machines.
//
// Pure string logic, so no vault and no Deck needed.
import assert from "node:assert";
import { build } from "esbuild";

const out = await build({
  entryPoints: ["src/vault.ts"],
  bundle: true, format: "esm", write: false, platform: "node",
});
const v = await import(
  `data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`
);

// ---- parsing -------------------------------------------------------------------------------
const one = (s) => { const l = v.wikiLinks(s); assert.equal(l.length, 1, `expected one link in ${s}`); return l[0]; };

assert.deepEqual(
  { target: one("[[Note]]").target, heading: one("[[Note]]").heading, text: one("[[Note]]").text },
  { target: "Note", heading: "", text: "Note" });

const alias = one("[[Note|shown]]");
assert.equal(alias.target, "Note");
assert.equal(alias.text, "shown", "the alias is what gets displayed");

const head = one("[[Note#Section]]");
assert.equal(head.target, "Note");
assert.equal(head.heading, "Section");
assert.equal(head.text, "Note#Section", "with no alias the whole ref is displayed");

// Both at once: alias splits on the LAST pipe, heading on the FIRST hash of what is left.
const both = one("[[Note#Section|shown]]");
assert.equal(both.target, "Note");
assert.equal(both.heading, "Section");
assert.equal(both.text, "shown");

// A pipe inside the alias. Splitting on the first pipe would give the alias "b|c".
assert.equal(one("[[Note|a|c]]").text, "c", "the alias is everything after the last pipe");

// Offsets have to be exact — they drive the decoration that replaces the raw text.
const off = one("hello [[Note]] world");
assert.equal(off.from, 6);
assert.equal(off.to, 14);
assert.equal("hello [[Note]] world".slice(off.from, off.to), "[[Note]]");

// Two links, not one spanning both.
assert.equal(v.wikiLinks("[[a]] and [[b]]").length, 2);
assert.deepEqual(v.wikiLinks("[[a]] and [[b]]").map((l) => l.target), ["a", "b"]);

// Non-links.
assert.deepEqual(v.wikiLinks("[[]]"), [], "an empty link names nothing");
assert.deepEqual(v.wikiLinks("[not a link]"), []);
assert.deepEqual(v.wikiLinks("[[unclosed"), []);
assert.deepEqual(v.wikiLinks("[[spans\nlines]]"), [], "a link does not cross a newline");
// A markdown link is not a wikilink.
assert.deepEqual(v.wikiLinks("[text](Note.md)"), []);
// Heading-only links point within the current note, and are not resolved to another file.
assert.equal(one("[[#Section]]").target, "");
assert.equal(one("[[#Section]]").heading, "Section");

// Whitespace inside the brackets is trimmed; people type it.
assert.equal(one("[[ Note | shown ]]").target, "Note");
assert.equal(one("[[ Note | shown ]]").text, "shown");

// ---- resolution ----------------------------------------------------------------------------
const note = (rel) => ({ path: `C:/vault/${rel}`, rel });
const notes = [
  note("dev/deck/Architecture.md"),
  note("dev/hapster/Architecture.md"),
  note("Architecture.md"),
  note("ideas/Graph View.md"),
  note("meetings/2026-09-14.md"),
];

// Shallowest wins when a bare name is ambiguous.
assert.equal(v.resolveLink("Architecture", notes)?.rel, "Architecture.md");

// A sibling beats the shallowest — linking from dev/deck means the neighbour, not the root note.
assert.equal(
  v.resolveLink("Architecture", notes, "dev/deck/Notes.md")?.rel,
  "dev/deck/Architecture.md",
  "a link resolves to a sibling before a stranger");

// A path disambiguates explicitly, with or without the extension.
assert.equal(v.resolveLink("dev/hapster/Architecture", notes)?.rel, "dev/hapster/Architecture.md");
assert.equal(v.resolveLink("dev/hapster/Architecture.md", notes)?.rel, "dev/hapster/Architecture.md");

// A slashed target also resolves RELATIVE to the linking note, which is how an _index.md links
// to its own subfolders. This is what made every [[hapster/_index]] in the real vault dead.
assert.equal(
  v.resolveLink("deck/Architecture", notes, "dev/Notes.md")?.rel,
  "dev/deck/Architecture.md",
  "a path resolves relative to the linking note when it does not match from the root");
// `..` climbs, which is how an _index.md points at its parent. Real links in the vault use it,
// and without collapsing the segments every one of them resolved to nothing.
assert.equal(
  v.resolveLink("../_index", [...notes, note("dev/_index.md")], "dev/deck/Notes.md")?.rel,
  "dev/_index.md",
  "a .. climbs one folder from the linking note");
assert.equal(
  v.resolveLink("../hapster/Architecture", notes, "dev/deck/Notes.md")?.rel,
  "dev/hapster/Architecture.md",
  "climb then descend");
assert.equal(
  v.resolveLink("../../../../etc/passwd", notes, "dev/deck/Notes.md"), null,
  "a .. that climbs past the root resolves to nothing rather than escaping the vault");

// The root-relative reading still wins when both would match.
assert.equal(v.resolveLink("dev/deck/Architecture", notes, "dev/Notes.md")?.rel,
  "dev/deck/Architecture.md");

// Case-insensitive, and spaces in names are ordinary.
assert.equal(v.resolveLink("graph view", notes)?.rel, "ideas/Graph View.md");
assert.equal(v.resolveLink("ARCHITECTURE", notes, "dev/hapster/x.md")?.rel, "dev/hapster/Architecture.md");

// Backslashes, because these paths come from Windows.
assert.equal(v.resolveLink("dev\\hapster\\Architecture", notes)?.rel, "dev/hapster/Architecture.md");

// A link to nothing is null, not a throw and not a wrong note.
assert.equal(v.resolveLink("Nope", notes), null);
assert.equal(v.resolveLink("", notes), null);

// Deterministic: the answer must not depend on the order the directory was read in.
assert.equal(
  v.resolveLink("Architecture", [...notes].reverse())?.rel,
  v.resolveLink("Architecture", notes)?.rel,
  "resolution is independent of listing order");

// ---- backlinks -----------------------------------------------------------------------------
assert.equal(v.backlinkQuery("dev/deck/Architecture.md"), "[[Architecture");

const target = note("ideas/Graph View.md");
assert.ok(v.linksTo("see [[Graph View]] for more", target, notes, "a.md"));
assert.ok(v.linksTo("see [[Graph View|the graph]]", target, notes, "a.md"));
assert.ok(v.linksTo("see [[Graph View#Layout]]", target, notes, "a.md"));
assert.ok(!v.linksTo("no links here", target, notes, "a.md"));
// The prefix query is a superset — this is the hit it must reject.
assert.ok(!v.linksTo("[[Graph View Plans]]", target, notes, "a.md"),
  "a longer name starting with the same prefix is not a backlink");

// Resolution is what decides, not the spelling: a link from a sibling resolves elsewhere.
const arch = note("dev/deck/Architecture.md");
assert.ok(v.linksTo("[[Architecture]]", arch, notes, "dev/deck/Notes.md"));
assert.ok(!v.linksTo("[[Architecture]]", arch, notes, "meetings/x.md"),
  "from elsewhere the same text resolves to the root note, not this one");

// ---- tree filtering ------------------------------------------------------------------------
assert.ok(v.keepEntry("Note.md", false));
assert.ok(v.keepEntry("image.png", false), "attachments are shown too, not just markdown");
assert.ok(!v.keepEntry("Note.sync-conflict-20260101-120000-ABCDEFG.md", false),
  "a Syncthing conflict copy is not a note anyone wrote");
assert.ok(v.keepEntry("dev", true));
assert.ok(v.keepEntry("personal", true), "the user asked for personal/ to be visible");
assert.ok(!v.keepEntry(".obsidian", true));
assert.ok(!v.keepEntry(".git", true));
assert.ok(!v.keepEntry(".hidden-file", false), "a dotfile is plumbing, not content");

// ---- viewers ---------------------------------------------------------------------------------
// Only markdown is editable; everything else is read-only, so the classification decides whether
// a file is read as text at all. Reading a binary with fsRead would mangle it.
assert.equal(v.viewerFor("Note.md"), "markdown");
assert.equal(v.viewerFor("NOTE.MD"), "markdown", "the extension check is case-insensitive");
assert.equal(v.viewerFor("logo.png"), "image");
assert.equal(v.viewerFor("clip.mp4"), "video");
assert.equal(v.viewerFor("song.mp3"), "audio");
assert.equal(v.viewerFor("paper.pdf"), "pdf");
assert.equal(v.viewerFor("data.json"), "text");
assert.equal(v.viewerFor("notes.canvas"), "text", "an unknown extension is text, not binary");
assert.equal(v.viewerFor("LICENSE"), "text", "a file with no extension is text");
assert.equal(v.viewerFor("archive.zip"), "binary");
assert.equal(v.viewerFor("db.sqlite3"), "binary", "never fsRead a database as UTF-8");

assert.equal(v.extOf("a.tar.gz"), "gz", "the LAST dot decides the extension");
assert.equal(v.extOf("LICENSE"), "");
assert.ok(v.isNote("x.md"));
assert.ok(!v.isNote("x.png"));

// A note loses its extension; anything else keeps it, or logo.png and logo.md collide as "logo".
assert.equal(v.noteTitle("dev/Architecture.md"), "Architecture");
assert.equal(v.noteTitle("dev/logo.png"), "logo.png");

// ---- names -----------------------------------------------------------------------------------
// Checked before anything is written, so a bad name is refused by the dialog rather than by the OS.
assert.equal(v.nameError("Notes"), "");
assert.equal(v.nameError("My Note.md"), "", "spaces are ordinary in a vault");
assert.ok(v.nameError(""), "an empty name is refused");
assert.ok(v.nameError("   "), "whitespace is not a name");
assert.ok(v.nameError("a/b"), "a separator would escape the folder");
assert.ok(v.nameError("a\b"), "a backslash separator too");
assert.ok(v.nameError("a:b"), "a colon is illegal on Windows");
assert.ok(v.nameError(".."), "the parent directory is not a name");
assert.ok(v.nameError("name."), "a trailing dot is silently stripped by Windows");
assert.ok(v.nameError("con.md"), "a reserved device name cannot be created");
assert.ok(v.nameError("LPT1"), "reserved names are case-insensitive");

// ---- drag guard ------------------------------------------------------------------------------
// Dropping a folder into its own subtree moves it inside itself and takes the subtree with it.
assert.ok(v.isInside("C:/vault/dev", "C:/vault/dev/deck/Note.md"));
assert.ok(v.isInside("C:/vault/dev", "C:/vault/dev"), "a folder contains itself");
assert.ok(!v.isInside("C:/vault/dev", "C:/vault/ideas/Note.md"));
assert.ok(!v.isInside("C:/vault/dev", "C:/vault/development/Note.md"),
  "a prefix match is not containment");
assert.ok(v.isInside("C:\\vault\\dev", "C:/vault/dev/x.md"),
  "separators are normalised");
assert.ok(v.isInside("C:/vault/dev/", "C:/vault/dev/x.md"), "a trailing separator is ignored");
assert.ok(v.isInside("C:/Vault/Dev", "C:/vault/dev/x.md"), "Windows paths are case-insensitive");

assert.deepEqual(
  v.sortEntries([
    { name: "zeta.md", isDir: false }, { name: "Alpha", isDir: true },
    { name: "beta.md", isDir: false }, { name: "alpha.md", isDir: false },
  ]).map((e) => e.name),
  ["Alpha", "alpha.md", "beta.md", "zeta.md"],
  "folders first, then case-insensitive by name");

// ---- titles --------------------------------------------------------------------------------
assert.equal(v.noteTitle("dev/deck/Architecture.md"), "Architecture");
assert.equal(v.noteTitle("Architecture.md"), "Architecture");
assert.equal(v.baseName("dev/deck/Architecture.md"), "Architecture", "case preserved — backlinkQuery and the UI both use this");

console.log("vault: wikilinks, resolution, backlinks, viewers, names and drag guard ok");
