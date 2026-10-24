import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import test from "node:test";
import express from "express";
import { Agent, MockAgent, ProxyAgent, Response } from "undici";
import { NasVideoService, type VideoProvider } from "./video.js";

const provider: VideoProvider = { endpoint: "https://93.184.216.34/v1/videos", model: "server-video", key: "server-key" };
type Context = { after: (fn: () => unknown) => void };
async function fixture(t: Context, initial: VideoProvider | undefined = provider) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nas-video-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    let config = initial;
    let service = await NasVideoService.open(directory, () => config);
    const app = express(); app.use(express.json());
    app.post("/tasks", (req, res) => void service.create(req, res));
    app.get("/tasks/:id", (req, res) => void service.poll(req, res));
    app.get("/tasks/:id/content", (req, res) => void service.content(req, res));
    const server = http.createServer(app); server.listen(0, "127.0.0.1"); await once(server, "listening");
    t.after(() => { server.closeAllConnections(); return new Promise<void>((resolve) => server.close(() => resolve())); });
    const port = (server.address() as { port: number }).port;
    return { directory, set: (value?: VideoProvider) => { config = value; }, reopen: async () => { service = await NasVideoService.open(directory, () => config); }, call: (suffix = "", body?: unknown) => new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
        const req = http.request({ hostname: "127.0.0.1", port, path: `/tasks${suffix}`, method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", authorization: "Bearer browser-key", cookie: "browser-secret" } }, (res) => {
            let body = ""; res.on("data", (chunk) => body += chunk); res.on("end", () => resolve({ status: res.statusCode!, body, headers: res.headers }));
        }); req.on("error", reject); req.end(body === undefined ? undefined : JSON.stringify(body));
    }) };
}
function intercept(t: test.TestContext, proxy = false) {
    const agent = new Agent(); agent.dispatch = agent.dispatch.bind(agent);
    const upstream = new MockAgent({ agent, enableCallHistory: true }); upstream.disableNetConnect();
    t.after(() => upstream.close());
    t.mock.method(proxy ? ProxyAgent.prototype : Agent.prototype, "dispatch", (options, handler) => upstream.dispatch(options, handler));
    return upstream;
}

test("video rejects unconfigured service and provider controls before calling upstream", async (t) => {
    const api = await fixture(t); api.set();
    assert.equal((await api.call("", { prompt: "hello" })).status, 503); api.set(provider);
    for (const extra of [{ model: "other" }, { endpoint: "https://127.0.0.1" }, { apiKey: "secret" }, { provider: "other" }, { headers: {} }, { images: ["https://example.com/image.png"] }]) assert.equal((await api.call("", { prompt: "hello", ...extra })).status, 400);
    assert.equal((await api.call("/..%2Fsecrets")).status, 400);
});

test("video only sends server credentials and model, snapshots survive changed config and reopening", async (t) => {
    const upstream = intercept(t); const api = await fixture(t);
    upstream.get("https://93.184.216.34").intercept({ method: "POST", path: "/v1/videos", headers: { authorization: "Bearer server-key" } }).reply(200, { id: "video_remote", status: "queued", url: "https://secret?key=server-key" });
    const created = await api.call("", { prompt: "hello", mode: "frames", images: ["data:image/png;base64,aW1hZ2U="], videos: ["data:video/mp4;base64,dmlkZW8="], audios: ["data:audio/mpeg;base64,YXVkaW8="] });
    assert.equal(created.status, 200, created.body); assert.doesNotMatch(created.body, /server-key|video_remote|https:/);
    const id = JSON.parse(created.body).id;
    const record = JSON.parse(await fs.readFile(path.join(api.directory, "video-tasks", `${id}.json`), "utf8"));
    assert.deepEqual(record, { version: 1, remoteId: "video_remote", provider });
    const call = upstream.getCallHistory()!.firstCall()!;
    assert.equal(call.headers!.cookie, undefined); assert.equal(call.headers!.authorization, "Bearer server-key");
    const form = await new Response(call.body).text();
    assert.match(form, /server-video/); assert.match(form, /name="first_frame"/); assert.match(form, /name="video\[\]"/); assert.match(form, /name="audio\[\]"/); assert.doesNotMatch(form, /browser-key/);
    api.set({ endpoint: "https://1.1.1.1/other/videos", model: "new", key: "new-key" }); await api.reopen();
    upstream.get("https://93.184.216.34").intercept({ method: "GET", path: "/v1/videos/video_remote", headers: { authorization: "Bearer server-key" } }).reply(200, { id: "video_remote", status: "completed", error: { message: "server-key" } });
    assert.deepEqual(JSON.parse((await api.call(`/${id}`)).body), { id, status: "completed" });
    upstream.get("https://93.184.216.34").intercept({ method: "GET", path: "/v1/videos/video_remote/content" }).reply(200, "video-bytes", { headers: { "content-type": "video/mp4", "set-cookie": "upstream-key=secret" } });
    const content = await api.call(`/${id}/content`); assert.equal(content.body, "video-bytes"); assert.equal(content.headers["set-cookie"], undefined); assert.equal(content.headers["cache-control"], "no-store");
    upstream.assertNoPendingInterceptors();
});

