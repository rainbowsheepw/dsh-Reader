# dsh-reader

English · [简体中文](README.md)

A [DeepSeek Harness](https://github.com/deepseek-ai) (DSH) plugin: **grid bookshelf + PDF close-reading**.
Built for actually working through technical books — textbooks, papers, manuals — not for glance-and-close previewing.

Open it from the sidebar "Reader" entry: books sit on a 2:3 cover grid. Clicking one enters
continuous scroll reading, where you can annotate the body text **down to the character** in four colors,
keep notes, have the AI build a whole-book outline, and ask questions about a selected passage —
with the AI going back to the PDF itself to read the original text rather than trusting what the frontend forwards.

---

## Features

### Bookshelf
- **Grid layout**, each book showing its **real cover** (rendered from page 1, cached after first generation)
- Covers render in the browser and are uploaded to disk, so a shelf of dozens of books never blocks the main thread
- Drag to import PDFs; the file is copied into the plugin data directory, so **moving the original does not matter**
- Reading percentage, annotation count and outline status at a glance
- **Rename anytime** (hover the title for ✎, Enter to save / Esc to cancel); only the display name changes, the original filename is kept

### Reading
- **Continuous scroll**, not page-by-page slides: reads like a paper book top to bottom
- Only pages inside the window are rendered (visible ±2), so a 300-page book will not exhaust memory
- **Per-book zoom memory**: each book remembers its own scale factor
- Reading position memory (throttled with a trailing write, so continuous scrolling never loses the last position)

### Annotation
- Built on the **real PDF text layer**, not coordinate boxes — text stays selectable and copyable
- **Character-precise**: select three characters and exactly three characters are marked, never the whole sentence
- Four colors (amber / green / blue / rose); the underline is drawn *outside* the text box so larger type never covers the glyphs
- Selecting text raises a toolbar immediately: annotate, or send to the Q&A tab

### Sidebar (three tabs)
- **Outline**: an AI-generated part → chapter → section tree, expandable to a full canvas; "where you are" is merged into its header
- **Q&A**: a compact multi-turn chat with the composer pinned to the bottom. A reference sent from the body carries
  **position information** (page + character range), so the backend cuts the original text straight out of the PDF
- **Annotations**: grouped by chapter, switchable "all / this page", collapsed with hover-to-expand; clear page / chapter / book

### Theming
- Every color comes from the host's `--dsw-alias-*` tokens, so **light and dark follow automatically**
- No hardcoded colors (the single exception is the cover gradient, which is always dark and therefore keeps white text)

---

## Install

```bash
dsh plugin add @rainbowsheepw/dsh-reader
```

Or link a local checkout for development:

```bash
cd <your DSH profile>
pnpm add link:/path/to/dsh-reader
```

Restart DSH afterwards; a "Reader" entry appears in the sidebar.

> **Restart DSH after changing code.** Client-half changes are gated by the host's release identity — see Development.

---

## Usage

1. Sidebar → "Reader" → bookshelf
2. "Import PDF", or drag a file in
3. Click a cover to open the book
4. Select text → toolbar → pick a color, or send it to Q&A
5. The "Outline" tab can generate a structure tree for the whole book (requires a configured model)

---

## Data layout

```
~/.dsh/dsh-reader/library/<book-id>/
├── book.pdf      original byte copy
├── cover.png     cover thumbnail (rendered from page 1 in the browser, then uploaded)
└── meta.json     title, progress, zoom, annotations, notes, outline
```

- **No global index file**: the book list is derived by scanning directories, avoiding a second source of truth
- Writes are **atomic** (write `.tmp`, then rename), so a crash mid-write never leaves a truncated file
- Writes to the same book are **serialized** so progress and annotations cannot overwrite each other

Back up by copying that directory; delete a book by deleting it.

---

## Development

### Layout

```
index.js              Host half: mounts the /api routes
client.js             Client half (single file — required by the DSH plugin format)
lib/
├── store.js          Storage: book dirs, meta, annotations, notes, covers
├── http.js           14 exact /api routes
├── llm.js            Prompts and streaming for outline + Q&A
├── book-text.js      Reads original text by "page + character range"
├── paths.js          Path resolution and book-id validation
└── client/
    └── framework-layout.js   Pure layout engine for the outline tree (Node-testable)
scripts/              25 regression scripts
vendor/               pdf.js 4.10.38 (with LICENSE)
```

### Why `client.js` is a single file

The DSH client half accepts exactly one entry file. The host does support
`client.<name>.js` chunks, but those require a build tool to produce `rev`-stamped URLs —
a hand-written `import` cannot know the right address. So the file stays single and is
organized with section comments instead of being split artificially.

### Running tests

```bash
node scripts/run-all.mjs          # all 25 scripts
```

Individual scripts work too:

```bash
# Verify character-precise extraction against a real PDF
DR_SAMPLE_PDF="/path/to/any.pdf" node scripts/mark-range-check.mjs
```

### Things you must know before editing

Every item below came from an actual incident, not from theory:

1. **Restart DSH after touching the client half.**
   The host's `rebuilt` frames are only applied while the page and the host share a release
   (`dsh-client-modules`' `reload()` begins with `if (!this.release.matches) return`).
   Reloading the plugin changes the release, so an already-open page goes deaf —
   and the change looks like "the code did nothing".

2. **CSS lives in a template string — never put a backtick in a comment.**
   One backtick terminates the CSS early. `node --check` may still pass and the error
   surfaces as a runtime ReferenceError. `mark-style-check`'s E section reports the line.

3. **Hook declaration order is fixed**: `useState/useRef` → `useCallback/useMemo` → `useEffect`.
   Violating it hits a TDZ (`Cannot access X before initialization`) and the panel does not render at all.

4. **`/api` routes must use `connection.fetch.register` with exact paths.**
   `webServer.register({kind:'prefix'})` under `/api` is rejected by the gateway as 401.
   Only **GET / HEAD / POST** are allowed — there is no PUT.

5. **Append query parameters with `&`.** `coverUrl()` already contains `?`;
   appending `?v=` yields `?id=x?v=y`, the id is polluted, the backend returns 400,
   and `<img>` fails *silently* — the feature never appears and nothing is logged.

6. **Assert behaviour, not implementation.** Only checking "some string exists in the source"
   stays green while the feature is broken. `cover-rename-check`'s F section really calls the route.

See [`DEV-NOTES.md`](DEV-NOTES.md) for the full incident log.

---

## Known limits

- Covers render **in the browser** (the host's Node side has no canvas, so pdf.js `render()` cannot run there),
  so brand-new books get their covers one at a time and you will see them appear progressively
- PDF only
- Outline generation and Q&A need a model configured in DSH
- Annotation depends on an embedded PDF text layer; purely scanned (image-only) PDFs cannot be selected

---

## License

Code is MIT. pdf.js under `vendor/` is Apache-2.0 — see [`vendor/pdfjs-LICENSE`](vendor/pdfjs-LICENSE).
