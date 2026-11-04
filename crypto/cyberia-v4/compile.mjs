import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

export function permit2Artifact() {
    const solc = require('solc-0-8-17');
    const base = 'node_modules/@uniswap/v4-periphery/lib/permit2/';
    const input = { language: 'Solidity', sources: { 'src/Permit2.sol': { content: readFileSync(base + 'src/Permit2.sol', 'utf8') } }, settings: { optimizer: { enabled: true, runs: 1000000 }, viaIR: true, metadata: { bytecodeHash: 'none' }, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } };
    const result = JSON.parse(solc.compile(JSON.stringify(input), { import: (path) => {
        const target = path.startsWith('solmate/') ? base + 'lib/' + path : base + path;
        try { return { contents: readFileSync(target, 'utf8') }; } catch { return { error: `Missing import ${path}` }; }
    }}));
    const errors = (result.errors ?? []).filter((e) => e.severity === 'error');
    if (errors.length) throw new Error(errors.map((e) => e.formattedMessage).join('\n'));
    const out = result.contracts['src/Permit2.sol'].Permit2;
    return { abi: out.abi, bytecode: '0x' + out.evm.bytecode.object };
}

export function wrappedCyberArtifact() {
    const solc = require('solc');
    const input = { language: 'Solidity', sources: { 'WCYBER.sol': { content: readFileSync('WCYBER.sol', 'utf8') } }, settings: { evmVersion: 'cancun', optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } };
    const result = JSON.parse(solc.compile(JSON.stringify(input)));
    const errors = (result.errors ?? []).filter((e) => e.severity === 'error');
    if (errors.length) throw new Error(errors.map((e) => e.formattedMessage).join('\n'));
    const out = result.contracts['WCYBER.sol'].WCYBER;
    return { abi: out.abi, bytecode: '0x' + out.evm.bytecode.object };
}
