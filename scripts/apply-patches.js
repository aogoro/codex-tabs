#!/usr/bin/env node

// Applies the patches to the real Codex installation, outside Cursor. Same code
// path as activation (`patchCodex` from ../extension.js), so what this writes is
// what the extension would write.
//
// Two uses: patch a freshly installed Codex before starting Cursor, so the
// window comes up already patched instead of patching and then asking for a
// reload; and repair an installation by hand. Run verify-clean-apply.js first —
// it is the dry run, this one writes. Backups (`.bak`) are created as usual.

const fs = require('fs');
const path = require('path');
const os = require('os');

const { spawnSync } = require('child_process');

const targets = require('../lib/targets');

const codexDir = targets.findCodexExtDir();
if (!codexDir) {
    console.error('OpenAI Codex extension not found.');
    process.exit(2);
}

// extension.js requires `vscode`, which exists only inside the editor; strip it
// the same way verify-clean-apply.js does and run the result as a throwaway
// module. Patch definitions stay in one place that way.
const wrapperPath = path.resolve(__dirname, '..', 'extension.js');
const libPath = path.resolve(__dirname, '..', 'lib', 'targets.js');
const wrapperSrc = fs.readFileSync(wrapperPath, 'utf8')
    .replace("const vscode = require('vscode');", 'const vscode = null;')
    .replace("require('./lib/targets')", `require(${JSON.stringify(libPath)})`);

const runnerPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'codex-apply-')),
    '_runner.js'
);
fs.writeFileSync(runnerPath, wrapperSrc + `
try {
    const report = patchCodex(${JSON.stringify(codexDir)});
    console.log(JSON.stringify({
        codexVersion: report.codexVersion,
        patched: report.patched,
        skipped: report.skipped.map((s) => ({ id: s.id, file: s.file, reason: s.reason })),
    }, null, 2));
} catch (e) {
    console.error('PATCH_FAILED:', e.message);
    process.exit(1);
}
`, 'utf8');

const result = spawnSync('node', [runnerPath], { encoding: 'utf8', timeout: 60000 });
fs.rmSync(path.dirname(runnerPath), { recursive: true, force: true });

if (result.stderr) process.stderr.write(result.stderr);
if (result.stdout) process.stdout.write(result.stdout);
if (result.status !== 0) process.exit(result.status === null ? 1 : result.status);

// A skipped patch means a degraded feature, not a broken install — report it
// through the exit code so a caller notices, after writing what did apply.
try {
    const report = JSON.parse(result.stdout);
    if (report.skipped.length > 0) process.exitCode = 1;
} catch (_) {
    process.exitCode = 1;
}
