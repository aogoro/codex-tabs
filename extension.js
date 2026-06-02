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

const CURRENT_HISTORY_NAVIGATION_PATCH =
    'case"navigate-in-new-editor-tab":{let n=r.path,o=/^\\/local\\/([^/]+)/.exec(n);if(o)try{let{summary:e}=await this.conversationSummaryProvider.getConversationSummary(o[1]),r=nfe(e?.preview??sfe);r=r.replace(/[\\\\/]/g," ").replace(/\\s+/g," ").trim();n=`/local/${o[1]}/${r}`}catch{try{let e=(await this.previewLoader.fetchConversationPreviews()).get(o[1]);e&&(e=nfe(e).replace(/[\\\\/]/g," ").replace(/\\s+/g," ").trim(),n=`/local/${o[1]}/${e}`)}catch{}}Fe.commands.executeCommand("vscode.open",rC(n));break}case"navigate-in-current-editor-tab":{let n=r.path,o=this.findPanelByWebview(e),i=/^\\/local\\/([^/]+)/.exec(n)?.[1],s=null,a=null;if(i)try{let{summary:e}=await this.conversationSummaryProvider.getConversationSummary(i);s=e?.preview??null,a=e?.modelProvider??null}catch(e){this.logger.error("Error fetching conversation summary",{safe:{error:e},sensitive:{}})}if(i&&s==null)try{s=(await this.previewLoader.fetchConversationPreviews()).get(i)??null}catch{}if(o&&i){o.iconPath={light:Fe.Uri.joinPath(this.extensionUri,"resources","blossom-black.svg"),dark:Fe.Uri.joinPath(this.extensionUri,"resources","blossom-white.svg")};let e=s!=null?nfe(s):null,l=(e??sfe).replace(/[\\\\/]/g," ").replace(/\\s+/g," ").trim(),c=rC(`/local/${i}/${l}`);e!=null&&(o.title=e);this.chatSessionItemProvider?.registerPendingConversation({conversationId:i,resource:c,label:s??void 0,modelProvider:a},{markInProgress:!1,onlyIfMissing:!0});this.sendMessageToPanel(o,{type:"navigate-to-route",path:n,state:r.state})}else if(o){s!=null&&(o.title=nfe(s));this.sendMessageToPanel(o,{type:"navigate-to-route",path:n,state:r.state})}else Fe.commands.executeCommand("vscode.open",rC(n));break}';

const TITLE_HOST_HANDLER_PATCH =
    `case"codex-route-local-thread":{let n=r.conversationId,o=this.findPanelByWebview(e);if(o&&typeof n=="string"){o.iconPath={light:Fe.Uri.joinPath(this.extensionUri,"resources","blossom-black.svg"),dark:Fe.Uri.joinPath(this.extensionUri,"resources","blossom-white.svg")};let i=async()=>{let e=null,s=null;try{let{summary:r}=await this.conversationSummaryProvider.getConversationSummary(n);e=r?.preview??null,s=r?.modelProvider??null}catch{}if(e==null)try{e=(await this.previewLoader.fetchConversationPreviews()).get(n)??null}catch{}if(e!=null){let a=nfe(e),l=a.replace(/[\\\\/]/g," ").replace(/\\s+/g," ").trim();this.isPanelAlive(o)&&(o.title=a,this.chatSessionItemProvider?.registerPendingConversation({conversationId:n,resource:rC(\`/local/\${n}/\${l}\`),label:e,modelProvider:s},{markInProgress:!1,onlyIfMissing:!0}))}};i(),[1500,5000,12000,30000].forEach(e=>setTimeout(i,e))}break}case"codex-route-local-thread-title":{let n=r.conversationId,o=r.title,i=this.findPanelByWebview(e);if(i&&typeof n=="string"&&typeof o=="string"){let s=nfe(o);if(s!==sfe){let a=s.replace(/[\\\\/]/g," ").replace(/\\s+/g," ").trim();i.iconPath={light:Fe.Uri.joinPath(this.extensionUri,"resources","blossom-black.svg"),dark:Fe.Uri.joinPath(this.extensionUri,"resources","blossom-white.svg")},i.title=s,this.chatSessionItemProvider?.registerPendingConversation({conversationId:n,resource:rC(\`/local/\${n}/\${a}\`),label:o,modelProvider:null},{markInProgress:!1,onlyIfMissing:!0})}}break}case"local-thread-activity-changed":break;`;

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
        // Emergency fallback for older Codex builds that do not expose chatgpt.newCodexPanel.
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

