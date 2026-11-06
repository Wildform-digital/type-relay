# Type Relay

Lets your AI assistant work in the Figma desktop app with the fonts on your computer, and change a font across a big file without breaking it.

Cloud Figma tools can't see licensed fonts activated through Adobe Fonts, Typeface or similar, so text fails or lands in the wrong typeface. Figma desktop can see them, and Type Relay's plugin runs inside it.

```
AI assistant  <--MCP-->  type-relay.mjs  <--localhost only-->  plugin in Figma desktop
```

No font files are copied or uploaded, and nothing leaves your computer.

## Changing a font safely

Swapping a font across a file goes wrong in quiet ways: weights that don't exist, symbols that fall back to another font, text styles shared with pages you didn't mean to touch, and text that no longer fits. Type Relay checks for each of these.

| Tool | What it does |
|---|---|
| `type_audit` | Which fonts are used, how much is linked to text styles, and what's missing |
| `type_preview` | What a swap would do, changing nothing: weight mapping, characters the new font lacks, text styles affected |
| `type_swap` | Applies a preview, with a named restore point in version history |
| `type_check` | Cut-off text, text spilling out of its parent, overlapping frames, and what changed since an earlier check |

Just ask in plain words:

- *"Which fonts does this page use? Is anything missing?"*
- *"Preview changing Outfit to Motiva Sans on this page."*
- *"Go ahead, then show me anything that's now cut off."*

**What a swap does:**

- **Weights:** matches by name, then the nearest weight. A tie goes heavier from Medium up, so SemiBold becomes Bold when there's no SemiBold. You can override any of these.
- **Missing characters:** anything the new font lacks, such as arrows, stays in the old font if the old font has it. They stay linked to their text style where that style still exists. If the style itself is edited to the new font, those characters become hard-coded. This check needs macOS.
- **Text styles:** a style used only inside the scope is edited. A style used elsewhere, or published to a library, is copied and the layers are relinked to the copy, so nothing outside the scope changes.
- **Overrides:** manual size, spacing, line height, case, decoration, colour and link changes are kept, and so are lists.
- **Font variables:** if a layer or style takes its font from a variable, the swap replaces that link with a fixed font, and the preview warns you first. To keep the link, change the variable instead.
- **Components:** main components change first, so instances inherit the change instead of getting overrides. A preview warns if a component in scope has instances outside it.
- **Reporting:** afterwards you get errors, leftovers, whether anything outside the scope changed, and what moved in the layout.

## Other tools

| Tool | What it does |
|---|---|
| `type_status` | Which files have the plugin running |
| `type_list_fonts` | Fonts Figma can see, filterable by name |
| `type_run` | Run Plugin API JavaScript in the open file (one undo step per run) |
| `type_screenshot` | Export a layer as PNG with the real fonts |

If the plugin is open in several files, your assistant must name one. It won't guess.

## Setup

You need [Node.js](https://nodejs.org) 18 or newer and the Figma desktop app (the browser can't reach local fonts).

```bash
git clone https://github.com/Wildform-digital/type-relay.git
cd type-relay
node type-relay.mjs setup
```

This creates your private token, builds the plugin and registers Type Relay with Claude Code if you have it. For other apps:

```bash
node type-relay.mjs setup --clients claude-desktop,cursor,windsurf
```

It only edits the apps you name, and saves a backup of each settings file first. `--dry-run` shows what it would do. For any other MCP app, add this to its settings, using the full path to the file:

```json
{ "mcpServers": { "type-relay": { "command": "node", "args": ["/full/path/to/type-relay.mjs", "mcp"] } } }
```

Then, once, in Figma desktop: open any file, then **Plugins > Development > Import plugin from manifest...** and choose `plugin/manifest.json`.

## Using it

1. Open the file in Figma desktop.
2. Run **Plugins > Development > Type Relay** and leave its small window open. The window is the connection, so closing it disconnects. The dot goes green when connected.
3. Ask your assistant. Sessions started after setup have the tools.

## Without an AI app

```bash
node type-relay.mjs serve                      # in one terminal
node type-relay.mjs audit
node type-relay.mjs preview Outfit "Motiva Sans" --scope page
node type-relay.mjs swap <previewId>
node type-relay.mjs check --compare <snapshotId>
node type-relay.mjs help
```

## Good to know

- **Fonts hosted by Figma:** some fonts, such as many Google Fonts, aren't installed as files on your computer, so their characters can't be read. The preview says so when this happens. If only the old font is hosted, missing characters stay in it. If the new font is hosted, nothing is checked and Figma falls back to another font for anything it lacks.
- **Mixed text styles:** a layer with a kept character shows as mixed in the styles panel. It looks right, but that's why.
- **Fixed-size text boxes:** overflow can't be measured when a text box has a fixed height, so `type_check` counts them for you to check by eye.
- **Replacing a font that's already missing** hasn't been tried in real Figma yet. If Figma refuses, the layer is listed as an error and stays as it was.
- **Tested on macOS.** It should run elsewhere, but the missing-character check is macOS only.
- **Fonts activated while Figma is open** may not appear until you restart Figma.
- **People without the font** see Figma's usual missing-font warning, as with any local font.

## Security

Scripts can change anything in the open file, so:

- The helper only listens on `127.0.0.1`.
- Every request needs a private token, created on your computer in `~/.type-relay/token`.
- The plugin does nothing while its window is closed.

`plugin/ui.html` is generated and contains your token, so it's excluded from git. Edit `plugin/ui.template.html` instead, then re-run setup.

To change the port, set `TYPE_RELAY_PORT`, update `plugin/manifest.json` and re-run setup.

## Tests

```bash
node test/smoke.mjs
```

This runs the real helper with a simulated plugin, and `plugin/code.js` against a small model of a Figma file. It doesn't touch Figma or your token, so it can't prove behaviour inside Figma itself. The character check tests need macOS.

Developed and tested on macOS. Windows and Linux are untested.

## Licence

MIT
