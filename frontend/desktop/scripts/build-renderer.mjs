import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const desktop = fileURLToPath(new URL('..', import.meta.url));
const backend = path.resolve(desktop, '../../backend/laravel');
const source = path.resolve(process.env.CYBERIA_WALLET_SOURCE || backend);
const sourceFile = (name) => path.join(source, 'resources', name);
const wallet = readFileSync(sourceFile('js/pages/Wallet.vue'), 'utf8');
if (!wallet.includes('useWalletMode')) {
    throw new Error('This checkout has the retired wallet UI. Set CYBERIA_WALLET_SOURCE to the backend/laravel directory of the current wallet checkout (ux/program).');
}
const sourceGit = (args) => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8' }).trim();
const sourceRevision = sourceGit(['rev-parse', 'HEAD']);
const sourceBranch = sourceGit(['branch', '--show-current']);
const sourceDirty = sourceGit(['status', '--porcelain', '--', 'resources', 'public/token-icons', 'public/favicon.svg', 'public/favicon.ico']).length > 0;

// Build an isolated copy: the selected checkout is never edited, and every @/
// import (including the wallet singleton and generated routes) uses this source.
const stage = path.join(desktop, '.renderer-source');
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
cpSync(path.join(source, 'resources'), path.join(stage, 'resources'), { recursive: true });
// Tailwind skips gitignored folders during automatic discovery. The staging
// directory is deliberately ignored, so its own templates must be explicit.
const stagedCss = path.join(stage, 'resources/css/app.css');
writeFileSync(stagedCss, readFileSync(stagedCss, 'utf8') + '\n@source "../js";\n@source "../desktop";\n');
symlinkSync(path.join(backend, 'node_modules'), path.join(stage, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
cpSync(path.join(backend, 'resources/desktop'), path.join(stage, 'resources/desktop'), { recursive: true });
for (const name of ['desktop.ts', 'components/wallet/DesktopWalletGate.vue']) {
    cpSync(path.join(backend, 'resources/js', name), path.join(stage, 'resources/js', name));
}
// Since the desktop changes reached master the source may carry them already;
// the patch is only for a wallet checkout that predates them.
const patchArgs = ['apply', '--unsafe-paths', '-p3', `--directory=${stage}`, path.join(desktop, 'renderer-desktop.patch')];
const patchCwd = path.resolve(desktop, '../..');
if (spawnSync('git', [...patchArgs.slice(0, 1), '--check', '--reverse', ...patchArgs.slice(1)], { cwd: patchCwd }).status !== 0) {
    execFileSync('git', [patchArgs[0], '--verbose', ...patchArgs.slice(1)], { cwd: patchCwd, stdio: 'inherit' });
}
if (!readFileSync(path.join(stage, 'resources/js/lib/wallet/vault.ts'), 'utf8').includes('The desktop wallet requires a vault password')) {
    throw new Error('The desktop vault protection patch was not applied.');
}
const edit = (name, before, after) => {
    const file = path.join(stage, 'resources/js', name);
    const contents = readFileSync(file, 'utf8');
    if (contents.split(before).length !== 2) throw new Error(`Desktop integration needs updating: ${name}`);
    writeFileSync(file, contents.replace(before, after));
};
// A restored profile must also stay encrypted on disk. The password just
// entered for sync becomes this device's password; no plaintext write occurs.
edit('composables/useMultiWallet.ts', 'vault = installVault(contents);', `vault = import.meta.env.VITE_DESKTOP_WALLET === 'true'
                ? await protectVault(contents, password)
                : installVault(contents);`);
const messagesPath = path.join(stage, 'resources/js/lib/walletMessages.ts');
if (!readFileSync(messagesPath, 'utf8').includes('browserDesktopSite:')) {
    const desktopMessages = readFileSync(path.join(backend, 'resources/js/lib/walletMessages.ts'), 'utf8')
        .match(/^\s*browserDesktopSite:.*$/gm);
    let messageIndex = 0;
    const messages = readFileSync(messagesPath, 'utf8').replace(/^\s*browserOwnSite:/gm, (match) => {
        if (!desktopMessages?.[messageIndex]) throw new Error('Desktop browser locale is missing');
        return `${desktopMessages[messageIndex++]}\n${match}`;
    });
    if (messageIndex !== 3) throw new Error('Unexpected wallet locale count');
    writeFileSync(messagesPath, messages);
}

const hash = (data) => createHash('sha256').update(data).digest('hex');
const inputs = [];
const collect = (directory, prefix = '') => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
        const relative = path.posix.join(prefix, entry.name);
        if (entry.isDirectory()) collect(path.join(directory, entry.name), relative);
        else if (entry.isFile()) inputs.push([relative, hash(readFileSync(path.join(directory, entry.name)))]);
    }
};
collect(path.join(stage, 'resources'));
const vite = path.join(backend, 'node_modules/vite/bin/vite.js');
if (!existsSync(vite)) throw new Error('Install backend/laravel npm dependencies before building the wallet.');
const build = spawnSync(process.execPath, [vite, 'build', '--config', 'vite.desktop.config.ts'], {
    cwd: backend, stdio: 'inherit',
    env: { ...process.env, CYBERIA_DESKTOP_RESOURCES: path.join(stage, 'resources') },
});
if (build.status !== 0) process.exit(build.status || 1);
cpSync(path.join(backend, 'resources/desktop/fonts/OFL.txt'), path.join(desktop, 'wallet-dist/Manrope-OFL.txt'));

// Only public images are copied. Server HTML, service workers and remote scripts are excluded.
for (const name of ['token-icons', 'favicon.svg', 'favicon.ico']) {
    const asset = path.join(source, 'public', name);
    if (existsSync(asset)) cpSync(asset, path.join(desktop, 'wallet-dist', name), { recursive: true });
}
mkdirSync(path.join(desktop, 'wallet-dist'), { recursive: true });
writeFileSync(path.join(desktop, 'wallet-dist/source.json'), JSON.stringify({
    version: JSON.parse(readFileSync(path.join(desktop, 'package.json'), 'utf8')).version,
    renderer: { commit: sourceRevision, branch: sourceBranch, hasUncommittedChanges: sourceDirty },
    resourcesSha256: hash(JSON.stringify(inputs)),
    configurationSha256: hash(readFileSync(path.join(stage, 'resources/desktop/bootstrap.json'))),
    desktopPatchSha256: hash(readFileSync(path.join(desktop, 'renderer-desktop.patch'))),
}, null, 2) + '\n');
console.log(`Bundled wallet source: ${sourceBranch} ${sourceRevision}`);
