// Locating the Codex extension and the files we patch inside it.
//
// Codex renames, splits and merges its bundles on every rebuild, so files are
// located by content whenever possible; filename prefixes are kept as
// fallbacks for older builds. Shared by extension.js and scripts/verify-*.js —
// keep target discovery here only, so a Codex update is a one-file change.

const fs = require('fs');
const path = require('path');
const os = require('os');

function findCodexExtDir() {
    const extRoot = path.join(os.homedir(), '.cursor', 'extensions');
    try {
        const dirs = fs.readdirSync(extRoot)
            .filter((d) => d.startsWith('openai.chatgpt-'))
            .map((d) => path.join(extRoot, d))
            .filter((d) => fs.statSync(d).isDirectory())
            .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
        return dirs.length > 0 ? dirs[0] : null;
    } catch (_) {
        return null;
    }
}

function readCodexVersion(codexDir) {
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(codexDir, 'package.json'), 'utf8'));
        return pkg.version || null;
    } catch (_) {
        return null;
    }
}

function findFileByPrefix(dir, prefix, ext) {
    try {
        return fs.readdirSync(dir).find((f) => f.startsWith(prefix) && f.endsWith(ext)) || null;
    } catch (_) {
        return null;
    }
}

function findAssetByContent(assetsDir, ...needles) {
    try {
        for (const f of fs.readdirSync(assetsDir)) {
            if (!f.endsWith('.js')) continue;
            const c = fs.readFileSync(path.join(assetsDir, f), 'utf8');
            if (needles.every((n) => c.includes(n))) return f;
        }
    } catch (_) {}
    return null;
}

// Route resolution module: RouteScope atom + pathname -> routeKind mapping.
// Codex 26.721 merged it into app-initial-*.js.
function findRouteAssetFile(assetsDir) {
    return findAssetByContent(assetsDir, '`RouteScope`,{key:', 'routeKind:`home`')
        || findFileByPrefix(assetsDir, 'route-scope-', '.js');
}

// React route table (<Route path="/" .../> list). Lived in app-main-*.js until
// Codex 26.715; app-main-* is a stub since.
function findRouteTableFile(assetsDir) {
    return findAssetByContent(assetsDir, '{path:`/projects`', '{path:`/extension/panel/new`')
        || findFileByPrefix(assetsDir, 'app-main-', '.js');
}

// Module that asks the host to open a conversation from the history list.
// Was use-navigate-to-local-conversation-*.js until Codex 26.715.
// The second needle matches the already-patched file: the patch rewrites the
// first one, and the file must stay findable on later activations.
function findNavigateFile(assetsDir) {
    return findAssetByContent(assetsDir, 'navigate-in-new-editor-tab')
        || findAssetByContent(assetsDir, 'navigate-in-current-editor-tab')
        || findFileByPrefix(assetsDir, 'use-navigate-to-local-conversation-', '.js');
}

module.exports = {
    findCodexExtDir,
    readCodexVersion,
    findFileByPrefix,
    findAssetByContent,
    findRouteAssetFile,
    findRouteTableFile,
    findNavigateFile,
};
