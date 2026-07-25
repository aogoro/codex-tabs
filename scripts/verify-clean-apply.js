#!/usr/bin/env node

// Dry-run: applies every patch to copies of the installed Codex files in a temp
// directory and checks the result. Use this after a Codex update — it names the
// first patch that no longer matches without touching the real installation.

const fs = require('fs');
const path = require('path');
const os = require('os');

const targets = require('../lib/targets');

function readText(file) {
    try { return fs.readFileSync(file, 'utf8'); } catch (_) { return null; }
}

function sliceFrom(content, needle, length) {
    if (!content) return '';
    const i = content.indexOf(needle);
    return i === -1 ? '' : content.slice(i, i + length);
}

// Prefer the .bak (pristine) copy; fall back to the live file when no backup
// exists yet — that happens when activation failed before the first write.
function pristineSource(file) {
    if (!file) return null;
    const bak = file + '.bak';
    return fs.existsSync(bak) ? bak : (fs.existsSync(file) ? file : null);
}

const codexDir = targets.findCodexExtDir();
if (!codexDir) {
    console.error('OpenAI Codex extension not found.');
    process.exit(2);
}

const assetsDir = path.join(codexDir, 'webview', 'assets');
const codexVersion = targets.readCodexVersion(codexDir);

const routeFile = targets.findRouteAssetFile(assetsDir);
const routeTableFile = targets.findRouteTableFile(assetsDir);
const navigateFile = targets.findNavigateFile(assetsDir);

const sources = {
    out: pristineSource(path.join(codexDir, 'out', 'extension.js')),
    route: routeFile ? pristineSource(path.join(assetsDir, routeFile)) : null,
    routeTable: routeTableFile ? pristineSource(path.join(assetsDir, routeTableFile)) : null,
    navigate: navigateFile ? pristineSource(path.join(assetsDir, navigateFile)) : null,
};

const missing = Object.entries(sources).filter(([, p]) => !p);
if (missing.length > 0) {
    console.error('Cannot locate target files:', missing.map(([k]) => k).join(', '));
    process.exit(2);
}

const tmpDir = path.join(os.tmpdir(), `codex-patch-test-${Date.now()}`);
const tmpOut = path.join(tmpDir, 'out');
const tmpAssets = path.join(tmpDir, 'webview', 'assets');
fs.mkdirSync(tmpOut, { recursive: true });
fs.mkdirSync(tmpAssets, { recursive: true });

const tmpOutExt = path.join(tmpOut, 'extension.js');
fs.copyFileSync(sources.out, tmpOutExt);
// Codex may serve several targets from one bundle; copy each name once.
const copied = new Set();
for (const [file, src] of [
    [routeFile, sources.route],
    [routeTableFile, sources.routeTable],
    [navigateFile, sources.navigate],
]) {
    if (!file || copied.has(file)) continue;
    fs.copyFileSync(src, path.join(tmpAssets, file));
    copied.add(file);
}
// package.json so the runner can report the Codex version.
fs.copyFileSync(path.join(codexDir, 'package.json'), path.join(tmpDir, 'package.json'));

const libPath = path.resolve(__dirname, '..', 'lib', 'targets.js');
const wrapperSrc = readText(path.resolve(__dirname, '..', 'extension.js'));
const patched = wrapperSrc
    .replace("const vscode = require('vscode');", 'const vscode = null;')
    .replace("require('./lib/targets')", `require(${JSON.stringify(libPath)})`);

const runnerPath = path.join(tmpDir, '_runner.js');
fs.writeFileSync(runnerPath, patched + `
try {
    const report = patchCodex(${JSON.stringify(tmpDir)});
    if (report.skipped.length > 0) {
        console.error('SKIPPED:', JSON.stringify(report.skipped.map((s) => ({ id: s.id, reason: s.reason }))));
    }
    console.log(report.patched ? 'PATCHES_APPLIED' : 'ALREADY_PATCHED');
} catch (e) {
    console.error('PATCH_FAILED:', e.message);
    process.exit(1);
}
`, 'utf8');

