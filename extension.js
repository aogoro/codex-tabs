const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const targets = require('./lib/targets');

const CODEX_CUSTOM_EDITOR = 'chatgpt.conversationEditor';
const RESTORE_DELAY_MS = 700;
const PATCH_MARKER = 'path:`/Codex`';

const TRANSPARENT_PNG_BASE64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

// Defined lazily at the local-thread route site, where the webview message
// dispatcher (__DISPATCH__) is guaranteed to be in scope — the bundle wraps
// modules in lazy initializers, so a file-level insert would land in the wrong
// closure.
const ROUTE_TITLE_DOM_BRIDGE =
    'globalThis.__codexNewTabTitleBridge||(globalThis.__codexNewTabTitleBridge=function(e){try{let t=()=>{let t=[...document.querySelectorAll(`[data-thread-title],h1,[role=heading]`)].map(e=>({e,r:e.getBoundingClientRect()})).filter(({e:t,r:n})=>n.width>0&&n.height>0&&t.textContent).sort((e,t)=>e.r.top-t.r.top||e.r.left-t.r.left).map(({e})=>e.textContent.replace(/\\s+/g,` `).trim()).find(e=>e&&e!==`Codex`&&e!==`Codex Agent`&&e!==`Untitled`&&e.length<120);t&&__DISPATCH__.dispatchMessage(`codex-route-local-thread-title`,{conversationId:e,title:t})};t(),[500,1500,4000,9000,2e4].forEach(e=>setTimeout(t,e)),globalThis.__codexNewTabTitleObserver?.disconnect?.(),globalThis.__codexNewTabTitleObserver=new MutationObserver(t),document.body&&globalThis.__codexNewTabTitleObserver.observe(document.body,{subtree:!0,childList:!0,characterData:!0})}catch{}});';

const HISTORY_PATCH_TEMPLATE =
    'case"navigate-in-new-editor-tab":{let n=r.path,o=/^\\/local\\/([^/]+)/.exec(n);if(o)try{let{summary:e}=await this.conversationSummaryProvider.getConversationSummary(o[1]),r=__TITLE_FN__(e?.preview??__TITLE_DEFAULT__);r=r.replace(/[\\\\/]/g," ").replace(/\\s+/g," ").trim();n=`/local/${o[1]}/${r}`}catch{try{let e=(await this.previewLoader.fetchConversationPreviews()).get(o[1]);e&&(e=__TITLE_FN__(e).replace(/[\\\\/]/g," ").replace(/\\s+/g," ").trim(),n=`/local/${o[1]}/${e}`)}catch{}}__NS__.commands.executeCommand("vscode.open",__URI_FN__(n));break}case"navigate-in-current-editor-tab":{let n=r.path,o=this.findPanelByWebview(e),i=/^\\/local\\/([^/]+)/.exec(n)?.[1],s=null,a=null;if(i)try{let{summary:e}=await this.conversationSummaryProvider.getConversationSummary(i);s=e?.preview??null,a=e?.modelProvider??null}catch(e){this.logger.error("Error fetching conversation summary",{safe:{error:e},sensitive:{}})}if(i&&s==null)try{s=(await this.previewLoader.fetchConversationPreviews()).get(i)??null}catch{}if(o&&i){o.iconPath={light:__NS__.Uri.joinPath(this.extensionUri,"resources","blossom-black.svg"),dark:__NS__.Uri.joinPath(this.extensionUri,"resources","blossom-white.svg")};let e=s!=null?__TITLE_FN__(s):null,l=(e??__TITLE_DEFAULT__).replace(/[\\\\/]/g," ").replace(/\\s+/g," ").trim(),c=__URI_FN__(`/local/${i}/${l}`);e!=null&&(o.title=e);this.chatSessionItemProvider?.registerPendingConversation({conversationId:i,resource:c,label:s??void 0,modelProvider:a},{markInProgress:!1,onlyIfMissing:!0});this.sendMessageToPanel(o,{type:"navigate-to-route",path:n,state:r.state})}else if(o){s!=null&&(o.title=__TITLE_FN__(s));this.sendMessageToPanel(o,{type:"navigate-to-route",path:n,state:r.state})}else __NS__.commands.executeCommand("vscode.open",__URI_FN__(n));break}';

