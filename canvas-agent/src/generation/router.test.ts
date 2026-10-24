import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { createGenerationRouter } from "./router.js";
import { GenerationService } from "./service.js";

test("device task listing and read-only reconcile include closed pages while automatic page filters remain exact", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-generation-router-test-"));
    const app = express();
    app.use(express.json());
    const service = new GenerationService(path.join(directory, "tasks"), () => undefined, async () => { throw new Error("must not generate"); }, async () => ({ turns: [] }));
    app.use("/generation", createGenerationRouter(service));
    const server = app.listen(0, "127.0.0.1");
    try {
        await once(server, "listening");
        const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/generation`;
        const workspace = path.join(directory, "site");
        await fs.mkdir(workspace);
        const savedPath = path.join(workspace, "output.png");
        await fs.writeFile(savedPath, Buffer.from([137,80,78,71,13,10,26,10]));
        for (const pageId of ["closed-page", "current-page"]) await service.adoptConversationOutput({ threadId: "thread", turnId: pageId, item: { id: "image", type: "imageGeneration", savedPath }, target: { clientId: "same-device", pageId, kind: "canvas", canvasId: pageId }, workspace });
        const all = await fetch(`${base}/tasks?clientId=same-device`);
        assert.equal(all.status, 200);
        const allTasks = (await all.json() as { tasks: Array<{ target: { pageId: string } }> }).tasks;
        assert.deepEqual(allTasks.map((task) => task.target.pageId).sort(), ["closed-page", "current-page"]);
        const filtered = await fetch(`${base}/tasks?clientId=same-device&pageId=current-page`);
        const filteredTasks = (await filtered.json() as { tasks: Array<{ target: { pageId: string } }> }).tasks;
        assert.deepEqual(filteredTasks.map((task) => task.target.pageId), ["current-page"]);
        const reconcile = await fetch(`${base}/reconcile`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clientId: "same-device" }) });
        assert.equal(reconcile.status, 200);
        assert.equal((await reconcile.json() as { tasks: unknown[] }).tasks.length, 2);
        assert.equal((await fetch(`${base}/tasks?pageId=current-page`)).status, 400);
        assert.equal((await fetch(`${base}/reconcile`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pageId: "current-page" }) })).status, 400);
        assert.equal((await service.list({ clientId: "same-device", pageId: "closed-page" }))[0].target.canvasId, "closed-page");
    } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        await fs.rm(directory, { recursive: true, force: true });
    }
});