function patchRouteHome(assetsDir) {
    const routeFile = findFileByPrefix(assetsDir, 'route-scope-', '.js');
    const appMainFile = findFileByPrefix(assetsDir, 'app-main-', '.js');
    const routePath = routeFile ? path.join(assetsDir, routeFile) : null;
    const appMainPath = appMainFile ? path.join(assetsDir, appMainFile) : null;

    return applyPatchGroup([
        {
            id: 'route-home-kind',
            file: routePath,
            marker: 'o===`/`||o===`/Codex`||o===`/hotkey-window`',
            old: 'o===`/`||o===`/hotkey-window`',
            new: 'o===`/`||o===`/Codex`||o===`/hotkey-window`',
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

function patchHistoryNavigation(assetsDir, extensionPath) {
    const navigateFile = findFileByPrefix(
        assetsDir,
        'use-navigate-to-local-conversation-',
        '.js'
    );
    const navigatePath = navigateFile ? path.join(assetsDir, navigateFile) : null;
    const desiredNavigate =
        'if(s){i.dispatchMessage(`navigate-in-current-editor-tab`,{path:c});return}';

    return applyPatchGroup([
        {
            id: 'history-click-current-panel',
            file: navigatePath,
            marker: desiredNavigate,
            transform(content) {
                const target1 = 'if(s){i.dispatchMessage(`navigate-in-new-editor-tab`,{path:c});return}';
                if (content.includes(target1)) {
                    return content.replace(target1, desiredNavigate);
                }
                const target2 = 'i.dispatchMessage(`navigate-in-new-editor-tab`,{path:c});return}';
                const idx = content.indexOf(target2);
                if (idx === -1) return null;
                const blockStart = content.lastIndexOf('if(s', idx);
                if (blockStart === -1 || idx - blockStart > 200) return null;
                const blockEnd = idx + target2.length;
                return content.substring(0, blockStart) + desiredNavigate + content.substring(blockEnd);
            },
        },
        {
            id: 'history-host-current-panel',
            file: extensionPath,
            marker: 'o.iconPath={light:Fe.Uri.joinPath(this.extensionUri,"resources","blossom-black.svg"),dark:Fe.Uri.joinPath(this.extensionUri,"resources","blossom-white.svg")};let e=s!=null?nfe(s):null',
            transform(content) {
                return replaceBetween(content,
                    'case"navigate-in-new-editor-tab":',
                    'case"open-vscode-command":{',
                    CURRENT_HISTORY_NAVIGATION_PATCH);
            },
            verify(content) {
                const marker = 'o.iconPath={light:Fe.Uri.joinPath(this.extensionUri,"resources","blossom-black.svg"),dark:Fe.Uri.joinPath(this.extensionUri,"resources","blossom-white.svg")};let e=s!=null?nfe(s):null';
                const start = content.indexOf('case"navigate-in-current-editor-tab"');
                const block = start === -1 ? '' : content.slice(start, start + 1600);
                return block.includes(marker)
                    && block.includes('this.sendMessageToPanel(o,{type:"navigate-to-route",path:n,state:r.state})')
                    && !block.includes('vscode.openWith')
                    && !block.includes('o.dispose()');
            },
        },
    ]);
}

function patchPanelLifecycle(extensionPath) {
    // /Codex home panels skip initial IPC registration because multiple home panels
    // previously fought over one app-server IPC client and broke active threads.
    return applyPatchGroup([
        {
            id: 'panel-codex-home-ipc-skip',
            file: extensionPath,
            marker: '(r==="panel"&&m0==="/Codex")||this.registerIpcClientForWebview(e)',
            transform(content) {
                const anchor = 'async initializeWebview(e,r,n,o){';
                const idx = content.indexOf(anchor);
                if (idx === -1) return null;
                const target = 'this.registerIpcClientForWebview(e)';
                const tIdx = content.indexOf(target, idx);
                if (tIdx === -1 || tIdx > idx + 200) return null;
                const conditional = 'let p0=this.findPanelByWebview(e),m0=p0?this.editorPanels.get(p0)?.initialRoute:null;(r==="panel"&&m0==="/Codex")||this.registerIpcClientForWebview(e)';
                return content.substring(0, tIdx) + conditional + content.substring(tIdx + target.length);
            },
        },
        {
            id: 'panel-new-chat-route',
            file: extensionPath,
            marker: 'initialRoute:"/Codex"',
            transform(content) {
                const replacement = 'async createNewPanel(){let e=Fe.window.activeTextEditor?.viewColumn??Fe.ViewColumn.Active;await this.createEditorPanel({title:sfe,initialRoute:"/Codex",viewColumn:e,preserveFocus:!1})}';
                return replaceBetween(content, 'async createNewPanel(){', 'deliverMcpResponseToOrigin(', replacement);
            },
        },
        {
            id: 'panel-create-editor-icon',
            file: extensionPath,
            marker: 'n.iconPath={light:Fe.Uri.joinPath(this.extensionUri,"resources","blossom-black.svg"),dark:Fe.Uri.joinPath(this.extensionUri,"resources","blossom-white.svg")};return this.editorPanels.set(n',
            transform(content) {
                const anchor = 'Fe.window.createWebviewPanel(t.panelViewType,e?.title??sfe,';
                const idx = content.indexOf(anchor);
                if (idx === -1) return null;
                const insertBefore = 'return this.editorPanels.set(n';
                const insertIdx = content.indexOf(insertBefore, idx);
                if (insertIdx === -1) return null;
                const iconPath = 'n.iconPath={light:Fe.Uri.joinPath(this.extensionUri,"resources","blossom-black.svg"),dark:Fe.Uri.joinPath(this.extensionUri,"resources","blossom-white.svg")};';
                return content.substring(0, insertIdx) + iconPath + content.substring(insertIdx);
            },
        },
        {
            id: 'custom-editor-icon-early',
            file: extensionPath,
            marker: 'async resolveCustomEditor(e,r,n){r.iconPath={light:Fe.Uri.joinPath(this.extensionUri,"resources","blossom-black.svg"),dark:Fe.Uri.joinPath(this.extensionUri,"resources","blossom-white.svg")};let o=tC(e.uri);',
            transform(content) {
                const anchor = 'async resolveCustomEditor(e,r,n){';
                const idx = content.indexOf(anchor);
                if (idx === -1) return null;
                const afterBrace = idx + anchor.length;
                const iconAssign = 'r.iconPath={light:Fe.Uri.joinPath(this.extensionUri,"resources","blossom-black.svg"),dark:Fe.Uri.joinPath(this.extensionUri,"resources","blossom-white.svg")};';
                return content.substring(0, afterBrace) + iconAssign + content.substring(afterBrace);
            },
        },
        {
            id: 'custom-editor-icon-dedup',
            file: extensionPath,
            required: false,
            marker: null,
            transform(content) {
                const anchor = 'r.title=nfe(s),r.iconPath={light:Fe.Uri.joinPath(this.extensionUri,';
                const idx = content.indexOf(anchor);
                if (idx === -1) return null;
                const endPattern = '},i!=null&&';
                const endIdx = content.indexOf(endPattern, idx);
                if (endIdx === -1) return null;
                return content.substring(0, idx) + 'r.title=nfe(s),i!=null&&' + content.substring(endIdx + endPattern.length);
            },
            verify(content) {
                return !content.includes('r.title=nfe(s),r.iconPath={light:Fe.Uri.joinPath(this.extensionUri,"resources","blossom-black.svg")');
            },
        },
    ]);
}

function patchTabTitles(assetsDir, extensionPath) {
    const routeFile = findFileByPrefix(assetsDir, 'route-scope-', '.js');
    const routePath = routeFile ? path.join(assetsDir, routeFile) : null;

    return applyPatchGroup([
        {
            id: 'route-title-import-dispatcher',
            file: routePath,
            marker: ',y as P}from"./setting-storage-',
            transform(content) {
                const re = /from"\.\/setting-storage-[^"]+\.js"/;
                const m = re.exec(content);
                if (!m) return null;
                const beforeImport = content.lastIndexOf('import{', m.index);
                if (beforeImport === -1 || m.index - beforeImport > 200) return null;
                const importEnd = content.indexOf('";', m.index);
                if (importEnd === -1) return null;
                const fullEnd = importEnd + 2;
                const original = content.substring(beforeImport, fullEnd);
                if (original.includes(',y as P}')) return null;
                const patched = original.replace('}from"', ',y as P}from"');
                return content.substring(0, beforeImport) + patched + content.substring(fullEnd);
            },
        },
        {
            id: 'route-title-dom-bridge',
            file: routePath,
            marker: ROUTE_TITLE_DOM_BRIDGE,
            old: 'var l=o(`RouteScope`,{key:e=>`${e.pathname}${e.search??``}`,parent:s,retain:{max:20}});',
            new: `${ROUTE_TITLE_DOM_BRIDGE}var l=o(\`RouteScope\`,{key:e=>\`\${e.pathname}\${e.search??\`\`}\`,parent:s,retain:{max:20}});`,
        },
        {
            id: 'route-title-dispatch-on-local-thread',
            file: routePath,
            marker: 'P.dispatchMessage(`codex-route-local-thread`,{conversationId:t})),T(t)',
            transform(content) {
                const blockStart = 'if(u!=null){let e=new URLSearchParams(l),t=e.get(`projectId`),n=e.get(`hostId`);return{conversationId:a(u),pathname:o,projectContext:t==null?null:{hostId:n,projectId:t},routeKind:`local-thread`,routeTemplate:s,search:l}}';
                const idx = content.indexOf(blockStart);
                if (idx === -1) return null;
                const replacement = 'if(u!=null){let t=a(u);try{globalThis.__codexNewTabRouteConversationId!==t&&(globalThis.__codexNewTabRouteConversationId=t,P.dispatchMessage(`codex-route-local-thread`,{conversationId:t})),T(t)}catch{}let e=new URLSearchParams(l),n=e.get(`projectId`),i=e.get(`hostId`);return{conversationId:t,pathname:o,projectContext:n==null?null:{hostId:i,projectId:n},routeKind:`local-thread`,routeTemplate:s,search:l}}';
                return content.replace(blockStart, replacement);
            },
        },
        {
            id: 'host-title-route-label-parser',
            file: extensionPath,
            marker: 'routeLabel',
            transform(content) {
                const replacement = 'function tC(t){let{scheme:e,authority:r,path:n}=t;if(e!==Hp)return null;if(r!==vde)return null;let i=(n.startsWith("/")?n.slice(1):n).split("/"),s=null,a=null;if(i.length>=2&&(i[0]==="local"||i[0]==="remote")&&(s=i[1]),i.length>=3)try{a=decodeURIComponent(i.slice(2).join("/"))}catch{}return{path:t.fsPath,conversationId:s,routeLabel:a}}';
                return replaceBetween(content, 'function tC(t){', 'function rC(t){', replacement);
            },
        },
        {
            id: 'host-title-route-label-init',
            file: extensionPath,
            marker: 'let{conversationId:i,routeLabel:d}=o,s=d,a=null;',
            old: 'let{conversationId:i}=o,s=null,a=null;',
            new: 'let{conversationId:i,routeLabel:d}=o,s=d,a=null;',
        },
        {
            id: 'host-title-route-label-preview-fallback',
            file: extensionPath,
            marker: 'this.isPanelAlive(r)&&(r.title=nfe(l??s))',
            transform(content) {
                const target = 'this.isPanelAlive(r)&&(r.title=nfe(l))';
                const idx = content.indexOf(target);
                if (idx === -1) return null;
                return content.substring(0, idx) + 'this.isPanelAlive(r)&&(r.title=nfe(l??s))' + content.substring(idx + target.length);
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
                    `case"inbox-item-set-read-state":case"inbox-items-create":break;case"open-mcp-app-sandbox-devtools":break;${TITLE_HOST_HANDLER_PATCH}`);
            },
            verify(content) {
                return content.includes('case"codex-route-local-thread-title":')
                    && content.includes('if(e!=null){let a=nfe(e)')
                    && !content.includes('let a=nfe(e??sfe),l=a.replace');
            },
        },
    ]);
}

function patchFetchNoise(extensionPath) {
    return applyPatchGroup([
        {
            id: 'fetch-connector-logo-transparent-png',
            file: extensionPath,
            marker: '/^\\/aip\\/connectors\\/[^/]+\\/logo\\?/.test(e.url)',
            transform(content) {
                const anchor = 'let n=new AbortController;if(this.abortSignals.set(e.requestId,n),';
                const idx = content.indexOf(anchor);
                if (idx === -1) return null;
                const insertAfter = idx + anchor.length;
                const logoBlock = `/^\\/aip\\/connectors\\/[^/]+\\/logo\\?/.test(e.url)){this.abortSignals.delete(e.requestId);return{type:"fetch-response",responseType:"success",requestId:e.requestId,status:200,headers:{"content-type":"image/png"},bodyJsonString:JSON.stringify({base64:"${TRANSPARENT_PNG_BASE64}",contentType:"image/png"})}}if(`;
                const nextIf = content.indexOf('e.url.startsWith(', insertAfter);
                if (nextIf === -1) return null;
                return content.substring(0, insertAfter) + logoBlock + content.substring(nextIf);
            },
        },
    ]);
}

function patchCodex() {
    const codexDir = findCodexExtDir();
    if (!codexDir) return false;

    const assetsDir = path.join(codexDir, 'webview', 'assets');
    const extensionPath = path.join(codexDir, 'out', 'extension.js');
    let patched = false;

    if (patchRouteHome(assetsDir)) patched = true;
    if (patchHistoryNavigation(assetsDir, extensionPath)) patched = true;
    if (patchPanelLifecycle(extensionPath)) patched = true;
    if (patchTabTitles(assetsDir, extensionPath)) patched = true;
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