const TITLE_PATCH_TEMPLATE =
    'case"codex-route-local-thread":{let n=r.conversationId,o=this.findPanelByWebview(e);if(o&&typeof n=="string"){o.iconPath={light:__NS__.Uri.joinPath(this.extensionUri,"resources","blossom-black.svg"),dark:__NS__.Uri.joinPath(this.extensionUri,"resources","blossom-white.svg")};let i=async()=>{let e=null,s=null;try{let{summary:r}=await this.conversationSummaryProvider.getConversationSummary(n);e=r?.preview??null,s=r?.modelProvider??null}catch{}if(e==null)try{e=(await this.previewLoader.fetchConversationPreviews()).get(n)??null}catch{}if(e!=null){let a=__TITLE_FN__(e),l=a.replace(/[\\\\/]/g," ").replace(/\\s+/g," ").trim();this.isPanelAlive(o)&&(o.title=a,this.chatSessionItemProvider?.registerPendingConversation({conversationId:n,resource:__URI_FN__(`/local/${n}/${l}`),label:e,modelProvider:s},{markInProgress:!1,onlyIfMissing:!0}))}};i(),[1500,5000,12000,30000].forEach(e=>setTimeout(i,e))}break}case"codex-route-local-thread-title":{let n=r.conversationId,o=r.title,i=this.findPanelByWebview(e);if(i&&typeof n=="string"&&typeof o=="string"){let s=__TITLE_FN__(o);if(s!==__TITLE_DEFAULT__){let a=s.replace(/[\\\\/]/g," ").replace(/\\s+/g," ").trim();i.iconPath={light:__NS__.Uri.joinPath(this.extensionUri,"resources","blossom-black.svg"),dark:__NS__.Uri.joinPath(this.extensionUri,"resources","blossom-white.svg")},i.title=s,this.chatSessionItemProvider?.registerPendingConversation({conversationId:n,resource:__URI_FN__(`/local/${n}/${a}`),label:o,modelProvider:null},{markInProgress:!1,onlyIfMissing:!0})}}break}';

function applyTemplate(template, ids) {
    return template
        .replaceAll('__NS__', ids.ns)
        .replaceAll('__TITLE_FN__', ids.titleFn)
        .replaceAll('__TITLE_DEFAULT__', ids.titleDefault)
        .replaceAll('__URI_FN__', ids.uriFn);
}

// String.replace treats `$` sequences in the replacement as patterns; minified
// identifiers may contain `$`, so always replace via a function.
function replaceLiteral(content, find, replacement) {
    return content.replace(find, () => replacement);
}

function makeIconPath(ns) {
    return `{light:${ns}.Uri.joinPath(this.extensionUri,"resources","blossom-black.svg"),dark:${ns}.Uri.joinPath(this.extensionUri,"resources","blossom-white.svg")}`;
}

// --- Discovery ---

function discoverHost(content) {
    const ID = String.raw`[$A-Z_a-z][$\w]*`;
    const m = (re) => { const r = content.match(new RegExp(re)); return r ? r[1] : null; };
    const schemeConst = m(`(${ID})="openai-codex"`);
    return {
        ns:           m(`(${ID})\\.window\\.createWebviewPanel`),
        titleFn:      m(`function (${ID})\\([^)]*\\)\\{return [^}]*\\.substring\\(0,`),
        titleDefault: m(`title\\?\\?(${ID}),\\{viewColumn:`),
        // The route uri builder. `[^{}]*` tolerates statements before the
        // return — Codex 26.803 splits the query string off the path first —
        // and the `.with({scheme:` tail is what separates it from the several
        // unrelated `*.Uri.file` path helpers in the same bundle.
        uriFn: schemeConst
            ? m(`function (${ID})\\([^)]*\\)\\{[^{}]*return ${ID}\\.Uri\\.file\\([^)]*\\)\\.with\\(\\{scheme:${schemeConst}`)
            : null,
        parserFn:     m(`function (${ID})\\([^)]*\\)\\{let\\{scheme:[^,]+,authority:[^,]+,path:`),
        schemeConst,
        authConst:    m(`(${ID})="route"`),
    };
}

