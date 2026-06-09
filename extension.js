const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CODEX_CUSTOM_EDITOR = 'chatgpt.conversationEditor';
const RESTORE_DELAY_MS = 700;
const PATCH_MARKER = 'path:`/Codex`';

const TRANSPARENT_PNG_BASE64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

const ROUTE_TITLE_DOM_BRIDGE =
    'function T(e){try{let t=()=>{let t=[...document.querySelectorAll(`[data-thread-title],h1,[role=heading]`)].map(e=>({e,r:e.getBoundingClientRect()})).filter(({e:t,r:n})=>n.width>0&&n.height>0&&t.textContent).sort((e,t)=>e.r.top-t.r.top||e.r.left-t.r.left).map(({e})=>e.textContent.replace(/\\s+/g,` `).trim()).find(e=>e&&e!==`Codex`&&e!==`Codex Agent`&&e!==`Untitled`&&e.length<120);t&&P.dispatchMessage(`codex-route-local-thread-title`,{conversationId:e,title:t})};t(),[500,1500,4000,9000,2e4].forEach(e=>setTimeout(t,e)),globalThis.__codexNewTabTitleObserver?.disconnect?.(),globalThis.__codexNewTabTitleObserver=new MutationObserver(t),document.body&&globalThis.__codexNewTabTitleObserver.observe(document.body,{subtree:!0,childList:!0,characterData:!0})}catch{}}';

const HISTORY_PATCH_TEMPLATE =
    'case"navigate-in-new-editor-tab":{let n=r.path,o=/^\\/local\\/([^/]+)/.exec(n);if(o)try{let{summary:e}=await this.conversationSummaryProvider.getConversationSummary(o[1]),r=__TITLE_FN__(e?.preview??__TITLE_DEFAULT__);r=r.replace(/[\\\\/]/g," ").replace(/\\s+/g," ").trim();n=`/local/${o[1]}/${r}`}catch{try{let e=(await this.previewLoader.fetchConversationPreviews()).get(o[1]);e&&(e=__TITLE_FN__(e).replace(/[\\\\/]/g," ").replace(/\\s+/g," ").trim(),n=`/local/${o[1]}/${e}`)}catch{}}__NS__.commands.executeCommand("vscode.open",__URI_FN__(n));break}case"navigate-in-current-editor-tab":{let n=r.path,o=this.findPanelByWebview(e),i=/^\\/local\\/([^/]+)/.exec(n)?.[1],s=null,a=null;if(i)try{let{summary:e}=await this.conversationSummaryProvider.getConversationSummary(i);s=e?.preview??null,a=e?.modelProvider??null}catch(e){this.logger.error("Error fetching conversation summary",{safe:{error:e},sensitive:{}})}if(i&&s==null)try{s=(await this.previewLoader.fetchConversationPreviews()).get(i)??null}catch{}if(o&&i){o.iconPath={light:__NS__.Uri.joinPath(this.extensionUri,"resources","blossom-black.svg"),dark:__NS__.Uri.joinPath(this.extensionUri,"resources","blossom-white.svg")};let e=s!=null?__TITLE_FN__(s):null,l=(e??__TITLE_DEFAULT__).replace(/[\\\\/]/g," ").replace(/\\s+/g," ").trim(),c=__URI_FN__(`/local/${i}/${l}`);e!=null&&(o.title=e);this.chatSessionItemProvider?.registerPendingConversation({conversationId:i,resource:c,label:s??void 0,modelProvider:a},{markInProgress:!1,onlyIfMissing:!0});this.sendMessageToPanel(o,{type:"navigate-to-route",path:n,state:r.state})}else if(o){s!=null&&(o.title=__TITLE_FN__(s));this.sendMessageToPanel(o,{type:"navigate-to-route",path:n,state:r.state})}else __NS__.commands.executeCommand("vscode.open",__URI_FN__(n));break}';

