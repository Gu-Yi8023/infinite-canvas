import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import dns from "node:dns/promises";
import { syncBuiltinESMExports } from "node:module";
import { NasProviderSettings } from "./provider-settings.js";

const input = { endpoint: "https://93.184.216.34/v1/audio/speech", model: "tts", apiKey: "test-private-key", useProxy: false };
async function directory(t: { after: (fn: () => unknown) => void }) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-providers-test-"));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    return dir;
}

test("settings persist, retain omitted keys, redact credentials and use restrictive permissions", async (t) => {
    const dir = await directory(t);
    const store = await NasProviderSettings.open(dir, { proxy: "http://user:secret@proxy.example:7890" });
    assert.equal(store.snapshot().audio.configured, false);
    await store.update("audio", input);
    const reopened = await NasProviderSettings.open(dir);
    const { apiKey: _key, ...withoutKey } = input;
    const view = await reopened.update("audio", { ...withoutKey, model: "new-tts" });
    assert.equal(reopened.getProvider("audio")?.key, input.apiKey);
    assert.equal(reopened.getProvider("audio")?.model, "new-tts");
    assert.equal(view.audio.hasKey, true);
    assert.doesNotMatch(JSON.stringify(view), /test-private-key|user:secret/);
    if (process.platform !== "win32") {
        assert.equal((await fs.stat(dir)).mode & 0o777, 0o700);
        assert.equal((await fs.stat(path.join(dir, "provider-config.json"))).mode & 0o777, 0o600);
    }
});

test("different concurrent provider updates survive serialization and failed writes do not block later updates", async (t) => {
    const dir = await directory(t); const store = await NasProviderSettings.open(dir);
    await assert.rejects(store.update("audio", { ...input, apiKey: undefined }), /首次/);
    await Promise.all([store.update("audio", input), store.update("video", { ...input, endpoint: "https://93.184.216.34/v1/videos", model: "video" })]);
    const reopened = await NasProviderSettings.open(dir);
    assert.equal(reopened.getProvider("audio")?.model, "tts");
    assert.equal(reopened.getProvider("video")?.model, "video");
    await assert.rejects(store.update("audio", { ...input, apiKey: "" }), /参数无效/);
});

test("unknown versions and damaged files are preserved both at open and after external changes", async (t) => {
    const dir = await directory(t); const file = path.join(dir, "provider-config.json");
    const store = await NasProviderSettings.open(dir);
    for (const invalid of ["{broken", '{"version":2}', '{"version":1,"video":{"key":"private"}}']) {
        await fs.writeFile(file, invalid);
        await assert.rejects(NasProviderSettings.open(dir), /文件格式无效/);
        await assert.rejects(store.update("audio", input), /文件格式无效/);
        assert.equal(await fs.readFile(file, "utf8"), invalid);
    }
});

test("settings reject SSRF destinations and require an available proxy when requested", async (t) => {
    const store = await NasProviderSettings.open(await directory(t));
    for (const endpoint of ["http://93.184.216.34/speech", "https://127.0.0.1/speech", "https://192.168.1.1/speech", "https://[::1]/speech", "https://user:key@93.184.216.34/speech", "https://93.184.216.34/speech?key=private", "https://93.184.216.34/speech#fragment"]) {
        await assert.rejects(store.update("audio", { ...input, endpoint }), /公网 HTTPS/);
    }
    await assert.rejects(store.update("audio", { ...input, useProxy: true }), /不会自动直连/);
    assert.equal(store.getProvider("audio"), undefined);
    await store.update("audio", input);
    assert.equal(store.getProvider("audio")?.proxy, undefined);
});

test("startup audio is a fallback and saved settings take precedence immediately", async (t) => {
    const dir = await directory(t);
    const initial = { endpoint: input.endpoint, model: "initial", key: "initial-key", proxy: "http://proxy.example:7890" };
    const store = await NasProviderSettings.open(dir, { audio: initial });
    assert.deepEqual(store.getProvider("audio"), initial);
    await store.update("audio", { endpoint: input.endpoint, model: "saved", useProxy: false });
    assert.deepEqual(store.getProvider("audio"), { endpoint: input.endpoint, model: "saved", key: "initial-key" });
    const proxyDirectory = await directory(t);
    const proxied = await NasProviderSettings.open(proxyDirectory, { proxy: initial.proxy });
    await proxied.update("video", { ...input, useProxy: true });
    assert.equal(proxied.getProvider("video")?.proxy, initial.proxy);
    const missingProxy = await NasProviderSettings.open(proxyDirectory);
    assert.equal(missingProxy.getProvider("video"), undefined);
    assert.equal(missingProxy.snapshot().video.hasKey, true);
});

test("settings reject DNS answers containing private addresses without leaking lookup errors", async (t) => {
    const store = await NasProviderSettings.open(await directory(t));
    const mocked = t.mock.method(dns, "lookup", async () => [{ address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 }]);
    syncBuiltinESMExports();
    try { await assert.rejects(store.update("video", { ...input, endpoint: "https://provider.example.test/v1/videos" }), /公网 HTTPS/); }
    finally { mocked.mock.restore(); syncBuiltinESMExports(); }
});
