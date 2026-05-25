#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const os = require('os');

const pkg = require('../package.json');
const SOURCE_WRAPPER = path.resolve(__dirname, '..', 'extension.js');
const INSTALLED_WRAPPER = path.join(
    os.homedir(),
    '.cursor',
    'extensions',
    `${pkg.publisher}.${pkg.name}-${pkg.version}`,
    'extension.js'
);

function readText(file) {
    try {
        return fs.readFileSync(file, 'utf8');
    } catch (_) {
        return null;
    }
}

function findCodexExtDir() {
    const extRoot = path.join(os.homedir(), '.cursor', 'extensions');
    try {
        const dirs = fs.readdirSync(extRoot)
            .filter((entry) => entry.startsWith('openai.chatgpt-'))
            .map((entry) => path.join(extRoot, entry))
            .filter((entry) => fs.statSync(entry).isDirectory())
            .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
        return dirs.length > 0 ? dirs[0] : null;
    } catch (_) {
        return null;
    }
}

function findFileByPrefix(dir, prefix, ext) {
    try {
        return fs.readdirSync(dir).find((file) => file.startsWith(prefix) && file.endsWith(ext)) || null;
    } catch (_) {
        return null;
    }
}

function sliceFrom(content, needle, length) {
    if (!content) return '';
    const index = content.indexOf(needle);
    return index === -1 ? '' : content.slice(index, index + length);
}

const codexDir = findCodexExtDir();
const assetsDir = codexDir ? path.join(codexDir, 'webview', 'assets') : null;
const routeFile = assetsDir ? findFileByPrefix(assetsDir, 'route-scope-', '.js') : null;
const appMainFile = assetsDir ? findFileByPrefix(assetsDir, 'app-main-', '.js') : null;
const navigateFile = assetsDir ? findFileByPrefix(assetsDir, 'use-navigate-to-local-conversation-', '.js') : null;

const outPath = codexDir ? path.join(codexDir, 'out', 'extension.js') : null;
const routePath = routeFile ? path.join(assetsDir, routeFile) : null;
const appMainPath = appMainFile ? path.join(assetsDir, appMainFile) : null;
const navigatePath = navigateFile ? path.join(assetsDir, navigateFile) : null;

const sourceWrapper = readText(SOURCE_WRAPPER);
const installedWrapper = readText(INSTALLED_WRAPPER);
const out = readText(outPath);
const route = readText(routePath);
const appMain = readText(appMainPath);
const navigate = readText(navigatePath);
const historyBlock = sliceFrom(out, 'case"navigate-in-current-editor-tab"', 1800);

const checks = {
    codexDirFound: Boolean(codexDir),
    sourceWrapperReadable: Boolean(sourceWrapper),
    installedWrapperReadable: Boolean(installedWrapper),
    wrapperSynced: Boolean(sourceWrapper && installedWrapper && sourceWrapper === installedWrapper),
    outReadable: Boolean(out),
    routeAssetReadable: Boolean(route),
    appMainReadable: Boolean(appMain),
    navigateAssetReadable: Boolean(navigate),
    routeHomeKind: Boolean(route && route.includes('o===`/`||o===`/Codex`||o===`/hotkey-window`')),
    routeReactCopy: Boolean(appMain && appMain.includes('path:`/Codex`')),
    historyClickCurrentPanel: Boolean(
        navigate && navigate.includes('if(s){i.dispatchMessage(`navigate-in-current-editor-tab`,{path:c});return}')
    ),
    historyUsesCurrentPanel: Boolean(
        historyBlock.includes('this.sendMessageToPanel(o,{type:"navigate-to-route",path:n,state:r.state})')
    ),
    noHistoryOpenWith: Boolean(historyBlock && !historyBlock.includes('vscode.openWith') && !historyBlock.includes('o.dispose()')),
    panelIconPatch: Boolean(
        out && out.includes('n.iconPath={light:Oe.Uri.joinPath(this.extensionUri,"resources","blossom-black.svg"),dark:Oe.Uri.joinPath(this.extensionUri,"resources","blossom-white.svg")};return this.editorPanels.set(n')
    ),
    titleRouteBridge: Boolean(route && route.includes('codex-route-local-thread-title') && route.includes('MutationObserver')),
    titleHostBridge: Boolean(out && out.includes('case"codex-route-local-thread-title":')),
    noFallbackCodexAgentTitleWrite: Boolean(out && !out.includes('let a=Pue(e??Due),l=a.replace')),
    logoFetchBlock: Boolean(out && out.includes('/^\\/aip\\/connectors\\/[^/]+\\/logo\\?/.test(e.url)')),
    codexHomeIpcSkip: Boolean(
        out && out.includes('(r==="panel"&&m0==="/Codex")||this.registerIpcClientForWebview(e)')
    ),
};

const failed = Object.entries(checks)
    .filter(([, ok]) => !ok)
    .map(([name]) => name);

console.log(JSON.stringify({
    ok: failed.length === 0,
    codexDir,
    files: {
        sourceWrapper: SOURCE_WRAPPER,
        installedWrapper: INSTALLED_WRAPPER,
        out: outPath,
        route: routePath,
        appMain: appMainPath,
        navigate: navigatePath,
    },
    checks,
    failed,
}, null, 2));

if (failed.length > 0) {
    process.exitCode = 1;
}