const TITLE_PATCH_TEMPLATE =
    'case"codex-route-local-thread":{let n=r.conversationId,o=this.findPanelByWebview(e);if(o&&typeof n=="string"){o.iconPath={light:__NS__.Uri.joinPath(this.extensionUri,"resources","blossom-black.svg"),dark:__NS__.Uri.joinPath(this.extensionUri,"resources","blossom-white.svg")};let i=async()=>{let e=null,s=null;try{let{summary:r}=await this.conversationSummaryProvider.getConversationSummary(n);e=r?.preview??null,s=r?.modelProvider??null}catch{}if(e==null)try{e=(await this.previewLoader.fetchConversationPreviews()).get(n)??null}catch{}if(e!=null){let a=__TITLE_FN__(e),l=a.replace(/[\\\\/]/g," ").replace(/\\s+/g," ").trim();this.isPanelAlive(o)&&(o.title=a,this.chatSessionItemProvider?.registerPendingConversation({conversationId:n,resource:__URI_FN__(`/local/${n}/${l}`),label:e,modelProvider:s},{markInProgress:!1,onlyIfMissing:!0}))}};i(),[1500,5000,12000,30000].forEach(e=>setTimeout(i,e))}break}case"codex-route-local-thread-title":{let n=r.conversationId,o=r.title,i=this.findPanelByWebview(e);if(i&&typeof n=="string"&&typeof o=="string"){let s=__TITLE_FN__(o);if(s!==__TITLE_DEFAULT__){let a=s.replace(/[\\\\/]/g," ").replace(/\\s+/g," ").trim();i.iconPath={light:__NS__.Uri.joinPath(this.extensionUri,"resources","blossom-black.svg"),dark:__NS__.Uri.joinPath(this.extensionUri,"resources","blossom-white.svg")},i.title=s,this.chatSessionItemProvider?.registerPendingConversation({conversationId:n,resource:__URI_FN__(`/local/${n}/${a}`),label:o,modelProvider:null},{markInProgress:!1,onlyIfMissing:!0})}}break}case"local-thread-activity-changed":break;';

function applyTemplate(template, ids) {
    return template
        .replaceAll('__NS__', ids.ns)
        .replaceAll('__TITLE_FN__', ids.titleFn)
        .replaceAll('__TITLE_DEFAULT__', ids.titleDefault)
        .replaceAll('__URI_FN__', ids.uriFn);
}

function makeIconPath(ns) {
    return `{light:${ns}.Uri.joinPath(this.extensionUri,"resources","blossom-black.svg"),dark:${ns}.Uri.joinPath(this.extensionUri,"resources","blossom-white.svg")}`;
}

// --- Discovery ---

function discoverHost(content) {
    const ID = String.raw`[$A-Z_a-z][$\w]*`;
    const m = (re) => { const r = content.match(new RegExp(re)); return r ? r[1] : null; };
    return {
        ns:           m(`(${ID})\\.window\\.createWebviewPanel`),
        titleFn:      m(`function (${ID})\\([^)]*\\)\\{return [^}]*\\.substring\\(0,`),
        titleDefault: m(`title\\?\\?(${ID}),\\{viewColumn:`),
        uriFn:        m(`function (${ID})\\([^)]*\\)\\{return ${ID}\\.Uri\\.file`),
        parserFn:     m(`function (${ID})\\([^)]*\\)\\{let\\{scheme:[^,]+,authority:[^,]+,path:`),
        schemeConst:  m(`(${ID})="openai-codex"`),
        authConst:    m(`(${ID})="route"`),
    };
}

