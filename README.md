# codex-tabs

Open Codex conversations as editor tabs in Cursor with auto-patched tab labels and icons.

---

Codex-чаты как вкладки редактора в Cursor с автоматическими заголовками и иконками.

> **Disclaimer:** This extension is unofficial and not affiliated with or endorsed by OpenAI. It requires the official [OpenAI Codex extension](https://marketplace.visualstudio.com/items?itemName=openai.chatgpt) installed.

## Features

- Codex conversations open as editor tabs (not sidebar panels)
- Tab titles update automatically based on conversation content
- Blossom icon on each Codex tab
- History navigation stays within the current tab
- Suppresses unnecessary connector logo network requests
- `Cmd+Shift+J` — open a new Codex tab
- `Cmd+J` — add selected text to the active Codex thread (keeps Explorer visible)

## Requirements

- [Cursor](https://cursor.com) (engine `^1.96.2`)
- [OpenAI Codex extension](https://marketplace.visualstudio.com/items?itemName=openai.chatgpt) installed and activated

## Installation

### Symlink (recommended for easy updates)

```bash
git clone https://github.com/aogoro/codex-tabs.git ~/Projects/codex-tabs
ln -s ~/Projects/codex-tabs ~/.cursor/extensions/aogoro.codex-tabs-0.1.0
```

### Direct copy

```bash
git clone https://github.com/aogoro/codex-tabs.git /tmp/codex-tabs
cp -r /tmp/codex-tabs ~/.cursor/extensions/aogoro.codex-tabs-0.1.0
```

After installing, reload the Cursor window (`Cmd+Shift+P` > `Reload Window`).

### Verify installation

```bash
node ~/.cursor/extensions/aogoro.codex-tabs-0.1.0/scripts/verify-installed.js
```

## Commands

| Command | Hotkey | Description |
|---------|--------|-------------|
| Codex: Open | `Cmd+Shift+J` | Open a new Codex tab. Offers Reload first while the window still runs a stock Codex — see [After Codex updates](#after-codex-updates) |
| Codex: Add to Thread | `Cmd+J` | Add selection to active thread |

## How it works

On activation, the extension patches the installed OpenAI Codex extension's minified JS files to:

1. **Route `/Codex` as home** — adds `/Codex` as a recognized home route so new tabs open the Codex UI directly
2. **In-tab history navigation** — history clicks navigate within the current editor tab instead of opening a new one
3. **Tab titles** — injects a DOM observer + host message bridge to extract conversation titles and apply them to editor tabs
4. **Tab icons** — sets the blossom icon on all Codex editor panels
5. **IPC isolation** — `/Codex` home panels skip IPC client registration to avoid conflicts with active threads
6. **Network noise** — intercepts connector logo fetch requests and returns a transparent pixel

Patches are applied idempotently with verification markers, and backup files (`.bak`) are created before any modification. Target files are located by content (see `lib/targets.js`) because Codex renames and merges its bundles on every rebuild.

Patches that are essential for opening a tab are required — if one of them no longer matches, activation stops with an error and nothing is written. The rest (titles, icons, in-tab history, network noise) are optional: they are skipped individually and reported in an orange warning listing the patch ids, with reasons in the Developer Tools console.

## After Codex updates

Codex updates in the background while Cursor keeps running, so patching only at startup is not enough: the window stays on the version it loaded, its files on disk are replaced by a stock build, and the next tab pairs mismatched halves. The extension therefore also watches the extension registry (and window focus as a fallback) and patches a newly installed Codex as soon as it settles. Last verified Codex build: **26.908.40401**.

**Every Codex update costs one window reload, and that is structural.** `extensionDependencies` makes Cursor activate Codex before this extension, so Codex has already `require`d its host file by the time patches are written — the copy in the extension host process stays stock until the window reloads. The extension detects that state from the mtime of `out/extension.js` against its own process start, warns with a Reload button, and `Codex: Open` asks again before handing over a half-patched tab.

Until that reload, `Cmd+Shift+J` goes through the stock `createNewPanel`, which opens the URI `/extension/panel/new`. Three symptoms follow, and none of them is normal: the tab is labelled **new** (the last path segment) instead of **Codex**, it shows no chat list, and it greets you with the "Codex in your IDE" walkthrough on every new tab. Reload the window and they all go away together.

To patch an installation by hand — before starting Cursor, so the window comes up already patched:

```bash
node scripts/apply-patches.js        # writes to the real installation (same code path as activation)
```

If an update changes the internal structure, re-anchor the patches:

```bash
node scripts/verify-clean-apply.js   # dry-run on copies; names the failing patch and validates syntax
node scripts/verify-installed.js     # state of the real installation
node scripts/restore-backups.js      # roll back to stock Codex from the .bak files
```

`verify-clean-apply.js` never touches the installation — it patches copies in a temp directory. Look for new anchors in `<codex>/webview/assets/app-initial-*.js` (webview) and `<codex>/out/extension.js` (host); file lookup lives in `lib/targets.js`, patch definitions in `extension.js`. Iterate with `restore-backups.js` + `apply-patches.js`, since patches only apply to unpatched files.

Both verify scripts check for markers, which proves a patch was written — not that Codex still works. After re-anchoring, always open a Codex tab and confirm the UI actually renders.

## Third-party assets

The blossom icons in `resources/` are property of OpenAI, included for visual consistency with the official Codex extension.

## License

MIT (see [LICENSE](LICENSE) for details and icon attribution)
