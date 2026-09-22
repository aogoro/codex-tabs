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

// The codexHomeIpcSkip patch makes the follower conditional — the app host
// session registration must stay unconditional, or the webview never gets its
// services. That failure passes every marker check, so it needs its own guard.
// Codex renames the method and moves the call, hence one entry per shape.
const HOST_APP_VIEW_SHAPES = [
    // 26.814+: createClientCoordinationSession registers the session and
    // destructures the result. Wrapping the call would turn `}=` into `:`.
    /\}=this\.registerAppHostSessionForWebview\(/,
    // Up to 26.803: first statement of initializeWebview.
    /async initializeWebview\([^)]*\)\{this\.register(?:ClientCoordinationForWebview|IpcClientForWebview)\(/,
];

function hostAppViewIntact(out) {
    return Boolean(out) && HOST_APP_VIEW_SHAPES.some((re) => re.test(out));
}

// Icon and dedup checks anchored on the insertion sites rather than on the
// icon filename: Codex ships the blossom svgs and assigns them itself, so
// searching the bundle for `blossom-black.svg` is true before we touch
// anything. Each of these is false on a pristine bundle.

// panel-create-editor-icon inserts the assignment immediately before the
// `return this.editorPanels.set(` that ends createEditorPanel.
const PANEL_ICON_ON_CREATE = /\.iconPath=\{light:[^;]{0,400}\};return this\.editorPanels\.set\(/;

// custom-editor-icon-early inserts it as the first statement of
// resolveCustomEditor, ahead of the summary lookup, so a restored tab never
// flashes the default icon.
const PANEL_ICON_ON_RESOLVE = /async resolveCustomEditor\([^)]*\)\{[\w$]+\.iconPath=\{light:/;

// What custom-editor-icon-dedup collapses: stock sets the title and then the
// icon in one sequence, redundant once the icon is set on entry.
const STOCK_TITLE_ICON_DUPLICATE = /[\w$]+\.title=[\w$]+\([\w$]+\),[\w$]+\.iconPath=\{light:/;

function panelIconOnCreate(out) {
    return Boolean(out) && PANEL_ICON_ON_CREATE.test(out);
}

function panelIconOnResolve(out) {
    return Boolean(out) && PANEL_ICON_ON_RESOLVE.test(out);
}

function titleIconDedupApplied(out) {
    return Boolean(out) && !STOCK_TITLE_ICON_DUPLICATE.test(out);
}

// Minified identifiers carry `$`, which a raw splice into a RegExp turns into
// an end-of-input anchor. Same hazard as escapeRegExp in extension.js.
function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// route-home-kind has to land in the RouteScope resolver — the branch that
// returns an object with `routeKind:`home`` — and nowhere else. Searching the
// whole file for `===`/Codex`` is not enough: 26.825 emits a second pathname
// mapper (`EDe`, returns bare strings for telemetry) ahead of the resolver,
// the patch landed there, and the file-level check stayed green while the tab
// resolved to `other` and the home screen crashed.
const ROUTE_HOME_KIND_APPLIED = /===`\/Codex`\|\|[^;]{0,200}routeKind:`home`/;

// 26.908 pulled the pathname test out of the resolver into a standalone
// predicate — `function uh(e){return e===`/`||!1}` — that the resolver and the
// telemetry mapper both call. The splice belongs in that predicate, but then
// `routeKind:`home`` sits ~186 KB away, so the proximity check above can no
// longer prove placement. Resolve the predicate by name from the home branch
// instead, and anchor both the patch and its check on the declaration.
const HOME_BRANCH_PREDICATE = /([\w$]+)\(([\w$]+)\)\|\|\2===`\/hotkey-window`/;

function homePathPredicate(content) {
    const call = content && HOME_BRANCH_PREDICATE.exec(content);
    if (!call) return null;
    const name = call[1];
    const decl = new RegExp(
        `function ${escapeRe(name)}\\(([\\w$]+)\\)\\{return ([\\w$]+)===\`/\`\\|\\|`
    ).exec(content);
    // The declaration must test its own parameter — anything else means the
    // name resolved to an unrelated function and the splice would be blind.
    if (!decl || decl[1] !== decl[2]) return null;
    return { name, param: decl[1], index: decl.index, head: decl[0] };
}

function routeHomeKindApplied(route) {
    if (!route) return false;
    if (ROUTE_HOME_KIND_APPLIED.test(route)) return true;
    const pred = homePathPredicate(route);
    if (!pred) return false;
    return new RegExp(
        `function ${escapeRe(pred.name)}\\([\\w$]+\\)\\{return [^}]*===\`/Codex\``
    ).test(route);
}

module.exports = {
    findCodexExtDir,
    readCodexVersion,
    findFileByPrefix,
    findAssetByContent,
    findRouteAssetFile,
    findRouteTableFile,
    findNavigateFile,
    hostAppViewIntact,
    panelIconOnCreate,
    panelIconOnResolve,
    titleIconDedupApplied,
    homePathPredicate,
    routeHomeKindApplied,
};