const { spawnSync } = require('child_process');
let skippedLine = '';
try {
    const result = spawnSync('node', [runnerPath], { encoding: 'utf8', timeout: 15000 });
    if (result.stderr) {
        process.stderr.write(result.stderr);
        skippedLine = result.stderr;
    }
    if (result.status !== 0) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        process.exit(1);
    }
    const stdout = result.stdout || '';
    if (!stdout.includes('PATCHES_APPLIED') && !stdout.includes('ALREADY_PATCHED')) {
        console.error('Unexpected output:', stdout);
        fs.rmSync(tmpDir, { recursive: true, force: true });
        process.exit(1);
    }
} catch (e) {
    console.error('Clean-apply failed:', e.stderr || e.stdout || e.message);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.exit(1);
}

const out = readText(tmpOutExt);
const route = routeFile ? readText(path.join(tmpAssets, routeFile)) : null;
const routeTable = routeTableFile ? readText(path.join(tmpAssets, routeTableFile)) : null;
const navigate = navigateFile ? readText(path.join(tmpAssets, navigateFile)) : null;
const historyBlock = sliceFrom(out, 'case"navigate-in-current-editor-tab"', 1800);

const checks = {
    routeHomeKind: Boolean(route && route.includes('===`/Codex`')),
    routeReactCopy: Boolean(routeTable && routeTable.includes('path:`/Codex`')),
    historyClickCurrentPanel: Boolean(
        navigate && navigate.includes('navigate-in-current-editor-tab')
    ),
    historyUsesCurrentPanel: Boolean(
        historyBlock.includes('sendMessageToPanel') && historyBlock.includes('"navigate-to-route"')
    ),
    noHistoryOpenWith: Boolean(historyBlock && !historyBlock.includes('vscode.openWith') && !historyBlock.includes('.dispose()')),
    panelIconPatch: Boolean(
        out && out.includes('"blossom-black.svg"') && out.includes('editorPanels.set(')
    ),
    titleBridge: Boolean(route && route.includes('__codexNewTabTitleBridge') && route.includes('MutationObserver')),
    titleRouteDispatch: Boolean(route && route.includes('codex-route-local-thread')),
    titleHostBridge: Boolean(out && out.includes('case"codex-route-local-thread-title":')),
    routeLabelParser: Boolean(out && out.includes('routeLabel')),
    logoFetchBlock: Boolean(out && out.includes('/^\\/aip\\/connectors\\/[^/]+\\/logo\\?/.test(')),
    codexHomeIpcSkip: Boolean(out && out.includes('__codexHomeNoFollower')),
    // A patch that renders the webview inert still passes every marker check —
    // this one failed silently once. The webview only gets its services from
    // the client-coordination registration in initializeWebview, so that call
    // must stay unconditional.
    hostAppViewIntact: /async initializeWebview\([^)]*\)\{this\.register(?:ClientCoordinationForWebview|IpcClientForWebview)\(/.test(out || ''),
};

// Marker checks only prove the text landed; parse the results to prove the
// injected code is valid JS. Webview assets are ES modules, the host is CJS.
function syntaxOk(file) {
    if (!file || !fs.existsSync(file)) return true;
    const src = readText(file);
    const isModule = /(^|[;\s])import[{ *]/.test(src) || /(^|[;\s])export[{ ]/.test(src);
    const probe = file + (isModule ? '.probe.mjs' : '.probe.cjs');
    fs.copyFileSync(file, probe);
    const res = spawnSync('node', ['--check', probe], { encoding: 'utf8', timeout: 60000 });
    if (res.status !== 0) console.error(`Syntax error in ${path.basename(file)}:\n${res.stderr}`);
    return res.status === 0;
}

checks.syntaxValid = [
    tmpOutExt,
    routeFile && path.join(tmpAssets, routeFile),
    routeTableFile && path.join(tmpAssets, routeTableFile),
    navigateFile && path.join(tmpAssets, navigateFile),
].filter(Boolean).every(syntaxOk);

const failed = Object.entries(checks)
    .filter(([, ok]) => !ok)
    .map(([name]) => name);

fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(JSON.stringify({ ok: failed.length === 0 && !skippedLine, codexVersion, checks, failed }, null, 2));

if (failed.length > 0 || skippedLine) {
    process.exitCode = 1;
}
