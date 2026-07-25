#!/usr/bin/env node

// Restores every .bak next to a patched Codex file, undoing all patches.
// Use it to roll back to a stock Codex, or between patch iterations: restore,
// then let the extension (or the runner) apply the updated patches to clean
// files. The .bak files are kept, so this can be run repeatedly.

const fs = require('fs');
const path = require('path');

const targets = require('../lib/targets');

const codexDir = targets.findCodexExtDir();
if (!codexDir) {
    console.error('OpenAI Codex extension not found.');
    process.exit(2);
}

const candidates = [path.join(codexDir, 'out')];
const assetsDir = path.join(codexDir, 'webview', 'assets');
if (fs.existsSync(assetsDir)) candidates.push(assetsDir);

const restored = [];
for (const dir of candidates) {
    for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith('.bak')) continue;
        const bak = path.join(dir, name);
        const target = bak.slice(0, -'.bak'.length);
        fs.copyFileSync(bak, target);
        restored.push(path.relative(codexDir, target));
    }
}

console.log(JSON.stringify({
    codexDir,
    codexVersion: targets.readCodexVersion(codexDir),
    restored,
}, null, 2));

if (restored.length === 0) {
    console.error('No .bak files found — nothing to restore.');
    process.exitCode = 1;
}