function discoverDispatcher(navigateContent) {
    const aliasMatch = navigateContent.match(/([\w$]+)\.dispatchMessage/);
    if (!aliasMatch) return null;
    const alias = aliasMatch[1];
    const importRe = new RegExp(String.raw`import\{[^}]*([\w$]+) as ${alias}[^}]*\}from"\.\/([\w.$-]+\.js)"`);
    const importMatch = navigateContent.match(importRe);
    if (!importMatch) return null;
    return { exportName: importMatch[1], module: importMatch[2] };
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

function applyPatchSpec(spec) {
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

    if (!file || !fs.existsSync(file)) {
        if (required) throw patchFailed(id, file, 'file not found');
        return false;
    }

    const content = fs.readFileSync(file, 'utf8');
    if (verify && verify(content)) return false;

    let result = content;
    if (transform) {
        result = transform(content);
        if (result === null) {
            if (required) throw patchFailed(id, file, 'old text not found');
            return false;
        }
    } else {
        const variants = Array.isArray(old) ? old : [old];
        const found = variants.find((candidate) => candidate && content.includes(candidate));
        if (!found) {
            if (required) throw patchFailed(id, file, 'old text not found');
            return false;
        }
        result = content.replace(found, nextText);
    }

    if (!result || result === content) {
        if (required) throw patchFailed(id, file, 'no change produced');
        return false;
    }
    if (verify && !verify(result)) {
        throw patchFailed(id, file, 'verification failed after patch');
    }

    backupFile(file);
    fs.writeFileSync(file, result, 'utf8');
    return true;
}

function applyPatchGroup(patches) {
    let changed = false;
    for (const patch of patches) {
        if (applyPatchSpec(patch)) changed = true;
    }
    return changed;
}

// --- Patches ---

function patchRouteHome(assetsDir) {
    const routeFile = findFileByPrefix(assetsDir, 'route-scope-', '.js');
    const appMainFile = findFileByPrefix(assetsDir, 'app-main-', '.js');
    const routePath = routeFile ? path.join(assetsDir, routeFile) : null;
    const appMainPath = appMainFile ? path.join(assetsDir, appMainFile) : null;

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
                return content.replace(m[0], `${v}===\`/\`||${v}===\`/Codex\`||`);
            },
        },
        {
            id: 'route-home-react-copy',
            file: appMainPath,
            marker: PATCH_MARKER,
            transform(content) {
                if (content.includes(PATCH_MARKER)) return content;
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
                const copy = original.replace('path:`/`', 'path:`/Codex`');
                return content.substring(0, routeEnd) + ',' + copy + content.substring(routeEnd);
            },
        },
    ]);
}

