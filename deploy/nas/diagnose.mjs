import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ProxyAgent, request } from 'undici';

// Run explicitly inside the deployment. No model request or credential contents are printed.
const codex = fileURLToPath(new URL('../node_modules/@openai/codex/bin/codex.js', import.meta.url));
const result = { runtime: { node: process.version, platform: process.platform, arch: process.arch, kernel: os.release(), uid: process.getuid?.() }, checks: [] };
const check = (name, ok, detail) => result.checks.push({ name, ok, detail });
const version = spawnSync(process.execPath, [codex, '--version'], { encoding: 'utf8' });
check('codex-version', version.status === 0, version.stdout?.trim().match(/^codex-cli [\w.+-]+$/)?.[0] || 'Unable to read pinned CLI version');
const login = spawnSync(process.execPath, [codex, 'login', 'status'], { stdio: 'ignore' });
check('codex-login', login.status === 0, login.status === 0 ? 'Local login cache is recognized; this is not a remote token-refresh check' : 'Run the worker login command');
for (const name of ['CODEX_HOME', 'CANVAS_AGENT_CONFIG_DIR']) {
    const directory = process.env[name];
    try {
        const stat = fs.statSync(directory || '');
        check(name, stat.isDirectory() && (stat.mode & 0o077) === 0, 'Directory permissions checked without reading credentials');
    } catch { check(name, false, 'Private directory is missing'); }
}
// Match Codex's user/PID/network/IPC namespace flags; its proc fallback keeps Docker's masked paths.
const sandbox = spawnSync('bwrap', ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-user', '--unshare-pid', '--unshare-net', '--unshare-ipc', '--die-with-parent', '--', process.execPath, '-e', 'process.exit(0)'], { stdio: 'ignore' });
check('linux-namespaces', sandbox.status === 0, sandbox.status === 0 ? 'Basic filesystem/network namespaces work; the actual Codex permissions profile still needs verification' : 'Namespace probe failed; do not disable the sandbox or enable privileged mode');
let proxy;
try {
    proxy = new URL(process.env.HTTPS_PROXY || '');
    if (!['http:', 'https:'].includes(proxy.protocol)) throw new Error();
    check('proxy-config', true, 'Explicit HTTP proxy configured; credentials hidden');
} catch { check('proxy-config', false, 'Configure the OpenClash HTTP/mixed endpoint'); }
if (proxy) {
    const dispatcher = new ProxyAgent(proxy.href);
    try {
        for (const endpoint of ['https://chatgpt.com/', 'https://auth.openai.com/']) {
            try {
                const response = await request(endpoint, { method: 'HEAD', dispatcher });
                await response.body.dump();
                check(new URL(endpoint).hostname, true, `Proxy CONNECT and TLS completed (HTTP ${response.statusCode}); this does not prove model/account availability`);
            } catch { check(new URL(endpoint).hostname, false, 'Proxy, DNS, connection, or certificate validation failed; no direct fallback attempted'); }
        }
    } finally { await dispatcher.close(); }
}
check('image-generation', null, 'Unverified until an explicit user generation produces a registered, readable image');
console.log(JSON.stringify(result, null, 2));
if (result.checks.some((item) => item.ok === false)) process.exitCode = 1;
