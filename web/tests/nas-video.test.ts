import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mock, test } from "bun:test";

if (process.env.NAS_VIDEO_TEST_WORKER !== "1") {
    test("NAS video uses only same-origin API in isolated worker", () => {
        const result = spawnSync(process.execPath, ["test", import.meta.path], { cwd: new URL("..", import.meta.url), env: { ...process.env, NAS_VIDEO_TEST_WORKER: "1" }, encoding: "utf8" });
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.match(result.stdout + result.stderr, /3 pass/);
    });
} else {
    mock.module("../src/constant/runtime-config", () => ({ NAS_MODE: true }));
    mock.module("../src/i18n", () => ({ default: { t: (key: string) => key } }));
    mock.module("../src/lib/image-utils", () => ({ dataUrlToFile: () => { throw new Error("unused"); }, readFileAsDataUrl: async (file: File) => `data:${file.type};base64,${Buffer.from(await file.arrayBuffer()).toString("base64")}` }));
    mock.module("../src/services/image-storage", () => ({ imageToDataUrl: async () => "data:image/png;base64,aW1hZ2U=" }));
    mock.module("../src/services/file-storage", () => ({ getMediaBlob: async () => new Blob(["video"], { type: "video/mp4" }), resolveMediaUrl: async () => "", uploadMediaFile: async () => ({}) }));
    mock.module("../src/services/api/model-plugin", () => ({ runModelPlugin: () => { throw new Error("NAS must not run scripts"); } }));
    mock.module("../src/stores/use-config-store", () => ({ boolConfig: (_value: unknown, fallback: boolean) => fallback, buildApiUrl: () => { throw new Error("direct provider URL"); }, modelOptionName: (model: string) => model, resolveModelRequestConfig: () => { throw new Error("NAS must not resolve client credentials"); }, resolveModelScript: () => { throw new Error("NAS must not resolve plugins"); }, withLocalProxy: () => { throw new Error("provider proxy"); } }));
    const api = await import("../src/services/api/video");
    const config = { model: "configured-video", videoModel: "configured-video", baseUrl: "https://old-provider.test", apiKey: "old-browser-key", size: "16:9", vquality: "720", videoSeconds: "8" } as any;
    const requests: Array<{ path: string; options?: RequestInit }> = [];
    globalThis.fetch = async (input, options) => {
        const path = String(input); requests.push({ path, options });
        if (path.endsWith("/content")) return new Response(new Blob(["video"], { type: "video/mp4" }));
        return new Response(JSON.stringify(options?.method === "POST" ? { id: "nas-task", status: "queued" } : { id: "nas-task", status: "completed", url: "https://untrusted.test?key=secret" }), { headers: { "content-type": "application/json" } });
    };

    test("NAS submit serializes references and parameters without browser provider controls", async () => {
        requests.length = 0;
        const task = await api.createVideoGenerationTask(config, "hello", [{}] as any, { videos: [{ name: "ref.mp4", storageKey: "video:test" }] as any });
        assert.equal(task.provider, "nas"); assert.equal(requests.length, 1); assert.equal(requests[0].path, "/api/video/tasks");
        const body = JSON.parse(String(requests[0].options!.body));
        assert.equal(body.prompt, "hello"); assert.deepEqual(body.images, ["data:image/png;base64,aW1hZ2U="]); assert.deepEqual(body.videos, ["data:video/mp4;base64,dmlkZW8="]);
        for (const key of ["model", "provider", "endpoint", "apiKey", "key", "headers"]) assert.equal(body[key], undefined);
        assert.doesNotMatch(JSON.stringify(requests), /old-browser-key|old-provider/);
    });

    test("NAS poll downloads through same-origin content endpoint despite upstream URLs", async () => {
        requests.length = 0;
        const state = await api.pollVideoGenerationTask(config, { id: "nas-task", provider: "nas", model: "old-model" });
        assert.equal(state.status, "completed"); if (state.status === "completed") assert.equal(await state.result.blob!.text(), "video");
        assert.deepEqual(requests.map((item) => item.path), ["/api/video/tasks/nas-task", "/api/video/tasks/nas-task/content"]);
        assert.doesNotMatch(JSON.stringify(requests), /old-browser-key|old-provider|untrusted/);
    });

    test("NAS rejects recovering old providers without making any request", async () => {
        requests.length = 0;
        await assert.rejects(api.pollVideoGenerationTask(config, { id: "old-task", provider: "openai", model: "old" }), /旧渠道/);
        assert.equal(requests.length, 0);
    });
}