test("video blocks SSRF and does not expose upstream error bodies", async (t) => {
    const api = await fixture(t, { ...provider, endpoint: "https://127.0.0.1/videos" });
    const blocked = await api.call("", { prompt: "hello" }); assert.equal(blocked.status, 502); assert.doesNotMatch(blocked.body, /127\.0|server-key/);
    api.set(provider); const upstream = intercept(t);
    upstream.get("https://93.184.216.34").intercept({ method: "POST", path: "/v1/videos" }).reply(401, "server-key https://upstream/private");
    const failed = await api.call("", { prompt: "hello" }); assert.equal(failed.status, 502); assert.match(failed.body, /401/); assert.doesNotMatch(failed.body, /server-key|https:/);
});

test("video uses proxy without fallback and refuses redirects", async (t) => {
    const upstream = intercept(t, true); const api = await fixture(t, { ...provider, proxy: "http://127.0.0.1:7890" });
    upstream.get("https://93.184.216.34").intercept({ method: "POST", path: "/v1/videos" }).reply(302, "", { headers: { location: "https://127.0.0.1/private" } });
    const response = await api.call("", { prompt: "hello" }); assert.equal(response.status, 502); assert.match(response.body, /302/); assert.equal(upstream.getCallHistory()!.calls().length, 1);
});

test("video content rejects successful non-video and corrupt task files stay untouched", async (t) => {
    const upstream = intercept(t); const api = await fixture(t);
    upstream.get("https://93.184.216.34").intercept({ method: "POST", path: "/v1/videos" }).reply(200, { id: "video_remote", status: "queued" });
    const id = JSON.parse((await api.call("", { prompt: "hello" })).body).id;
    upstream.get("https://93.184.216.34").intercept({ method: "GET", path: "/v1/videos/video_remote/content" }).reply(200, "secret", { headers: { "content-type": "text/html" } });
    const content = await api.call(`/${id}/content`); assert.equal(content.status, 502); assert.doesNotMatch(content.body, /secret/);
    const file = path.join(api.directory, "video-tasks", `${id}.json`); await fs.writeFile(file, "broken");
    await assert.rejects(api.reopen()); assert.equal(await fs.readFile(file, "utf8"), "broken");
    assert.equal((await api.call(`/${id}`)).status, 502); assert.equal(await fs.readFile(file, "utf8"), "broken");
});

test("video preserves interrupted atomic writes without blocking other NAS services", async (t) => {
    const api = await fixture(t);
    const file = path.join(api.directory, "video-tasks", `.${randomUUID()}.json.tmp`);
    await fs.writeFile(file, "unfinished-sensitive-record", { mode: 0o600 });
    await api.reopen();
    assert.equal(await fs.readFile(file, "utf8"), "unfinished-sensitive-record");
});
