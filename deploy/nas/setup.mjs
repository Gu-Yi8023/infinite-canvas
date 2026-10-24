import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { hashSync } from 'bcryptjs';

process.umask(0o077);
const origin = new URL(process.env.CANVAS_PUBLIC_ORIGIN || '');
if (origin.protocol !== 'https:' || origin.origin !== process.env.CANVAS_PUBLIC_ORIGIN) throw new Error('CANVAS_PUBLIC_ORIGIN must be an HTTPS origin');
const secrets = '/setup/secrets';
const write = (name, value) => { const file = path.join(secrets, name); if (!fs.existsSync(file)) fs.writeFileSync(file, value, { mode: 0o600, flag: 'wx' }); };
for (const dir of [secrets, '/var/lib/gateway', '/var/lib/canvas-agent', '/var/lib/codex', '/workspace']) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chownSync(dir, 1000, 1000);
    fs.chmodSync(dir, 0o700);
}
const originFile = path.join(secrets, 'origin.txt');
if (fs.existsSync(originFile) && fs.readFileSync(originFile, 'utf8') !== origin.origin) throw new Error('Origin changed; preserve existing secrets and configure a matching TLS certificate before changing deployment');
write('origin.txt', origin.origin);
if (!fs.existsSync(path.join(secrets, 'password.hash'))) {
    const initial = path.join(secrets, 'initial-password.txt');
    const password = fs.existsSync(initial) ? fs.readFileSync(initial, 'utf8').trim() : crypto.randomBytes(24).toString('base64url');
    if (!password) throw new Error('Initial password file is empty; existing files were preserved');
    write('initial-password.txt', password);
    write('password.hash', hashSync(password));
}
write('session.key', crypto.randomBytes(32).toString('hex'));
write('bridge.token', crypto.randomBytes(32).toString('hex'));
write('audio.key', '');
write('outbound-proxy.txt', '');
const cert = path.join(secrets, 'tls.crt');
const key = path.join(secrets, 'tls.key');
if (fs.existsSync(cert) !== fs.existsSync(key)) throw new Error('Incomplete TLS key/certificate pair; existing files were preserved');
for (const name of fs.readdirSync(secrets)) {
    const file = path.join(secrets, name);
    if (!fs.lstatSync(file).isFile()) throw new Error('Secrets must be regular files, not directories or symbolic links');
    fs.chownSync(file, 1000, 1000);
    fs.chmodSync(file, 0o600);
}
console.log('Prepared private volumes and secrets. Read initial-password.txt locally and fill outbound-proxy.txt. Before starting the gateway, supply a trusted TLS certificate as tls.crt and its key as tls.key for the configured origin, then run setup again to apply private permissions. Existing secrets were preserved; secret values were not printed.');
