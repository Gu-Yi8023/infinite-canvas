import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { beforeEach, mock, test } from "bun:test";

// Module mocks stay in an isolated Bun worker so existing model-selection tests keep real modules.
if (process.env.NAS_RECOVERY_TEST_WORKER !== "1") {
    test("NAS recovery and consumption behavior in an isolated browser worker", () => {
        const result = spawnSync(process.execPath, ["test", import.meta.path], { cwd: new URL("..", import.meta.url), env: { ...process.env, NAS_RECOVERY_TEST_WORKER: "1" }, encoding: "utf8" });
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.match(result.stdout + result.stderr, /8 pass/);
    });
} else {
    const records = new Map<string, unknown>();
    const files = new Map<string, unknown>();
    const held = new Set<string>();
    const tasks = new Map<string, any>();
    const requests: Array<{ url: URL; method: string; body?: any }> = [];
    let uploads = 0;
    let downloads = 0;
    let acked = 0;
    let creates = 0;
    let logoutStatus = 200;
    let redirect = "";
    const storage = () => { const data = new Map<string, string>(); return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value), removeItem: (key: string) => data.delete(key), clear: () => data.clear() }; };
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage() });
    Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: storage() });
    const events = new EventTarget();
    const location = { pathname: "/canvas/canvas-a", search: "", assign: (value: string) => { redirect = value; } };
    Object.defineProperty(globalThis, "window", { configurable: true, value: { location, dispatchEvent: events.dispatchEvent.bind(events) } });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { locks: { request: async (name: string, _options: unknown, callback: (lock: unknown) => unknown) => {
        if (held.has(name)) return callback(null);
        held.add(name);
        try { return await callback({ name }); } finally { held.delete(name); }
    } } } });
    mock.module("localforage", () => ({ default: { createInstance: () => ({ getItem: async (key: string) => structuredClone(records.get(key) ?? null), setItem: async (key: string, value: unknown) => { records.set(key, structuredClone(value)); return value; }, removeItem: async (key: string) => { records.delete(key); } }) } }));
    mock.module("../src/constant/runtime-config", () => ({ NAS_MODE: true }));
    mock.module("../src/stores/use-nas-store", () => ({ useNasStore: { setState: () => undefined } }));
    mock.module("../src/services/image-storage", () => ({ uploadImage: async () => {
        const id = ++uploads; const image = { url: `blob:import-${id}`, storageKey: `image:${id}`, width: 200, height: 100, bytes: 12, mimeType: "image/png" }; files.set(image.storageKey, image); return image;
    }, resolveImageUrl: async (key: string) => (files.get(key) as any)?.url || "", reuseStoredImage: (image: unknown) => image }));
    globalThis.fetch = async (input, init) => {
        const url = new URL(String(input), "https://canvas.test"); const method = init?.method || "GET"; const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        requests.push({ url, method, body });
        const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
        if (url.pathname === "/api/logout") return response({}, logoutStatus);
        if (url.pathname === "/api/agent/generation/reconcile") return response({ tasks: [...tasks.values()] });
        const base = "/api/agent/generation/tasks";
        if (url.pathname === base && method === "POST") {
            creates++; const task = { id: `created-${creates}`, ...body, status: "succeeded", text: "generated text", artifacts: body.kind === "image" ? [{ id: `artifact-${creates}`, mimeType: "image/png" }] : [] }; tasks.set(task.id, task); return response({ task });
        }
        if (url.pathname === base) return response({ tasks: [...tasks.values()].filter((task) => [...url.searchParams].every(([key, value]) => task.target[key] === value)) });
        const id = decodeURIComponent(url.pathname.slice(base.length + 1).split("/")[0]); const task = tasks.get(id);
        if (!task) throw new Error(`Unexpected test request ${url}`);
        if (url.pathname.endsWith("/ack")) { acked++; task.acknowledged = true; return response({ task }); }
        if (url.pathname.includes("/artifacts/")) { downloads++; return new Response(new Blob(["image"], { type: "image/png" })); }
        return response({ task });
    };
    const api = await import("../src/services/api/nas-generation");
    const task = (id: string, extra: Record<string, unknown> = {}) => ({ id, requestId: `request-${id}`, kind: "text", status: "succeeded", text: `text-${id}`, artifacts: [], target: { clientId: "device-a", pageId: "closed-page", kind: "canvas", canvasId: "canvas-a", nodeId: `node-${id}` }, ...extra });
    beforeEach(() => {
        records.clear(); files.clear(); tasks.clear(); requests.length = 0; uploads = downloads = acked = creates = 0; logoutStatus = 200; redirect = "";
        localStorage.clear(); sessionStorage.clear(); localStorage.setItem("canvas-nas-client", "device-a"); sessionStorage.setItem("canvas-nas-page", "new-page"); location.pathname = "/canvas/canvas-a";
    });

    test("closed-page tasks remain discoverable by device and manual recovery preserves the frozen target without generating", async () => {
        const original = task("closed"); tasks.set(original.id, original);
        assert.equal((await api.listNasTasks()).tasks.length, 1);
        assert.equal(requests.at(-1)!.url.searchParams.has("pageId"), false);
        let consumed = 0;
        await api.recoverNasDeliveries("canvas", "canvas-a", async () => { consumed++; return true; });
        assert.equal(consumed, 0);
        await api.recoverNasTask(original.id, ["canvas"], "canvas-a", async (delivery) => { assert.deepEqual(delivery.target, original.target); consumed++; return true; });
        assert.equal(consumed, 1); assert.equal(creates, 0);
        assert.equal(api.nasTaskTargetUrl(original as any), "/canvas/canvas-a?nasTask=closed");
        await assert.rejects(api.recoverNasTask(original.id, ["canvas"], "canvas-a", async () => { consumed++; return true; }), /已保存/);
        assert.equal(consumed, 1);
    });

    test("manual recovery rejects wrong device, kind and canvas before consuming", async () => {
        for (const target of [{ clientId: "other", kind: "canvas", canvasId: "canvas-a" }, { clientId: "device-a", kind: "plugin", canvasId: "canvas-a" }, { clientId: "device-a", kind: "canvas", canvasId: "canvas-b" }]) {
            const value = task("wrong", { target: { pageId: "closed-page", ...target } }); tasks.set(value.id, value);
            await assert.rejects(api.recoverNasTask(value.id, ["canvas"], "canvas-a", async () => { throw new Error("must not consume"); }), /原目标/);
        }
        assert.equal(downloads, 0); assert.equal(acked, 0); assert.equal(creates, 0);
    });

    test("task Web Lock prevents another tab from importing the same result", async () => {
        const value = task("locked"); tasks.set(value.id, value); held.add("canvas-nas-task:locked");
        let consumed = 0;
        await assert.rejects(api.recoverNasTask(value.id, ["canvas"], "canvas-a", async () => { consumed++; return true; }), /另一个标签页/);
        assert.equal(consumed, 0); held.delete("canvas-nas-task:locked");
        await api.recoverNasTask(value.id, ["canvas"], "canvas-a", async () => { consumed++; return true; }); assert.equal(consumed, 1);
    });

    test("normal canvas delivery is consumed only after persisted node content matches, then refresh cannot replay", async () => {
        const controller = new AbortController(); api.bindNasGeneration(controller.signal, "canvas-a", "node-normal");
        const delivery = await api.requestNasGeneration({ kind: "text", model: "model", prompt: "text" }, { signal: controller.signal });
        assert.equal(acked, 0); assert.equal(records.has(`consumed:${delivery.task!.id}`), false);
        await api.commitNasCanvasDeliveries("canvas-a", [{ id: "node-normal", metadata: { content: "different", status: "success" } }] as any);
        assert.equal(acked, 0);
        await api.commitNasCanvasDeliveries("canvas-a", [{ id: "node-normal", metadata: { content: "generated text", status: "loading" } }] as any);
        assert.equal(acked, 0);
        await api.commitNasCanvasDeliveries("canvas-a", [{ id: "node-normal", metadata: { content: "generated text", status: "success" } }] as any);
        assert.equal(acked, 1); assert.equal(records.get(`consumed:${delivery.task!.id}`), true); assert.equal(records.has(delivery.requestId), false);
        let replayed = 0; await api.recoverNasDeliveries("canvas", "canvas-a", async () => { replayed++; return true; }); assert.equal(replayed, 0);
    });

    test("normal workbench delivery commits after log persistence and will not add a recovery log", async () => {
        location.pathname = "/image";
        const delivery = await api.requestNasGeneration({ kind: "image", model: "model", prompt: "image" }, { target: { kind: "workbench", slotId: "batch-a:0" } });
        assert.equal(acked, 0);
        await api.commitNasWorkbenchDeliveries([{ storageKey: "wrong-image" }]); assert.equal(acked, 0);
        records.set("saved-log", { images: delivery.images });
        await api.commitNasWorkbenchDeliveries(delivery.images!); assert.equal(acked, 1);
        let logs = 0; await api.recoverNasDeliveries("workbench", undefined, async () => { logs++; return true; }); assert.equal(logs, 0); assert.equal(uploads, 1);
    });

    test("failed consumer persistence retains delivery and retries only receipt, importing each artifact once", async () => {
        const value = task("retry", { kind: "image", artifacts: [{ id: "retry-image", mimeType: "image/png" }] }); tasks.set(value.id, value);
        await assert.rejects(api.recoverNasTask(value.id, ["canvas"], "canvas-a", async () => { throw new Error("disk failure"); }), /disk failure/);
        assert.equal(acked, 0); assert.equal(records.has(`consumed:${value.id}`), false);
        await api.recoverNasTask(value.id, ["canvas"], "canvas-a", async () => true);
        assert.equal(acked, 1); assert.equal(downloads, 1); assert.equal(uploads, 1); assert.equal(creates, 0);
    });

    test("manual old-page recovery cannot overwrite a newer task targeting the same node", async () => {
        const old = task("old", { target: { clientId: "device-a", pageId: "closed-page", kind: "canvas", canvasId: "canvas-a", nodeId: "node-latest" } }); tasks.set(old.id, old);
        const controller = new AbortController(); api.bindNasGeneration(controller.signal, "canvas-a", "node-latest");
        await api.requestNasGeneration({ kind: "text", model: "model", prompt: "new" }, { signal: controller.signal });
        await assert.rejects(api.recoverNasTask(old.id, ["canvas"], "canvas-a", async () => { throw new Error("must not overwrite"); }), /不能覆盖/);
        await api.commitNasCanvasDeliveries("canvas-a", [{ id: "node-latest", metadata: { content: "generated text", status: "success" } }] as any);
    });

    test("conversation reconciliation uses the device scope and logout redirects only after successful POST", async () => {
        await api.reconcileNasConversations(); assert.deepEqual(requests.at(-1)!.body, { clientId: "device-a" });
        logoutStatus = 500; await assert.rejects(api.logoutNas(), /退出登录失败/); assert.equal(redirect, "");
        logoutStatus = 200; await api.logoutNas(); assert.equal(requests.at(-1)!.method, "POST"); assert.equal(redirect, "/login");
    });
}