function discoverDispatcher(content) {
    const aliasMatch = content.match(/([\w$]+)\.dispatchMessage/);
    return aliasMatch ? aliasMatch[1] : null;
}

function parseParams(content, anchor) {
    const re = new RegExp(anchor + String.raw`\(([^)]*)\)\{`);
    const m = content.match(re);
    return m ? m[1].split(',') : null;
}

function requireDiscovery(ids, label) {
    const missing = Object.entries(ids).filter(([, v]) => !v).map(([k]) => k);
    if (missing.length > 0) throw new Error(`[codex-new-tab] ${label} discovery failed: ${missing.join(', ')}`);
    return ids;
}

// --- Utility ---

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeCodexNewTabUri() {
    const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return vscode.Uri.file('/Codex').with({
        scheme: 'openai-codex',
        authority: 'route',
        query: `codexOpen=${nonce}`,
    });
}

async function openCodexTab(viewColumn) {
    try {
        await vscode.commands.executeCommand('chatgpt.newCodexPanel');
    } catch (_) {
        const activeColumn = viewColumn
            || (vscode.window.activeTextEditor && vscode.window.activeTextEditor.viewColumn);
        const uri = makeCodexNewTabUri();
        await vscode.commands.executeCommand('vscode.openWith', uri, CODEX_CUSTOM_EDITOR, {
            viewColumn: activeColumn || vscode.ViewColumn.Active,
            preserveFocus: false,
            preview: false,
        });
    }
}

async function addToThreadKeepExplorer() {
    const activeEditor = vscode.window.activeTextEditor;
    const activeColumn = activeEditor && activeEditor.viewColumn;
    const activeSelection = activeEditor && activeEditor.selection;

    await vscode.commands.executeCommand('chatgpt.addToThread');
    await delay(RESTORE_DELAY_MS);
    await vscode.commands.executeCommand('workbench.view.explorer');

    if (activeEditor) {
        await vscode.window.showTextDocument(activeEditor.document, {
            viewColumn: activeColumn || vscode.ViewColumn.Active,
            preserveFocus: false,
            selection: activeSelection,
        });
    }
}

function backupFile(filePath) {
    const bak = filePath + '.bak';
    if (!fs.existsSync(bak)) fs.copyFileSync(filePath, bak);
}

function patchFailed(id, filePath, reason) {
    return new Error(`[codex-new-tab] required patch failed: ${id} (${filePath}) ${reason}`);
}

function defaultVerify(marker) {
    return (content) => content.includes(marker);
}

function replaceBetween(content, startAnchor, endAnchor, replacement) {
    const start = content.indexOf(startAnchor);
    if (start === -1) return null;
    const end = content.indexOf(endAnchor, start + startAnchor.length);
    if (end === -1) return null;
    return content.substring(0, start) + replacement + content.substring(end);
}

// Exact `[start, end)` of a `function NAME(...){...}` declaration, by brace
// balance. Ending a replacement at "the next function we know about" instead
// silently deletes anything Codex emits in between: 26.803 inserted a live
// helper between the route parser and the uri builder, and the marker check
// plus `node --check` both pass on the result.
// Strings and template literals are tracked; regex literals are not — a `{`
// or a quote inside one would throw the scan off. None of the functions we
// patch contain one, and a bad scan degrades to a skipped patch, not a
// corrupted bundle.
function findFunctionSpan(content, name) {
    const start = content.indexOf(`function ${name}(`);
    if (start === -1) return null;
    const bodyStart = content.indexOf('{', start);
    if (bodyStart === -1) return null;

    const stack = []; // '{' = code block, '`' = template literal
    let quote = null;
    for (let i = bodyStart; i < content.length; i++) {
        const ch = content[i];
        if (quote) {
            if (ch === '\\') i++;
            else if (ch === quote) quote = null;
            continue;
        }
        if (stack[stack.length - 1] === '`') {
            if (ch === '\\') i++;
            else if (ch === '`') stack.pop();
            else if (ch === '$' && content[i + 1] === '{') { stack.push('{'); i++; }
            continue;
        }
        if (ch === '"' || ch === "'") quote = ch;
        else if (ch === '`' || ch === '{') stack.push(ch);
        else if (ch === '}') {
            stack.pop();
            if (stack.length === 0) return [start, i + 1];
        }
    }
    return null;
}

