import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http, { type IncomingHttpHeaders, type Server } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { hash } from "bcryptjs";
import { Agent, MockAgent } from "undici";
import { createNasGateway, loadGatewayAudio, LOGIN_MAX_AGE_MS } from "./gateway.js";

const origin = "https://canvas.test";
async function listen(server: Server) { server.listen(0, "127.0.0.1"); await once(server, "listening"); return (server.address() as { port: number }).port; }
function request(port: number, route: string, options: { method?: string; headers?: IncomingHttpHeaders; body?: string } = {}) {
    return new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>((resolve, reject) => {
        const req = http.request({ hostname: "127.0.0.1", port, path: route, method: options.method || "GET", headers: { host: "canvas.test", ...options.headers } }, (res) => {
            let body = ""; res.setEncoding("utf8"); res.on("data", (chunk) => body += chunk); res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
        });
        req.on("error", reject); req.end(options.body);
    });
}
async function fixture(t: { after: (fn: () => unknown) => void }) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-gateway-test-"));
    const seen: Array<{ url: string; headers: IncomingHttpHeaders; body: string }> = [];
    let streamingClosed!: () => void;
    const closed = new Promise<void>((resolve) => streamingClosed = resolve);
    const worker = http.createServer((req, res) => {
        if (req.url === "/events") { res.writeHead(200, { "content-type": "text/event-stream" }); res.write("event: hello\ndata: {}\n\n"); res.once("close", streamingClosed); return; }
        let body = ""; req.on("data", (chunk) => body += chunk); req.on("end", () => {
            seen.push({ url: req.url!, headers: req.headers, body });
            res.writeHead(200, { "content-type": "application/json", "set-cookie": "upstream-secret=hidden", "access-control-allow-origin": "*" }); res.end(JSON.stringify({ ok: true }));
        });
    });
    const workerPort = await listen(worker);
    const app = await createNasGateway({ origin, workerUrl: `http://127.0.0.1:${workerPort}`, bridgeToken: "private-bridge-token", passwordHash: await hash("test-password", 4), sessionSecret: "test-session-secret", stateDirectory: directory, staticDirectory: directory });
    const server = http.createServer((req, res) => {
        // Model a TLS terminator without test certificates or external network access.
        Object.defineProperty(req.socket, "encrypted", { configurable: true, value: true }); app(req, res);
    });
    const port = await listen(server);
    t.after(async () => { server.closeAllConnections(); worker.closeAllConnections(); await Promise.all([new Promise<void>((resolve) => server.close(() => resolve())), new Promise<void>((resolve) => worker.close(() => resolve()))]); await fs.rm(directory, { recursive: true, force: true }); });
    const login = await request(port, "/login", { method: "POST", headers: { origin, "content-type": "application/x-www-form-urlencoded" }, body: "password=test-password" });
    assert.equal(login.status, 303);
    const cookie = login.headers["set-cookie"]![0].split(";")[0];
    return { directory, port, cookie, login, seen, closed };
}

test("login responses preserve same-origin metadata for native form submissions", async (t) => {
    const { port } = await fixture(t);
    const page = await request(port, "/login");
    assert.equal(page.status, 200);
    // Fetch's Origin-header algorithm turns a non-CORS form POST's Origin into null under no-referrer.
    assert.equal(page.headers["referrer-policy"], "same-origin");
    assert.match(page.body, /<form method="post" action="\/login">/);
    const rejected = await request(port, "/login", { method: "POST", headers: { origin, "content-type": "application/x-www-form-urlencoded" }, body: "password=wrong" });
    assert.equal(rejected.status, 401);
    assert.equal(rejected.headers["referrer-policy"], "same-origin");
});

