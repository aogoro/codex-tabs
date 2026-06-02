#!/usr/bin/env node

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

function findFileByPrefix(dir, prefix, ext) {
    try {
        return fs.readdirSync(dir).find((f) => f.startsWith(prefix) && f.endsWith(ext)) || null;
    } catch (_) {
        return null;
    }
}

function readText(file) {
    try { return fs.readFileSync(file, 'utf8'); } catch (_) { return null; }
}

function sliceFrom(content, needle, length) {
    if (!content) return '';
    const i = content.indexOf(needle);
    return i === -1 ? '' : content.slice(i, i + length);
}

const codexDir = findCodexExtDir();
if (!codexDir) {
    console.error('OpenAI Codex extension not found.');
    process.exit(2);
}

const assetsDir = path.join(codexDir, 'webview', 'assets');
const outBak = path.join(codexDir, 'out', 'extension.js.bak');

const routeFile = findFileByPrefix(assetsDir, 'route-scope-', '.js');
const appMainFile = findFileByPrefix(assetsDir, 'app-main-', '.js');
const navigateFile = findFileByPrefix(assetsDir, 'use-navigate-to-local-conversation-', '.js');

const routeBak = routeFile ? path.join(assetsDir, routeFile + '.bak') : null;
const appMainBak = appMainFile ? path.join(assetsDir, appMainFile + '.bak') : null;
const navigateBak = navigateFile ? path.join(assetsDir, navigateFile + '.bak') : null;

const bakFiles = { out: outBak, route: routeBak, appMain: appMainBak, navigate: navigateBak };
const missing = Object.entries(bakFiles).filter(([, p]) => !p || !fs.existsSync(p));
if (missing.length > 0) {
    console.error('Missing .bak files:', missing.map(([k]) => k).join(', '));
    console.error('Run the extension at least once to create backup files.');
    process.exit(2);
}

const tmpDir = path.join(os.tmpdir(), `codex-patch-test-${Date.now()}`);
const tmpOut = path.join(tmpDir, 'out');
const tmpAssets = path.join(tmpDir, 'webview', 'assets');
fs.mkdirSync(tmpOut, { recursive: true });
fs.mkdirSync(tmpAssets, { recursive: true });

const tmpOutExt = path.join(tmpOut, 'extension.js');
fs.copyFileSync(outBak, tmpOutExt);
if (routeBak && routeFile) fs.copyFileSync(routeBak, path.join(tmpAssets, routeFile));
if (appMainBak && appMainFile) fs.copyFileSync(appMainBak, path.join(tmpAssets, appMainFile));
if (navigateBak && navigateFile) fs.copyFileSync(navigateBak, path.join(tmpAssets, navigateFile));

const wrapperSrc = readText(path.resolve(__dirname, '..', 'extension.js'));
const patched = wrapperSrc
    .replace("const vscode = require('vscode');", 'const vscode = null;')
    .replace(
        /function findCodexExtDir\(\)\s*\{[\s\S]*?\n\}/,
        `function findCodexExtDir() { return ${JSON.stringify(tmpDir)}; }`
    );

const runnerPath = path.join(tmpDir, '_runner.js');
fs.writeFileSync(runnerPath, patched + `
try {
    const changed = patchCodex();
    console.log(changed ? 'PATCHES_APPLIED' : 'ALREADY_PATCHED');
} catch (e) {
    console.error('PATCH_FAILED:', e.message);
    process.exit(1);
}
`, 'utf8');

const { execFileSync } = require('child_process');
try {
    const stdout = execFileSync('node', [runnerPath], { encoding: 'utf8', timeout: 15000 });
    if (!stdout.includes('PATCHES_APPLIED') && !stdout.includes('ALREADY_PATCHED')) {
        console.error('Unexpected output:', stdout);
        process.exit(1);
    }
} catch (e) {
    console.error('Clean-apply failed:', e.stderr || e.stdout || e.message);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.exit(1);
}

const out = readText(tmpOutExt);
const route = routeFile ? readText(path.join(tmpAssets, routeFile)) : null;
const appMain = appMainFile ? readText(path.join(tmpAssets, appMainFile)) : null;
const navigate = navigateFile ? readText(path.join(tmpAssets, navigateFile)) : null;
const historyBlock = sliceFrom(out, 'case"navigate-in-current-editor-tab"', 1800);

const checks = {
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
        out && out.includes('n.iconPath={light:Fe.Uri.joinPath(this.extensionUri,"resources","blossom-black.svg"),dark:Fe.Uri.joinPath(this.extensionUri,"resources","blossom-white.svg")};return this.editorPanels.set(n')
    ),
    titleRouteBridge: Boolean(route && route.includes('codex-route-local-thread-title') && route.includes('MutationObserver')),
    titleHostBridge: Boolean(out && out.includes('case"codex-route-local-thread-title":')),
    noFallbackCodexAgentTitleWrite: Boolean(out && !out.includes('let a=nfe(e??sfe),l=a.replace')),
    logoFetchBlock: Boolean(out && out.includes('/^\\/aip\\/connectors\\/[^/]+\\/logo\\?/.test(e.url)')),
    codexHomeIpcSkip: Boolean(
        out && out.includes('(r==="panel"&&m0==="/Codex")||this.registerIpcClientForWebview(e)')
    ),
};

const failed = Object.entries(checks)
    .filter(([, ok]) => !ok)
    .map(([name]) => name);

fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(JSON.stringify({ ok: failed.length === 0, checks, failed }, null, 2));

if (failed.length > 0) {
    process.exitCode = 1;
}