function applyPatchSpec(spec, report) {
    const {
        id,
        file,
        marker,
        old,
        new: nextText,
        required = true,
        verify = marker ? defaultVerify(marker) : null,
        transform,
    } = spec;

    // Required patches abort activation; optional ones degrade the feature they
    // carry and are reported to the user as a warning.
    const fail = (reason) => {
        if (required) throw patchFailed(id, file, reason);
        if (report) report.skipped.push({ id, file, reason });
        return false;
    };

    if (!file || !fs.existsSync(file)) return fail('file not found');

    const content = fs.readFileSync(file, 'utf8');
    if (verify && verify(content)) return false;

    let result = content;
    if (transform) {
        result = transform(content);
        if (result === null) return fail('old text not found');
    } else {
        const variants = Array.isArray(old) ? old : [old];
        const found = variants.find((candidate) => candidate && content.includes(candidate));
        if (!found) return fail('old text not found');
        result = replaceLiteral(content, found, nextText);
    }

    if (!result || result === content) return fail('no change produced');
    if (verify && !verify(result)) return fail('verification failed after patch');

    backupFile(file);
    fs.writeFileSync(file, result, 'utf8');
    return true;
}

function applyPatchGroup(patches, report) {
    let changed = false;
    for (const patch of patches) {
        if (applyPatchSpec(patch, report)) changed = true;
    }
    return changed;
}

// --- Patches ---