function patchHistoryNavigation(assetsDir, extensionPath, ids) {
    const navigateFile = findFileByPrefix(
        assetsDir,
        'use-navigate-to-local-conversation-',
        '.js'
    );
    const navigatePath = navigateFile ? path.join(assetsDir, navigateFile) : null;

    return applyPatchGroup([
        {
            id: 'history-click-current-panel',
            file: navigatePath,
            marker: 'navigate-in-current-editor-tab',
            transform(content) {
                if (content.includes('navigate-in-current-editor-tab')) return null;
                if (!content.includes('navigate-in-new-editor-tab')) return null;
                return content.replace(
                    'navigate-in-new-editor-tab',
                    'navigate-in-current-editor-tab'
                );
            },
        },
        {
            id: 'history-host-current-panel',
            file: extensionPath,
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
    ]);
}

function patchPanelLifecycle(extensionPath, ids) {
    const initParams = parseParams(
        fs.readFileSync(extensionPath, 'utf8'),
        'async initializeWebview'
    );
    const webviewParam = initParams ? initParams[0] : 'e';
    const modeParam = initParams ? initParams[1] : 'r';

    const resolveParams = parseParams(
        fs.readFileSync(extensionPath, 'utf8'),
        'async resolveCustomEditor'
    );
    const panelParam = resolveParams ? resolveParams[1] : 'r';

    const editorPanelSetRe = /return this\.editorPanels\.set\((\w+)/;

    return applyPatchGroup([
        {
            id: 'panel-codex-home-ipc-skip',
            file: extensionPath,
            marker: 'm0==="/Codex"',
            transform(content) {
                const anchor = `async initializeWebview(${initParams ? initParams.join(',') : 'e,r,n,o'}){`;
                const idx = content.indexOf(anchor);
                if (idx === -1) return null;
                const target = `this.registerIpcClientForWebview(${webviewParam})`;
                const tIdx = content.indexOf(target, idx);
                if (tIdx === -1 || tIdx > idx + 200) return null;
                const conditional = `let p0=this.findPanelByWebview(${webviewParam}),m0=p0?this.editorPanels.get(p0)?.initialRoute:null;(${modeParam}==="panel"&&m0==="/Codex")||this.registerIpcClientForWebview(${webviewParam})`;
                return content.substring(0, tIdx) + conditional + content.substring(tIdx + target.length);
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
                return content.replace(m[0], m[1] + ',' + m[2]);
            },
        },
    ]);
}

function patchTabTitles(assetsDir, extensionPath, ids) {
    const routeFile = findFileByPrefix(assetsDir, 'route-scope-', '.js');
    const routePath = routeFile ? path.join(assetsDir, routeFile) : null;

    const navigateFile = findFileByPrefix(assetsDir, 'use-navigate-to-local-conversation-', '.js');
    const navigatePath = navigateFile ? path.join(assetsDir, navigateFile) : null;
    let dispatcherInfo = null;
    if (navigatePath) {
        try {
            dispatcherInfo = discoverDispatcher(fs.readFileSync(navigatePath, 'utf8'));
        } catch (_) {}
    }

    return applyPatchGroup([
        {
            id: 'route-title-import-dispatcher',
            file: routePath,
            marker: null,
            verify(content) {
                return content.includes(' as P}from"./');
            },
            transform(content) {
                if (!dispatcherInfo) return null;
                const { exportName, module: mod } = dispatcherInfo;
                if (content.includes(` as P}from"./${mod}"`)) return null;
                const escaped = mod.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const importRe = new RegExp(String.raw`import\{([^}]+)\}from"\.\/` + escaped + '"');
                const m = importRe.exec(content);
                if (m) {
                    const patched = m[0].replace('}from"', `,${exportName} as P}from"`);
                    return content.replace(m[0], patched);
                }
                const firstImport = content.indexOf('import');
                if (firstImport === -1) return null;
                return content.substring(0, firstImport) +
                    `import{${exportName} as P}from"./${mod}";` +
                    content.substring(firstImport);
            },
        },
        {
            id: 'route-title-dom-bridge',
            file: routePath,
            marker: ROUTE_TITLE_DOM_BRIDGE,
            transform(content) {
                const re = /var [\w$]+=[\w$]+\(`RouteScope`,\{key:[\w$]+=>`\$\{[\w$]+\.pathname\}\$\{[\w$]+\.search\?\?``\}`,parent:[\w$]+,retain:\{max:20\}\}\);/;
                const m = re.exec(content);
                if (!m) return null;
                return content.substring(0, m.index) + ROUTE_TITLE_DOM_BRIDGE + content.substring(m.index);
            },
        },
        {
            id: 'route-title-dispatch-on-local-thread',
            file: routePath,
            marker: 'codex-route-local-thread',
            transform(content) {
                const blockRe = /if\((\w+)!=null\)\{let (\w+)=new URLSearchParams\((\w+)\),(\w+)=\2\.get\(`projectId`\),(\w+)=\2\.get\(`hostId`\);return\{conversationId:(\w+)\(\1\),pathname:(\w+),projectContext:\4==null\?null:\{hostId:\5,projectId:\4\},routeKind:`local-thread`,routeTemplate:(\w+),search:\3\}\}/;
                const m = blockRe.exec(content);
                if (!m) return null;
                const [full, rawId, , searchVar, , , convFn, pathVar, tmplVar] = m;
                const replacement =
                    `if(${rawId}!=null){let __cv=${convFn}(${rawId});try{globalThis.__codexNewTabRouteConversationId!==__cv&&(globalThis.__codexNewTabRouteConversationId=__cv,P.dispatchMessage(\`codex-route-local-thread\`,{conversationId:__cv})),T(__cv)}catch{}let __sp=new URLSearchParams(${searchVar}),__pj=__sp.get(\`projectId\`),__hi=__sp.get(\`hostId\`);return{conversationId:__cv,pathname:${pathVar},projectContext:__pj==null?null:{hostId:__hi,projectId:__pj},routeKind:\`local-thread\`,routeTemplate:${tmplVar},search:${searchVar}}}`;
                return content.replace(full, replacement);
            },
        },
        {
            id: 'host-title-route-label-parser',
            file: extensionPath,
            marker: 'routeLabel',
            transform(content) {
                const startAnchor = `function ${ids.parserFn}(`;
                const endAnchor = `function ${ids.uriFn}(`;
                const startIdx = content.indexOf(startAnchor);
                if (startIdx === -1) return null;
                const paramMatch = content.slice(startIdx).match(/function \w+\((\w+)\)/);
                const p = paramMatch ? paramMatch[1] : 't';
                const replacement = `function ${ids.parserFn}(${p}){let{scheme:e,authority:r,path:n}=${p};if(e!==${ids.schemeConst})return null;if(r!==${ids.authConst})return null;let i=(n.startsWith("/")?n.slice(1):n).split("/"),s=null,a=null;if(i.length>=2&&(i[0]==="local"||i[0]==="remote")&&(s=i[1]),i.length>=3)try{a=decodeURIComponent(i.slice(2).join("/"))}catch{}return{path:${p}.fsPath,conversationId:s,routeLabel:a}}`;
                return replaceBetween(content, startAnchor, endAnchor, replacement);
            },
        },
        {
            id: 'host-title-route-label-init',
            file: extensionPath,
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
                return content.replace(full, replacement);
            },
        },
        {
            id: 'host-title-message-handlers',
            file: extensionPath,
            marker: 'case"codex-route-local-thread-title":',
            transform(content) {
                return replaceBetween(content,
                    'case"inbox-item-set-read-state":',
                    'case"subagent-thread-opened":',
                    `case"inbox-item-set-read-state":case"inbox-items-create":break;case"open-mcp-app-sandbox-devtools":break;${applyTemplate(TITLE_PATCH_TEMPLATE, ids)}`);
            },
            verify(content) {
                return content.includes('case"codex-route-local-thread-title":')
                    && content.includes('"blossom-black.svg"');
            },
        },
    ]);
}

function patchFetchNoise(extensionPath) {
    return applyPatchGroup([
        {
            id: 'fetch-connector-logo-transparent-png',
            file: extensionPath,
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
    ]);
}

// --- Main ---

function patchCodex() {
    const codexDir = findCodexExtDir();
    if (!codexDir) return false;

    const assetsDir = path.join(codexDir, 'webview', 'assets');
    const extensionPath = path.join(codexDir, 'out', 'extension.js');

    if (!fs.existsSync(extensionPath)) return false;
    const hostContent = fs.readFileSync(extensionPath, 'utf8');
    const ids = requireDiscovery(discoverHost(hostContent), 'host');

    let patched = false;
    if (patchRouteHome(assetsDir)) patched = true;
    if (patchHistoryNavigation(assetsDir, extensionPath, ids)) patched = true;
    if (patchPanelLifecycle(extensionPath, ids)) patched = true;
    if (patchTabTitles(assetsDir, extensionPath, ids)) patched = true;
    if (patchFetchNoise(extensionPath)) patched = true;

    return patched;
}

function activate(context) {
    context.subscriptions.push(
        vscode.commands.registerCommand('codexNewTab.home', openCodexTab),
        vscode.commands.registerCommand('codexNewTab.addToThread', addToThreadKeepExplorer),
    );

    try {
        const patched = patchCodex();
        if (patched) {
            vscode.window.showInformationMessage(
                'Codex tab patches applied. Reload window to apply.',
                'Reload'
            ).then((choice) => {
                if (choice === 'Reload') {
                    vscode.commands.executeCommand('workbench.action.reloadWindow');
                }
            });
        }
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[codex-new-tab] patch failed:', message);
        vscode.window.showErrorMessage(`Codex tab patch failed: ${message}`);
    }
}

function deactivate() {}

module.exports = { activate, deactivate };
