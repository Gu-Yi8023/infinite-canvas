import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ConversationGenerationBridge } from "../server/http.js";
import { GenerationService } from "./service.js";
import type { GenerationTarget, GenerationTask } from "./types.js";
import { writeCodexAttachmentFiles } from "./attachments.js";

const target: GenerationTarget = { clientId: "nas-device", pageId: "nas-page", kind: "canvas", canvasId: "original-canvas", slotId: "agent-output" };
const scope = { thread_id: "conversation-thread", turn_id: "conversation-turn", type: "item.completed" };
const outputTask: GenerationTask = { id: "output-task", requestId: "output", kind: "image", target, status: "succeeded", text: "", artifacts: [{ id: "artifact-1", itemId: "image-1", mimeType: "image/png", acknowledged: false }], acknowledged: false };

test("sidebar output waits for persisted exact turn, freezes the original canvas and reaches only its sidebar connection", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-sidebar-bridge-test-"));
    try {
        const workspace = path.join(directory, "site");
        await fs.mkdir(workspace);
        const savedPath = path.join(workspace, "内置生图 空格.png");
        await fs.writeFile(savedPath, Buffer.from([137,80,78,71,13,10,26,10]));
        const service = new GenerationService(path.join(directory, "generation"), () => undefined, async () => { throw new Error("must not generate"); }, async () => ({ turns: [] }));
        const events: Array<{ clientId: string; type: string; payload: Record<string, unknown> }> = [];
        const bridge = new ConversationGenerationBridge(service, (clientId, type, payload) => events.push({ clientId, type, payload: payload as Record<string, unknown> }));
        const submitted = structuredClone(target);
        const frozen = await bridge.prebind("conversation-thread", submitted, workspace, "actual-sidebar-sse-id");
        submitted.canvasId = "different-canvas";
        const binding = bridge.bindTurn(frozen, "conversation-turn");
        const item = { id: "image-1", type: "image_generation", status: "completed", savedPath };
        const first = bridge.capture("agent_event", { ...scope, item });
        const duplicate = bridge.capture("agent_event", { ...scope, item });
        assert.equal(first, duplicate);
        await Promise.all([binding, first, duplicate]);
        assert.equal(events.length, 1);
        assert.equal(events[0].clientId, "actual-sidebar-sse-id");
        assert.notEqual(events[0].clientId, target.clientId);
        assert.equal(events[0].type, "generation_output");
        const task = events[0].payload.task as GenerationTask;
        assert.equal(task.target.canvasId, "original-canvas");
        assert.equal(task.turnId, "conversation-turn");
        assert.equal((await service.artifact(task.id, task.artifacts[0].id)).mimeType, "image/png");
        assert.equal(bridge.capture("agent_event", { ...scope, turn_id: "unregistered-turn", item }), undefined);
        assert.equal(bridge.capture("agent_event", { type: "item.completed", item }), undefined);
        await bridge.capture("agent_event", { ...scope, item });
        assert.equal(events.length, 1);
        assert.equal((await service.list(target)).length, 1);
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("failed turn target persistence interrupts only that thread and never adopts a late output", async () => {
    const messages: Array<{ clientId: string; type: string; payload: unknown }> = [];
    const interrupted: string[] = [];
    let registrations = 0;
    let adopted = 0;
    const bridge = new ConversationGenerationBridge({
        registerConversationTarget: async () => { if (++registrations > 1) throw new Error("secret /var/lib/private-config"); },
        adoptConversationOutput: async () => { adopted++; return outputTask; },
    }, (clientId, type, payload) => messages.push({ clientId, type, payload }), async (threadId) => { interrupted.push(threadId || ""); return true; });
    const frozen = await bridge.prebind("conversation-thread", target, "/workspace/site", "sidebar-original");
    const binding = bridge.bindTurn(frozen, "conversation-turn");
    const output = bridge.capture("agent_event", { ...scope, item: { id: "image-1", type: "image_generation", savedPath: "/workspace/site/image.png" } });
    await assert.rejects(binding, /目标保存失败/);
    await output;
    assert.deepEqual(interrupted, ["conversation-thread"]);
    assert.equal(adopted, 0);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].clientId, "sidebar-original");
    assert.equal(messages[0].type, "agent_error");
    assert.doesNotMatch(JSON.stringify(messages), /private-config|secret/);
});

test("prebinding failure is safe and artifact delivery can be retried without generating", async () => {
    const broken = new ConversationGenerationBridge({ registerConversationTarget: async () => { throw new Error("private path"); }, adoptConversationOutput: async () => outputTask }, () => undefined);
    await assert.rejects(broken.prebind("thread", target, "/workspace/site", "sidebar"), /未启动本轮生成/);
    let attempts = 0;
    const events: string[] = [];
    const bridge = new ConversationGenerationBridge({
        registerConversationTarget: async () => undefined,
        adoptConversationOutput: async () => { if (++attempts === 1) throw new Error("private source image missing"); return outputTask; },
    }, (_clientId, type) => events.push(type));
    const frozen = await bridge.prebind("conversation-thread", target, "/workspace/site", "sidebar");
    await bridge.bindTurn(frozen, "conversation-turn");
    const event = { ...scope, item: { id: "image-1", type: "imageGeneration", savedPath: "/workspace/site/image.png" } };
    await bridge.capture("agent_event", event);
    await bridge.capture("agent_event", event);
    assert.deepEqual(events, ["agent_error", "generation_output"]);
    assert.equal(attempts, 2);
});

test("NAS original attachments stay in a unique workspace directory and failed writes clean up", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-sidebar-attachment-test-"));
    const previous = process.env.NAS_MODE;
    process.env.NAS_MODE = "true";
    try {
        const original = Buffer.from([137,80,78,71,13,10,26,10,0,1,2,3]);
        const image = { name: "原始 图片.png", dataUrl: `data:image/png;base64,${original.toString("base64")}` };
        const files = await writeCodexAttachmentFiles([image], directory);
        assert.equal(files.length, 1);
        assert.match(path.relative(directory, files[0]), /^\.canvas-attachments-/);
        assert.deepEqual(await fs.readFile(files[0]), original);
        const beforeFailure = await fs.readdir(directory);
        await assert.rejects(writeCodexAttachmentFiles([image, { dataUrl: "data:image/png;base64," }], directory));
        assert.deepEqual(await fs.readdir(directory), beforeFailure);
        await assert.rejects(writeCodexAttachmentFiles([image]));
    } finally {
        if (previous === undefined) delete process.env.NAS_MODE; else process.env.NAS_MODE = previous;
        await fs.rm(directory, { recursive: true, force: true });
    }
});
