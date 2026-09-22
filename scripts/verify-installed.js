#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const os = require('os');

const pkg = require('../package.json');
const targets = require('../lib/targets');
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

function sliceFrom(content, needle, length) {
    if (!content) return '';
    const index = content.indexOf(needle);
    return index === -1 ? '' : content.slice(index, index + length);
}

const codexDir = targets.findCodexExtDir();
const assetsDir = codexDir ? path.join(codexDir, 'webview', 'assets') : null;
const routeFile = assetsDir ? targets.findRouteAssetFile(assetsDir) : null;
const routeTableFile = assetsDir ? targets.findRouteTableFile(assetsDir) : null;
const navigateFile = assetsDir ? targets.findNavigateFile(assetsDir) : null;

const outPath = codexDir ? path.join(codexDir, 'out', 'extension.js') : null;
const routePath = routeFile ? path.join(assetsDir, routeFile) : null;
const routeTablePath = routeTableFile ? path.join(assetsDir, routeTableFile) : null;
const navigatePath = navigateFile ? path.join(assetsDir, navigateFile) : null;

const sourceWrapper = readText(SOURCE_WRAPPER);
const installedWrapper = readText(INSTALLED_WRAPPER);
const out = readText(outPath);
const route = readText(routePath);
const routeTable = readText(routeTablePath);
const navigate = readText(navigatePath);
const historyBlock = sliceFrom(out, 'case"navigate-in-current-editor-tab"', 1800);

const checks = {
    codexDirFound: Boolean(codexDir),
    sourceWrapperReadable: Boolean(sourceWrapper),
    installedWrapperReadable: Boolean(installedWrapper),
    wrapperSynced: Boolean(sourceWrapper && installedWrapper && sourceWrapper === installedWrapper),
    outReadable: Boolean(out),
    routeAssetReadable: Boolean(route),
    routeTableReadable: Boolean(routeTable),
    navigateAssetReadable: Boolean(navigate),
    routeHomeKind: targets.routeHomeKindApplied(route),
    routeReactCopy: Boolean(routeTable && routeTable.includes('path:`/Codex`')),
    historyClickCurrentPanel: Boolean(
        navigate && navigate.includes('navigate-in-current-editor-tab')
    ),
    historyUsesCurrentPanel: Boolean(
        historyBlock.includes('sendMessageToPanel') && historyBlock.includes('"navigate-to-route"')
    ),
    noHistoryOpenWith: Boolean(historyBlock && !historyBlock.includes('vscode.openWith') && !historyBlock.includes('.dispose()')),
    panelIconOnCreate: targets.panelIconOnCreate(out),
    panelIconOnResolve: targets.panelIconOnResolve(out),
    titleRouteBridge: Boolean(
        route
        && route.includes('__codexNewTabTitleBridge')
        && route.includes('MutationObserver')
        // Dispatched on the module alias, never on `this` — see the same check
        // in verify-clean-apply.js.
        && !route.includes('this.dispatchMessage(`codex-route-local-thread`')
    ),
    titleHostBridge: Boolean(out && out.includes('case"codex-route-local-thread-title":')),
    routeLabelParser: Boolean(out && out.includes('routeLabel')),
    titlePreviewFallback: Boolean(out && out.includes('??__rl)')),
    titleIconDedup: targets.titleIconDedupApplied(out),
    logoFetchBlock: Boolean(out && out.includes('/^\\/aip\\/connectors\\/[^/]+\\/logo\\?/.test(')),
    codexHomeIpcSkip: Boolean(out && out.includes('__codexHomeNoFollower')),
    hostAppViewIntact: targets.hostAppViewIntact(out),
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
        routeTable: routeTablePath,
        navigate: navigatePath,
    },
    checks,
    failed,
}, null, 2));

if (failed.length > 0) {
    process.exitCode = 1;
}