function patchRouteHome(assetsDir, report) {
    const routeFile = targets.findRouteAssetFile(assetsDir);
    const routeTableFile = targets.findRouteTableFile(assetsDir);
    const routePath = routeFile ? path.join(assetsDir, routeFile) : null;
    const routeTablePath = routeTableFile ? path.join(assetsDir, routeTableFile) : null;

    return applyPatchGroup([
        {
            id: 'route-home-kind',
            file: routePath,
            marker: '===`/Codex`',
            transform(content) {
                if (content.includes('===`/Codex`')) return null;
                const re = /([\w$])===`\/`\|\|/;
                const m = re.exec(content);
                if (!m) return null;
                const v = m[1];
                return replaceLiteral(content, m[0], `${v}===\`/\`||${v}===\`/Codex\`||`);
            },
        },
        {
            id: 'route-home-react-copy',
            file: routeTablePath,
            marker: PATCH_MARKER,
            transform(content) {
                if (content.includes(PATCH_MARKER)) return content;

                // Codex 26.721: the home route is a bare element inheriting the
                // parent layout — `(0,o5.jsx)(Xa,{path:`/`})`.
                const bareRe = /\(0,([\w$]+)\.jsx\)\(([\w$]+),\{path:`\/`\}\)/;
                const bare = bareRe.exec(content);
                if (bare) {
                    const insertAt = bare.index + bare[0].length;
                    const copy = `,(0,${bare[1]}.jsx)(${bare[2]},{path:\`/Codex\`})`;
                    return content.substring(0, insertAt) + copy + content.substring(insertAt);
                }

                // Older builds: `(0,X.jsx)(Route,{path:`/`,element:...})`.
                const homeRoute = 'path:`/`,';
                const idx = content.indexOf(homeRoute);
                if (idx === -1) return content;
                const searchStart = Math.max(0, idx - 60);
                const before = content.substring(searchStart, idx);
                const jsxMatch = before.match(/\(0,[A-Za-z_$]+\.jsx\)\(/g);
                if (!jsxMatch) return content;
                const jsxCall = jsxMatch[jsxMatch.length - 1];
                const jsxOff = before.lastIndexOf(jsxCall);
                const nextSep = content.indexOf('),' + jsxCall, idx);
                if (jsxOff === -1 || nextSep === -1) return content;
                const routeStart = searchStart + jsxOff;
                const routeEnd = nextSep + 1;
                const original = content.substring(routeStart, routeEnd);
                const copy = replaceLiteral(original, 'path:`/`', 'path:`/Codex`');
                return content.substring(0, routeEnd) + ',' + copy + content.substring(routeEnd);
            },
        },
    ], report);
}

function patchHistoryNavigation(assetsDir, extensionPath, ids, report) {
    const navigateFile = targets.findNavigateFile(assetsDir);
    const navigatePath = navigateFile ? path.join(assetsDir, navigateFile) : null;

    return applyPatchGroup([
        {
            id: 'history-click-current-panel',
            file: navigatePath,
            required: false,
            marker: 'navigate-in-current-editor-tab',
            transform(content) {
                if (content.includes('navigate-in-current-editor-tab')) return null;
                if (!content.includes('navigate-in-new-editor-tab')) return null;
                return replaceLiteral(
                    content,
                    'navigate-in-new-editor-tab',
                    'navigate-in-current-editor-tab'
                );
            },
        },
        {
            id: 'history-host-current-panel',
            file: extensionPath,
            required: false,
            marker: null,
            verify(content) {
                const start = content.indexOf('case"navigate-in-current-editor-tab"');
                if (start === -1) return false;
                const block = content.slice(start, start + 1600);
                return block.includes('this.sendMessageToPanel')
                    && block.includes('"blossom-black.svg"')
                    && !block.includes('vscode.openWith')
                    && !block.includes('.dispose()');
            },
            transform(content) {
                return replaceBetween(content,
                    'case"navigate-in-new-editor-tab":',
                    'case"open-vscode-command":{',
                    applyTemplate(HISTORY_PATCH_TEMPLATE, ids));
            },
        },
    ], report);
}

function patchPanelLifecycle(extensionPath, ids, report) {
    const resolveParams = parseParams(
        fs.readFileSync(extensionPath, 'utf8'),
        'async resolveCustomEditor'
    );
    const panelParam = resolveParams ? resolveParams[1] : 'r';

    const editorPanelSetRe = /return this\.editorPanels\.set\((\w+)/;

    return applyPatchGroup([
        {
            // A /Codex home panel must not register the thread-follower IPC
            // handlers — it would compete with the panel that actually owns the
            // active thread. Only those handlers are skipped: everything else
            // in the client-coordination session (notably the app host session
            // that gives the webview its services) must stay, or the panel
            // renders an empty shell.
            id: 'panel-codex-home-ipc-skip',
            file: extensionPath,
            required: false,
            marker: '__codexHomeNoFollower',
            transform(content) {
                const re = /([\w$]+)=([\w$]+)\(\{hostId:"local",ipcClient:([\w$]+),viewService:([\w$]+)\.services\.clientCoordination\}\)/;
                const m = re.exec(content);
                if (!m) return null;
                const [full, resultVar, followerFn, ipcVar, appViewVar] = m;
                const sessionParams = parseParams(content, 'createClientCoordinationSession');
                const webviewVar = sessionParams ? sessionParams[0] : 'e';
                const replacement =
                    `${resultVar}=(__codexHomeNoFollower=>__codexHomeNoFollower?()=>{}:`
                    + `${followerFn}({hostId:"local",ipcClient:${ipcVar},viewService:${appViewVar}.services.clientCoordination}))`
                    + `(this.editorPanels.get(this.findPanelByWebview(${webviewVar}))?.initialRoute==="/Codex")`;
                return replaceLiteral(content, full, replacement);
            },
        },
        {
            id: 'panel-new-chat-route',
            file: extensionPath,
            marker: 'initialRoute:"/Codex"',
            transform(content) {
                const replacement = `async createNewPanel(){let e=${ids.ns}.window.activeTextEditor?.viewColumn??${ids.ns}.ViewColumn.Active;await this.createEditorPanel({title:${ids.titleDefault},initialRoute:"/Codex",viewColumn:e,preserveFocus:!1})}`;
                return replaceBetween(content, 'async createNewPanel(){', 'deliverMcpResponseToOrigin(', replacement);
            },
        },
        {
            id: 'panel-create-editor-icon',
            file: extensionPath,
            required: false,
            marker: null,
            verify(content) {
                const cwpIdx = content.indexOf(ids.ns + '.window.createWebviewPanel');
                if (cwpIdx === -1) return false;
                const afterCwp = content.slice(cwpIdx, cwpIdx + 800);
                return afterCwp.includes('"blossom-black.svg"');
            },
            transform(content) {
                const cwpIdx = content.indexOf(ids.ns + '.window.createWebviewPanel');
                if (cwpIdx === -1) return null;
                const insertBefore = 'return this.editorPanels.set(';
                const insertIdx = content.indexOf(insertBefore, cwpIdx);
                if (insertIdx === -1 || insertIdx > cwpIdx + 800) return null;
                const panelMatch = content.slice(insertIdx).match(editorPanelSetRe);
                if (!panelMatch) return null;
                const pv = panelMatch[1];
                const iconStr = `${pv}.iconPath=${makeIconPath(ids.ns)};`;
                return content.substring(0, insertIdx) + iconStr + content.substring(insertIdx);
            },
        },
        {
            id: 'custom-editor-icon-early',
            file: extensionPath,
            required: false,
            marker: null,
            verify(content) {
                const anchor = 'async resolveCustomEditor(';
                const idx = content.indexOf(anchor);
                if (idx === -1) return false;
                const after = content.slice(idx, idx + 300);
                return after.includes('"blossom-black.svg"');
            },
            transform(content) {
                const anchor = `async resolveCustomEditor(${resolveParams ? resolveParams.join(',') : 'e,r,n'}){`;
                const idx = content.indexOf(anchor);
                if (idx === -1) return null;
                const afterBrace = idx + anchor.length;
                const iconAssign = `${panelParam}.iconPath=${makeIconPath(ids.ns)};`;
                return content.substring(0, afterBrace) + iconAssign + content.substring(afterBrace);
            },
        },
        {
            id: 'custom-editor-icon-dedup',
            file: extensionPath,
            required: false,
            marker: null,
            verify(content) {
                const re = new RegExp(
                    String.raw`\w+\.title=` + ids.titleFn + String.raw`\(\w+\),\w+\.iconPath=\{light:`
                );
                return !re.test(content);
            },
            transform(content) {
                const re = new RegExp(
                    String.raw`(\w+\.title=` + ids.titleFn + String.raw`\(\w+\)),\w+\.iconPath=\{[^}]+\},(\w+!=null&&)`
                );
                const m = re.exec(content);
                if (!m) return null;
                return replaceLiteral(content, m[0], m[1] + ',' + m[2]);
            },
        },
    ], report);
}

function patchTabTitles(assetsDir, extensionPath, ids, report) {
    const routeFile = targets.findRouteAssetFile(assetsDir);
    const routePath = routeFile ? path.join(assetsDir, routeFile) : null;

    return applyPatchGroup([
        {
            // Injected at the local-thread route site: tells the host which
            // conversation the panel now shows, and installs a DOM observer
            // that reports the rendered thread title. Both the dispatcher alias
            // and the bridge live at that site, so no import injection and no
            // assumptions about the module wrapper shape.
            id: 'route-title-bridge',
            file: routePath,
            required: false,
            marker: 'codex-route-local-thread',
            transform(content) {
                const dispatch = discoverDispatcher(content);
                if (!dispatch) return null;

                // return{conversationId:ul(r),pathname:e,projectContext:i,
                //   routeKind:`local-thread`,routeTemplate:t,search:n}
                const returnRe = /return\{conversationId:([\w$]+)\(([\w$]+)\),([^{}]*routeKind:`local-thread`[^{}]*)\}/;
                const m = returnRe.exec(content);
                if (!m) return null;
                const [full, convFn, rawId, rest] = m;
                const bridge = ROUTE_TITLE_DOM_BRIDGE.replaceAll('__DISPATCH__', dispatch);
                const replacement =
                    `let __cv=${convFn}(${rawId});try{${bridge}` +
                    `globalThis.__codexNewTabRouteConversationId!==__cv&&(globalThis.__codexNewTabRouteConversationId=__cv,` +
                    `${dispatch}.dispatchMessage(\`codex-route-local-thread\`,{conversationId:__cv})),` +
                    `globalThis.__codexNewTabTitleBridge(__cv)}catch{}` +
                    `return{conversationId:__cv,${rest}}`;
                return replaceLiteral(content, full, replacement);
            },
        },
        {
            id: 'host-title-route-label-parser',
            file: extensionPath,
            required: false,
            marker: 'routeLabel',
            transform(content) {
                const span = findFunctionSpan(content, ids.parserFn);
                if (!span) return null;
                const [startIdx, endIdx] = span;
                const original = content.slice(startIdx, endIdx);
                // The parser has no nested closures; a `function` inside the
                // span means the scan ran past its target, and replacing it
                // would delete live code.
                if (original.indexOf('function ', 1) !== -1) return null;

                const paramMatch = original.match(/function \w+\((\w+)\)/);
                const p = paramMatch ? paramMatch[1] : 't';
                // `path` keeps the query string, matching what Codex itself
                // returns since 26.803 — `fsPath` would drop it. `routeLabel`
                // is what this patch is actually here for: the conversation
                // title carried in the path segments after the id.
                const replacement = `function ${ids.parserFn}(${p}){let{scheme:e,authority:r,path:n}=${p};if(e!==${ids.schemeConst})return null;if(r!==${ids.authConst})return null;let i=(n.startsWith("/")?n.slice(1):n).split("/"),s=null,a=null;if(i.length>=2&&(i[0]==="local"||i[0]==="remote")&&(s=i[1]),i.length>=3)try{a=decodeURIComponent(i.slice(2).join("/"))}catch{}return{path:n+(${p}.query===""?"":"?"+${p}.query),conversationId:s,routeLabel:a}}`;
                return content.substring(0, startIdx) + replacement + content.substring(endIdx);
            },
        },
        {
            id: 'host-title-route-label-init',
            file: extensionPath,
            required: false,
            marker: 'routeLabel:__rl',
            transform(content) {
                const re = /let\{conversationId:(\w+)\}=(\w+),(\w+)=null,(\w+)=null;/;
                const resolveIdx = content.indexOf('async resolveCustomEditor(');
                if (resolveIdx === -1) return null;
                const searchSlice = content.slice(resolveIdx, resolveIdx + 2000);
                const m = re.exec(searchSlice);
                if (!m) return null;
                const [full, convId, routeObj, preview, modelProv] = m;
                const replacement = `let{conversationId:${convId},routeLabel:__rl}=${routeObj},${preview}=__rl,${modelProv}=null;`;
                const absIdx = resolveIdx + m.index;
                return content.substring(0, absIdx) + replacement + content.substring(absIdx + full.length);
            },
        },
        {
            id: 'host-title-route-label-preview-fallback',
            file: extensionPath,
            required: false,
            marker: '??__rl)',
            transform(content) {
                const re = new RegExp(
                    String.raw`this\.isPanelAlive\((\w+)\)&&\(\1\.title=` +
                    ids.titleFn +
                    String.raw`\((\w+)\)\)`
                );
                const m = re.exec(content);
                if (!m) return null;
                const [full, pv, lv] = m;
                const replacement = `this.isPanelAlive(${pv})&&(${pv}.title=${ids.titleFn}(${lv}??__rl))`;
                return replaceLiteral(content, full, replacement);
            },
        },
        {
            id: 'host-title-message-handlers',
            file: extensionPath,
            required: false,
            marker: 'case"codex-route-local-thread-title":',
            // Inserted before an existing case instead of replacing a span of
            // cases: Codex reshuffles the message switch on every release, and
            // a replace would silently drop whatever it renamed in between.
            transform(content) {
                const anchor = 'case"inbox-item-set-read-state":';
                const idx = content.indexOf(anchor);
                if (idx === -1) return null;
                return content.substring(0, idx)
                    + applyTemplate(TITLE_PATCH_TEMPLATE, ids)
                    + content.substring(idx);
            },
            verify(content) {
                return content.includes('case"codex-route-local-thread-title":')
                    && content.includes('"blossom-black.svg"');
            },
        },
    ], report);
}

function patchFetchNoise(extensionPath, report) {
    return applyPatchGroup([
        {
            id: 'fetch-connector-logo-transparent-png',
            file: extensionPath,
            required: false,
            marker: '/^\\/aip\\/connectors\\/[^/]+\\/logo\\?/.test(',
            transform(content) {
                const anchorRe = /let (\w+)=new AbortController;if\(this\.(\w+)\((\w+)\.requestId[^)]*\),/;
                const m = anchorRe.exec(content);
                if (!m) return null;
                const [anchor, , setMethod, reqVar] = m;
                const insertAfter = m.index + anchor.length;
                const deleteMethod = setMethod.replace('set', 'delete');
                const logoBlock = `/^\\/aip\\/connectors\\/[^/]+\\/logo\\?/.test(${reqVar}.url)){this.${deleteMethod}(${reqVar}.requestId);return{type:"fetch-response",responseType:"success",requestId:${reqVar}.requestId,status:200,headers:{"content-type":"image/png"},bodyJsonString:JSON.stringify({base64:"${TRANSPARENT_PNG_BASE64}",contentType:"image/png"})}}if(`;
                const nextIf = content.indexOf(reqVar + '.url.startsWith(', insertAfter);
                if (nextIf === -1) return null;
                return content.substring(0, insertAfter) + logoBlock + content.substring(nextIf);
            },
        },
    ], report);
}

// --- Main ---

function patchCodex(codexDirOverride) {
    const codexDir = codexDirOverride || targets.findCodexExtDir();
    const report = { patched: false, skipped: [], codexVersion: null };
    if (!codexDir) return report;
    report.codexVersion = targets.readCodexVersion(codexDir);

    const assetsDir = path.join(codexDir, 'webview', 'assets');
    const extensionPath = path.join(codexDir, 'out', 'extension.js');

    if (!fs.existsSync(extensionPath)) return report;
    const hostContent = fs.readFileSync(extensionPath, 'utf8');
    const ids = requireDiscovery(discoverHost(hostContent), 'host');

    if (patchRouteHome(assetsDir, report)) report.patched = true;
    if (patchHistoryNavigation(assetsDir, extensionPath, ids, report)) report.patched = true;
    if (patchPanelLifecycle(extensionPath, ids, report)) report.patched = true;
    if (patchTabTitles(assetsDir, extensionPath, ids, report)) report.patched = true;
    if (patchFetchNoise(extensionPath, report)) report.patched = true;

    return report;
}

function activate(context) {
    context.subscriptions.push(
        vscode.commands.registerCommand('codexNewTab.home', openCodexTab),
        vscode.commands.registerCommand('codexNewTab.addToThread', addToThreadKeepExplorer),
    );

    try {
        const { patched, skipped, codexVersion } = patchCodex();
        if (patched) {
            vscode.window.showInformationMessage(
                'Codex tab patches applied. Reload window to apply.',
                'Reload'
            ).then((choice) => {
                if (choice === 'Reload') {
                    vscode.commands.executeCommand('workbench.action.reloadWindow');
                }
            });
        } else {
            // Nothing to write means the install is already patched. Say so in
            // the log — silence here reads as "the extension did nothing".
            console.log(`[codex-new-tab] patches already applied (Codex ${codexVersion || 'unknown'})`);
        }
        if (skipped.length > 0) {
            for (const s of skipped) {
                console.warn(`[codex-new-tab] skipped ${s.id} (${s.file}): ${s.reason}`);
            }
            const version = codexVersion ? ` Codex ${codexVersion}` : '';
            vscode.window.showWarningMessage(
                `Codex tabs: работает частично.${version} не применились: `
                + `${skipped.map((s) => s.id).join(', ')}. Причины — в Developer Tools console.`
            );
        }
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[codex-new-tab] patch failed:', message);
        vscode.window.showErrorMessage(`Codex tab patch failed: ${message}`);
    }
}

function deactivate() {}

module.exports = { activate, deactivate };
