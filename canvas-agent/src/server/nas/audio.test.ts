import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import dns from "node:dns/promises";
import test from "node:test";
import express from "express";
import { Agent, MockAgent, ProxyAgent } from "undici";
import { audioDestination, isPublicAddress, sendSpeech, type AudioProvider } from "./audio.js";

const endpoint = "https://93.184.216.34/v1/audio/speech";
function mockUpstream() {
    const agent = new Agent();
    // Keep MockAgent's internal dispatcher intact while replacing the adapter's Agent dispatch.
    agent.dispatch = agent.dispatch.bind(agent);
    return new MockAgent({ agent, enableCallHistory: true });
}
const provider: AudioProvider = { endpoint, model: "server-tts", key: "server-only-key" };
async function speech(t: { after: (fn: () => unknown) => void }, config: AudioProvider | undefined, body: unknown) {
    const app = express(); app.use(express.json());
    app.post("/speech", (req, res) => { void sendSpeech(req, res, config).catch((error: Error) => { if (!res.headersSent) res.status(500).json({ error: error.message }); }); });
    const server = http.createServer(app); server.listen(0, "127.0.0.1"); await once(server, "listening");
    t.after(() => { server.closeAllConnections(); return new Promise<void>((resolve) => server.close(() => resolve())); });
    const port = (server.address() as { port: number }).port;
    return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
        const req = http.request({ hostname: "127.0.0.1", port, path: "/speech", method: "POST", headers: { "content-type": "application/json", cookie: "browser-cookie=private", authorization: "Bearer browser-key", "x-forwarded-for": "127.0.0.1" } }, (res) => {
            let body = ""; res.on("data", (chunk) => body += chunk); res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
        });
        req.on("error", reject); req.end(JSON.stringify(body));
    });
}

test("audio rejects private, loopback, mapped, local and reserved addresses", async () => {
    for (const address of ["127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "::", "fc00::1", "fe80::1", "::ffff:127.0.0.1", "64:ff9b::7f00:1", "not-an-ip"]) assert.equal(isPublicAddress(address), false, address);
    assert.equal(isPublicAddress("93.184.216.34"), true);
    assert.equal(isPublicAddress("2606:4700:4700::1111"), true);
    for (const value of ["https://127.0.0.1/speech", "https://192.168.1.1/speech", "https://[::1]/speech", "https://[::ffff:127.0.0.1]/speech", "http://93.184.216.34/speech", "https://user:key@93.184.216.34/speech", "https://93.184.216.34/speech?api_key=secret", "https://93.184.216.34/speech#fragment"]) await assert.rejects(audioDestination(value));
});

test("audio DNS resolution refuses mixed private answers and pins public DNS targets with original TLS identity", async (t) => {
    let records = [{ address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 }];
    const mocked = t.mock.method(dns, "lookup", async () => records);
    syncBuiltinESMExports();
    try {
        await assert.rejects(audioDestination("https://audio.example.test/v1/audio/speech"), /内网/);
        records = [{ address: "93.184.216.34", family: 4 }];
        const target = await audioDestination("https://audio.example.test/v1/audio/speech");
        assert.equal(target.url.href, endpoint); assert.equal(target.host, "audio.example.test"); assert.equal(target.servername, "audio.example.test");
    } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
});

test("unconfigured audio and client-supplied provider controls fail before an upstream request", async (t) => {
    const unavailable = await speech(t, undefined, { input: "hello" });
    assert.equal(unavailable.status, 503); assert.equal(JSON.parse(unavailable.body).code, "AUDIO_NOT_CONFIGURED");
    assert.equal((await speech(t, provider, { input: "hello", model: "other-model" })).status, 400);
    for (const extra of [{ endpoint: "https://127.0.0.1" }, { apiKey: "browser-key" }, { headers: { authorization: "override" } }, { script: "arbitrary" }]) assert.equal((await speech(t, provider, { input: "hello", ...extra })).status, 400);
});

test("audio only sends server credentials/model and streams audio without upstream cookies", async (t) => {
    const upstream = mockUpstream(); upstream.disableNetConnect(); t.after(() => upstream.close());
    t.mock.method(Agent.prototype, "dispatch", (options, handler) => upstream.dispatch(options, handler));
    upstream.get("https://93.184.216.34").intercept({ method: "POST", path: "/v1/audio/speech", headers: { authorization: "Bearer server-only-key", "content-type": "application/json" }, body: (value: string) => {
        assert.deepEqual(JSON.parse(value), { input: "hello", voice: "alloy", model: "server-tts" }); return true;
    } }).reply(200, "audio-bytes", { headers: { "content-type": "audio/mpeg", "set-cookie": "upstream-secret=private" } });
    const response = await speech(t, provider, { input: "hello", voice: "alloy" });
    assert.equal(response.status, 200, response.body); assert.equal(response.body, "audio-bytes"); assert.equal(response.headers["content-type"], "audio/mpeg"); assert.equal(response.headers["set-cookie"], undefined); assert.equal(response.headers["cache-control"], "no-store");
    const headers = upstream.getCallHistory()!.firstCall()!.headers!;
    assert.equal(headers.authorization, "Bearer server-only-key");
    for (const name of ["cookie", "x-forwarded-for", "x-canvas-agent-token"]) assert.equal(headers[name], undefined);
    upstream.assertNoPendingInterceptors();
});

test("audio uses configured proxy dispatcher and rejects redirects without following them", async (t) => {
    const upstream = mockUpstream(); upstream.disableNetConnect(); t.after(() => upstream.close());
    let proxyRequests = 0;
    t.mock.method(ProxyAgent.prototype, "dispatch", (options, handler) => { proxyRequests++; return upstream.dispatch(options, handler); });
    upstream.get("https://93.184.216.34").intercept({ method: "POST", path: "/v1/audio/speech" }).reply(302, "", { headers: { location: "https://127.0.0.1/admin" } });
    const response = await speech(t, { ...provider, proxy: "http://127.0.0.1:7890" }, { input: "hello" });
    assert.equal(response.status, 502); assert.equal(JSON.parse(response.body).code, "AUDIO_UPSTREAM_ERROR"); assert.equal(proxyRequests, 1); upstream.assertNoPendingInterceptors();
});

test("audio refuses successful responses which are not audio", async (t) => {
    const upstream = mockUpstream(); upstream.disableNetConnect(); t.after(() => upstream.close());
    t.mock.method(Agent.prototype, "dispatch", (options, handler) => upstream.dispatch(options, handler));
    upstream.get("https://93.184.216.34").intercept({ method: "POST", path: "/v1/audio/speech" }).reply(200, '{"error":"not audio"}', { headers: { "content-type": "application/json" } });
    const response = await speech(t, provider, { input: "hello" }); assert.equal(response.status, 502, response.body);
});