test("gateway requires fixed Host, same Origin, authentication and mutation CSRF", async (t) => {
    const { port, cookie } = await fixture(t);
    assert.equal((await request(port, "/api/session")).status, 401);
    assert.equal((await request(port, "/", {})).status, 303);
    assert.equal((await request(port, "/api/session", { headers: { cookie } })).status, 200);
    assert.equal((await request(port, "/api/session", { headers: { cookie, host: "evil.test" } })).status, 403);
    assert.equal((await request(port, "/api/session", { headers: { cookie, origin: "https://evil.test" } })).status, 403);
    assert.equal((await request(port, "/api/logout", { method: "POST", headers: { cookie } })).status, 403);
    assert.equal((await request(port, "/login", { method: "POST", headers: { origin: "null", "content-type": "application/x-www-form-urlencoded" }, body: "password=test-password" })).status, 403);
    assert.equal((await request(port, "/login", { method: "POST", headers: { origin, "content-type": "application/x-www-form-urlencoded" }, body: "password=wrong" })).status, 401);
});

test("login uses a fixed seven-day secure host cookie and authenticated requests do not renew it", async (t) => {
    const { port, directory, cookie, login } = await fixture(t);
    const header = login.headers["set-cookie"]![0];
    assert.match(header, /^__Host-canvas-session=/);
    for (const attribute of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/"]) assert.ok(header.includes(attribute));
    assert.ok(!/Domain=/i.test(header));
    assert.equal(LOGIN_MAX_AGE_MS, 604800000);
    const before = await fs.readFile(path.join(directory, "sessions.json"), "utf8");
    const record = Object.values(JSON.parse(before).sessions)[0] as { expiresAt: number; cookie: { expires: string } };
    assert.ok(Math.abs(record.expiresAt - Date.now() - LOGIN_MAX_AGE_MS) < 1000);
    assert.ok(Math.abs(new Date(record.cookie.expires).getTime() - record.expiresAt) < 1000);
    const checked = await request(port, "/api/session", { headers: { cookie } });
    assert.equal(checked.headers["set-cookie"], undefined);
    assert.equal(await fs.readFile(path.join(directory, "sessions.json"), "utf8"), before);
});

test("proxy strips browser identity, injects bridge auth, preserves worker path and hides upstream cookies", async (t) => {
    const { port, cookie, seen } = await fixture(t);
    const reply = await request(port, "/api/agent/agent/codex/turn?clientId=tab-a", { method: "POST", headers: { cookie, origin, authorization: "Bearer browser-secret", "x-canvas-agent-token": "attacker", "x-forwarded-for": "fake", "x-forwarded-host": "fake", "x-forwarded-proto": "http", "content-type": "application/json" }, body: JSON.stringify({ prompt: "hello" }) });
    assert.equal(reply.status, 200);
    assert.equal(seen[0].url, "/agent/codex/turn?clientId=tab-a");
    assert.equal(seen[0].body, '{"prompt":"hello"}');
    assert.equal(seen[0].headers["x-canvas-agent-token"], "private-bridge-token");
    for (const header of ["cookie", "authorization", "origin", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto"]) assert.equal(seen[0].headers[header], undefined);
    assert.equal(reply.headers["set-cookie"], undefined); assert.equal(reply.headers["access-control-allow-origin"], undefined); assert.equal(reply.headers["cache-control"], "no-store");
});

test("arbitrary file and direct tool routes cannot bypass gateway blocking through case or slash variants", async (t) => {
    const { port, cookie, seen } = await fixture(t);
    for (const route of ["/agent/local-image", "/agent/local-file/reveal", "/api/tools", "/AGENT/LOCAL-IMAGE", "/agent/local-image/", "/API/TOOLS/"]) {
        assert.equal((await request(port, `/api/agent${route}`, { method: "POST", headers: { cookie, origin, "content-type": "application/json" }, body: "{}" })).status, 403, route);
    }
    assert.equal(seen.length, 0);
});

test("logout revokes cookie, closes existing SSE and prevents authenticated API access", async (t) => {
    const { port, cookie, closed } = await fixture(t);
    const stream = http.request({ hostname: "127.0.0.1", port, path: "/api/agent/events", headers: { host: "canvas.test", cookie } });
    stream.end(); const [response] = await once(stream, "response"); response.resume(); await once(response, "data");
    const logout = await request(port, "/api/logout", { method: "POST", headers: { cookie, origin } });
    assert.equal(logout.status, 200); await closed;
    assert.match(logout.headers["set-cookie"]![0], /Expires=Thu, 01 Jan 1970/);
    assert.equal((await request(port, "/api/session", { headers: { cookie } })).status, 401);
});

test("a captured login cookie expires after the approved seven days even if the client replays it", async (t) => {
    const { port, cookie } = await fixture(t);
    const expiredTime = Date.now() + LOGIN_MAX_AGE_MS + 1;
    t.mock.method(Date, "now", () => expiredTime);
    assert.equal((await request(port, "/api/session", { headers: { cookie } })).status, 401);
});


test("partial audio configuration never aborts gateway setup or exposes configured values", () => {
    const audio = { AUDIO_SPEECH_URL: "https://private-audio.example/speech", AUDIO_MODEL: "private-model", AUDIO_API_KEY_FILE: "/private-key-file" };
    const read = () => { throw new Error("must not read incomplete secrets"); };
    assert.deepEqual(loadGatewayAudio({}, read), {});
    for (const partial of [
        { AUDIO_SPEECH_URL: audio.AUDIO_SPEECH_URL },
        { AUDIO_MODEL: audio.AUDIO_MODEL },
        { AUDIO_API_KEY_FILE: audio.AUDIO_API_KEY_FILE },
        { AUDIO_SPEECH_URL: audio.AUDIO_SPEECH_URL, AUDIO_MODEL: audio.AUDIO_MODEL },
    ]) {
        const config = loadGatewayAudio(partial, read);
        assert.equal(config.audio, undefined);
        assert.match(config.warning || "", /配置不完整/);
        assert.doesNotMatch(config.warning || "", /private-audio|private-model|private-key-file/);
    }
});

test("complete audio retains its proxy default and explicit direct mode without falling back on missing secrets", () => {
    const env = { AUDIO_SPEECH_URL: "https://audio.example/speech", AUDIO_MODEL: "tts", AUDIO_API_KEY_FILE: "audio-key", OUTBOUND_PROXY_FILE: "proxy-secret" };
    const read = (file: string) => file === "audio-key" ? " private-audio-key\n" : " http://proxy.example:1234\n";
    assert.deepEqual(loadGatewayAudio(env, read), { audio: { endpoint: env.AUDIO_SPEECH_URL, model: "tts", key: "private-audio-key", proxy: "http://proxy.example:1234" } });
    assert.deepEqual(loadGatewayAudio({ ...env, AUDIO_USE_PROXY: "false" }, read), { audio: { endpoint: env.AUDIO_SPEECH_URL, model: "tts", key: "private-audio-key" } });
    const noProxyFile = loadGatewayAudio({ ...env, OUTBOUND_PROXY_FILE: "" }, read);
    assert.equal(noProxyFile.audio, undefined);
    assert.match(noProxyFile.warning || "", /不会自动直连/);
    const unreadableProxy = loadGatewayAudio(env, (file) => { if (file === "audio-key") return "private-audio-key"; throw new Error("private proxy URL and credentials"); });
    assert.equal(unreadableProxy.audio, undefined);
    assert.doesNotMatch(unreadableProxy.warning || "", /credentials|private proxy/);
    assert.equal(loadGatewayAudio(env, (file) => file === "audio-key" ? "private-audio-key" : "").audio, undefined);
    assert.equal(loadGatewayAudio(env, () => "").audio, undefined);
    assert.equal(loadGatewayAudio(env, () => { throw new Error("private key path"); }).audio, undefined);
});

test("missing optional audio keeps authenticated Codex proxy working and audio requests fail explicitly", async (t) => {
    const parsed = loadGatewayAudio({ AUDIO_SPEECH_URL: "https://audio.example/speech", AUDIO_API_KEY_FILE: "missing-key" }, () => { throw new Error("must not read partial configuration"); });
    assert.equal(parsed.audio, undefined);
    const { port, cookie, seen } = await fixture(t);
    const speech = await request(port, "/api/audio/speech", { method: "POST", headers: { cookie, origin, "content-type": "application/json" }, body: JSON.stringify({ input: "hello" }) });
    assert.equal(speech.status, 503);
    assert.equal(JSON.parse(speech.body).code, "AUDIO_NOT_CONFIGURED");
    const codex = await request(port, "/api/agent/agent/codex/models", { headers: { cookie } });
    assert.equal(codex.status, 200);
    assert.equal(seen[0].url, "/agent/codex/models");
});

test("provider endpoints inherit login and same-origin checks and never return saved credentials", async (t) => {
    const { port, cookie } = await fixture(t);
    const route = "/api/providers/audio";
    const input = { endpoint: "https://93.184.216.34/v1/audio/speech", model: "tts", apiKey: "private-settings-key", useProxy: false };
    const headers = { cookie, origin, "content-type": "application/json" };
    assert.equal((await request(port, "/api/providers")).status, 401);
    assert.equal((await request(port, route, { method: "PUT", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(input) })).status, 401);
    assert.equal((await request(port, route, { method: "PUT", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(input) })).status, 403);
    assert.equal((await request(port, "/api/providers", { headers: { cookie, origin: "https://evil.test" } })).status, 403);
    for (const route of ["/api/video/tasks/task-id", "/api/video/tasks/task-id/content"]) {
        assert.equal((await request(port, route)).status, 401);
        assert.equal((await request(port, route, { headers: { cookie, origin: "https://evil.test" } })).status, 403);
    }
    assert.equal((await request(port, "/api/video/tasks", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: "{}" })).status, 403);
    const saved = await request(port, route, { method: "PUT", headers, body: JSON.stringify(input) });
    assert.equal(saved.status, 200);
    assert.equal(JSON.parse(saved.body).audio.hasKey, true);
    assert.doesNotMatch(saved.body, /private-settings-key|apiKey/);
    const read = await request(port, "/api/providers", { headers: { cookie } });
    assert.doesNotMatch(read.body, /private-settings-key|apiKey/);
    const invalid = await request(port, route, { method: "PUT", headers, body: JSON.stringify({ ...input, endpoint: "https://private-settings-key@127.0.0.1/speech" }) });
    assert.equal(invalid.status, 400);
    assert.doesNotMatch(invalid.body, /private-settings-key/);
    const proxied = await request(port, route, { method: "PUT", headers, body: JSON.stringify({ ...input, useProxy: true }) });
    assert.equal(proxied.status, 400); assert.match(proxied.body, /不会自动直连/);
});

test("saved audio configuration is immediately used by capabilities and speech without a restart", async (t) => {
    const { port, cookie } = await fixture(t);
    const agent = new Agent(); agent.dispatch = agent.dispatch.bind(agent);
    const upstream = new MockAgent({ agent }); upstream.disableNetConnect(); t.after(() => upstream.close());
    t.mock.method(Agent.prototype, "dispatch", (options, handler) => upstream.dispatch(options, handler));
    const headers = { cookie, origin, "content-type": "application/json" };
    const endpoint = "https://93.184.216.34/v1/audio/speech";
    const saved = await request(port, "/api/providers/audio", { method: "PUT", headers, body: JSON.stringify({ endpoint, model: "saved-tts", apiKey: "saved-only-key", useProxy: false }) });
    assert.equal(saved.status, 200);
    const capability = await request(port, "/api/capabilities", { headers: { cookie } });
    assert.deepEqual(JSON.parse(capability.body).audio, { configured: true, model: "saved-tts" });
    upstream.get("https://93.184.216.34").intercept({ method: "POST", path: "/v1/audio/speech", headers: { authorization: "Bearer saved-only-key" }, body: JSON.stringify({ input: "hello", model: "saved-tts" }) }).reply(200, "audio-bytes", { headers: { "content-type": "audio/mpeg" } });
    const speech = await request(port, "/api/audio/speech", { method: "POST", headers, body: JSON.stringify({ input: "hello" }) });
    assert.equal(speech.status, 200); assert.equal(speech.body, "audio-bytes"); upstream.assertNoPendingInterceptors();
    const video = await request(port, "/api/providers/video", { method: "PUT", headers, body: JSON.stringify({ endpoint: "https://93.184.216.34/v1/videos", model: "saved-video", apiKey: "video-only-key", useProxy: false }) });
    assert.equal(video.status, 200);
    assert.deepEqual(JSON.parse((await request(port, "/api/capabilities", { headers: { cookie } })).body).video, { configured: true, available: true, model: "saved-video" });
});
