# Putting the map in your docs

You can put the map inside your project's documentation, such as a Read the Docs, Sphinx, MkDocs or Docusaurus site, so readers can explore how the app fits together without leaving the docs.

## Make the copy

The easiest way is the Export dialog. Open the map, press **Export**, and tick **For a docs page**. Two choices appear:
- **Opens on:** where the copy starts. The list has **Overview**, then every part, nested as in the map (for example "Server › Orders"). Give each docs page its own copy, or its own link (see below), so each page shows the part of the code it talks about;
- **Show project description:** the short summary of what the project is, at the top of the overview. Off by default, which leaves more room for the map.

Press **Download** and save the file where your docs keep their static files. Ask Claude or Codex to "export the floorplan for our docs" and it uses the same copy.

Every part stays in the file, whichever view you choose. **Opens on** only sets where the map starts; a reader can still click out to the overview or any other part, so choose a starting view for focus, not to hide anything.

From the command line:

```bash
node floorplan/serve.mjs --export docs/_static/map.html --embed
```

The command line has no starting-view setting: the copy opens on the overview with the description hidden. Put the starting part in the iframe address instead (`map.html#v=api`, see [Open on one part](#open-on-one-part-or-one-box)), and add `?description=show` to show the description.

Either way, this is the same copy as [Export](using-the-map.md#export): one HTML file with the whole map, search, screens, the tour and flows, but no Ask bar, no requests for Claude or Codex, and nothing about your computer. Health and recent work are left out unless you tick them in the dialog or add `--include`. **Think twice before adding `health` to a public docs site**: it lists the endpoints anyone can use and where secrets sit in the code.

**For a docs page** (or `--embed`) changes how the copy behaves inside a docs page:
- it opens on the starting view you chose. A `#v=` link in the iframe address wins over it (see below);
- the project description is hidden on the overview, leaving more room for the map, unless you chose to show it or the iframe address has `?description=show`;
- the details panel starts closed, and opens when a reader clicks a box;
- the scroll wheel scrolls the docs page, not the map. Readers zoom by clicking the map first, pinching on a trackpad, or holding Ctrl (⌘ on a Mac) while scrolling;
- on a touch screen, one finger scrolls the page until the reader taps the map;
- clicking around the map doesn't fill the docs page's back button, and a reload stays on the part the reader was looking at;
- a **Full screen** button fills the screen with the map, keeping its place and colours; Esc or the same button brings it back. It needs `allowfullscreen` on the `<iframe>`, as in the snippets below; without it the button opens the map in a tab of its own instead.

Opened on its own, rather than in an iframe, the file is an ordinary exported copy: it ignores the starting view and shows the description.

## Add it to a page

The map goes in an `<iframe>`. Give it a height, since it fills whatever space it's given.

**Sphinx and Read the Docs** (reStructuredText). Put the file in a folder listed in `html_static_path`, usually `_static`:

```rst
.. raw:: html

   <iframe src="_static/map.html" style="width:100%;height:600px;border:0"
           title="Architecture map" loading="lazy" allowfullscreen></iframe>
```

The path above works for a page at the root of the built site. For a nested page, adjust it relative to that page: for example, use `../_static/map.html` on `guide/setup.html`. With MyST Markdown, use the same `<iframe>` line in the page and adjust the path in the same way.

**MkDocs** (including Material for MkDocs). Put the file under `docs/`, and write the `<iframe>` straight into the Markdown page:

```html
<iframe src="../map.html" style="width:100%;height:600px;border:0" title="Architecture map" loading="lazy" allowfullscreen></iframe>
```

**Docusaurus.** Put the file in `static/`, and use `src="/map.html"` in an MDX page.

## Open on one part, or one box

The starting view you chose in the dialog is the default. To override it for one page, or to choose it when you made the copy from the command line, add `#v=` and the part's id from `floorplan/architecture.json` to the iframe address:

```html
<iframe src="_static/map.html#v=api" …></iframe>
```

This wins over the saved starting view. The id works as written (`#v=api`), and also in the form the map's own address bar uses (`#v=n:api`). An id that doesn't exist opens the overview. So one copy can serve every page: give each page its own `#v=`.

To open on a box with its details showing, open the map, go to that box and click it, then copy everything after `#` in the address bar (something like `#v=api&s=…`). Links that pick a box start with the details open.

## Colours

By default the map follows the reader's device, light or dark. To fix it to your docs theme, add `?theme=light` or `?theme=dark` before the `#` (combine options with `&`, for example `?theme=light&description=show`):

```html
<iframe src="_static/map.html?theme=light#v=api" …></iframe>
```

If your docs site has its own light/dark switch, it can tell the map when it changes:

```js
iframe.contentWindow.postMessage({ floorplan: 'theme', theme: 'dark' }, '*');
```

Neither is saved, so it doesn't change the colours of the map anywhere else.

## Keeping it up to date

The copy is a snapshot. To keep it current, update the floorplan, then run the export again before building the docs. For example, in your docs build:

```bash
node floorplan/serve.mjs --export docs/_static/map.html --embed
```

This needs the `floorplan/` folder, which Floorplan keeps out of git by default, so the export usually runs on a computer where the map was made, and the exported file is what gets committed.

## Size

Each copy is about 2 MB, most of it the layout engine that draws the map in the reader's browser. That's fine for one map on a docs site. Use `loading="lazy"` so pages load it only when it scrolls into view.
