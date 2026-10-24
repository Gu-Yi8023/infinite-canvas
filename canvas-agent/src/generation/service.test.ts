import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GenerationService } from "./service.js";
import { terminalTask, type GenerationInput, type GenerationTask } from "./types.js";

const input: GenerationInput = { requestId: "request-1", kind: "text", prompt: "生成文本", target: { clientId: "device-1", pageId: "page-1", kind: "canvas", canvasId: "canvas-1", nodeId: "node-1" } };
async function settled(service: GenerationService, id: string): Promise<GenerationTask> {
    const current = await service.get(id);
    if (terminalTask(current)) return current;
    return await new Promise((resolve) => {
        const remove = service.subscribe(id, (task) => { if (terminalTask(task)) { remove(); resolve(task); } });
    });
}

test("image runner prompts describe only the reference images actually supplied", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-image-prompt-test-"));
    const bytes = Buffer.from([137,80,78,71,13,10,26,10]);
    try {
        for (const [index, referenceImages] of [undefined, [], [`data:image/png;base64,${bytes.toString("base64")}`]].entries()) {
            let submitted: { prompt: string; images: string[] } | undefined;
            const service = new GenerationService(path.join(directory, String(index)), () => undefined, async (prompt, _emit, options) => {
                submitted = { prompt, images: options.images };
                throw new Error("probe stops before model execution");
            });
            const created = await service.create({ ...input, kind: "image", prompt: "生成一个雨中漫步的猫", ...(referenceImages ? { referenceImages } : {}) });
            await settled(service, created.id);
            assert.ok(submitted);
            assert.match(submitted.prompt, /生成一个雨中漫步的猫/);
            assert.equal(submitted.images.length, referenceImages?.length || 0);
            if (referenceImages?.length) {
                assert.match(submitted.prompt, /原始参考图已作为图片输入/);
                assert.match(submitted.prompt, /使用实际提供的图片输入/);
                assert.deepEqual(await fs.readFile(submitted.images[0]), bytes);
            } else {
                assert.doesNotMatch(submitted.prompt, /原始参考图已作为图片输入/);
                assert.match(submitted.prompt, /没有参考图.*根据用户描述生成新图片/);
                assert.match(submitted.prompt, /不要设置 referenced_image_paths、num_last_images_to_include/);
            }
        }
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("native image events import only the matching turn and deduplicate savedPath", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-native-output-test-"));
    const previous = process.env.CODEX_HOME;
    process.env.CODEX_HOME = path.join(directory, "codex");
    const native = path.join(process.env.CODEX_HOME, "generated_images");
    const bytes = Buffer.from([137,80,78,71,13,10,26,10]);
    try {
        await fs.mkdir(native, { recursive: true });
        const savedPath = path.join(native, "native.png");
        await fs.writeFile(savedPath, bytes);
        let service!: GenerationService;
        let submittedPrompt = "";
        service = new GenerationService(path.join(directory, "tasks"), () => undefined, async (prompt, _emit, options) => {
            submittedPrompt = prompt;
            await options.onThread("native-thread"); options.onTurn("native-turn");
            service.captureEvent("agent_event", { thread_id: "native-thread", turn_id: "other-turn", type: "item.completed", item: { id: "wrong", type: "image_generation", savedPath: path.join(directory, "outside.png") } });
            for (let i = 0; i < 2; i++) service.captureEvent("agent_event", { thread_id: "native-thread", turn_id: "native-turn", type: "item.completed", item: { id: "native-item", type: "image_generation", savedPath } });
        });
        const created = await service.create({ ...input, kind: "image" });
        const task = await settled(service, created.id);
        assert.equal(task.status, "succeeded", task.error);
        assert.match(submittedPrompt, /服务器自动接收/);
        assert.doesNotMatch(submittedPrompt, /将最终产物保存到当前任务目录/);
        assert.equal(task.artifacts.length, 1);
        await fs.unlink(savedPath);
        assert.deepEqual((await service.artifact(task.id, task.artifacts[0].id)).bytes, bytes);
    } finally {
        if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous;
        await fs.rm(directory, { recursive: true, force: true });
    }
});

test("native savedPath imports consistently during recovery and conversation adoption", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-native-recovery-test-"));
    const previous = process.env.CODEX_HOME;
    process.env.CODEX_HOME = path.join(directory, "codex");
    const native = path.join(process.env.CODEX_HOME, "generated_images");
    const taskDirectory = path.join(directory, "tasks");
    const id = "11111111-1111-4111-8111-111111111111";
    try {
        await fs.mkdir(native, { recursive: true });
        await fs.mkdir(path.join(taskDirectory, id), { recursive: true });
        const savedPath = path.join(native, "native.png");
        await fs.writeFile(savedPath, Buffer.from([137,80,78,71,13,10,26,10]));
        const item = { id: "native-item", type: "imageGeneration", status: "completed", savedPath };
        const record = { version: 1, id, requestId: input.requestId, kind: "image", target: input.target, status: "running", text: "", artifacts: [], acknowledged: false, input: { ...input, kind: "image" }, files: {}, items: {}, threadId: "native-thread", turnId: "native-turn" };
        await fs.writeFile(path.join(taskDirectory, `${id}.json`), JSON.stringify(record));
        const service = new GenerationService(taskDirectory, () => undefined, async () => { throw new Error("must not generate"); }, async () => ({ id: "native-thread", turns: [{ id: "native-turn", status: "completed", items: [item, item] }] }));
        const recovered = await service.reconcile(id);
        assert.equal(recovered.status, "succeeded");
        assert.equal(recovered.artifacts.length, 1);
        const workspace = path.join(directory, "site"); await fs.mkdir(workspace);
        const adopt = { threadId: "conversation-thread", turnId: "conversation-turn", item, target: input.target, workspace };
        const adopted = await service.adoptConversationOutput(adopt);
        assert.equal(adopted.status, "succeeded");
        assert.equal((await service.adoptConversationOutput(adopt)).id, adopted.id);
        assert.equal(adopted.artifacts.length, 1);
        await fs.unlink(savedPath);
        assert.equal((await service.artifact(recovered.id, recovered.artifacts[0].id)).mimeType, "image/png");
        assert.equal((await service.artifact(adopted.id, adopted.artifacts[0].id)).mimeType, "image/png");
    } finally {
        if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous;
        await fs.rm(directory, { recursive: true, force: true });
    }
});

test("text tasks bind thread, turn and item; request IDs are idempotent; restart does not generate", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-task-test-"));
    let calls = 0;
    let service!: GenerationService;
    service = new GenerationService(directory, () => undefined, async (_prompt, _emit, options) => {
        calls++;
        options.onThread("thread-1"); options.onTurn("turn-1");
        service.captureEvent("agent_event", { thread_id: "thread-1", turn_id: "other-turn", type: "item.updated", item: { id: "bad", type: "agent_message", delta: "wrong" } });
        service.captureEvent("agent_event", { thread_id: "thread-1", turn_id: "turn-1", type: "item.updated", item: { id: "item-1", type: "agent_message", delta: "正确文本" } });
        service.captureEvent("agent_event", { thread_id: "thread-1", turn_id: "turn-1", type: "item.completed", item: { id: "item-1", type: "agent_message", text: "正确文本" } });
    });
    try {
        const created = await service.create(input);
        const complete = await settled(service, created.id);
        assert.equal(complete.status, "succeeded");
        assert.equal(complete.text, "正确文本");
        assert.equal((await service.create(input)).id, created.id);
        assert.equal(calls, 1);
        assert.equal((await service.ack(created.id, [])).acknowledged, true);
        assert.equal("files" in await service.get(created.id), false);
        const restored = new GenerationService(directory, () => undefined, async () => { throw new Error("must not run"); });
        assert.equal((await restored.get(created.id)).status, "succeeded");
        await assert.rejects(service.create({ ...input, prompt: "different" }));
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("cancelled task ignores late model output", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-task-cancel-test-"));
    let release!: () => void;
    let began!: () => void;
    const started = new Promise<void>((resolve) => { began = resolve; });
    const running = new Promise<void>((resolve) => { release = resolve; });
    let service!: GenerationService;
    service = new GenerationService(directory, () => undefined, async (_prompt, _emit, options) => {
        options.onThread("cancel-thread"); options.onTurn("cancel-turn"); began();
        await running;
        service.captureEvent("agent_event", { thread_id: "cancel-thread", turn_id: "cancel-turn", type: "item.completed", item: { id: "late", type: "agent_message", text: "late text" } });
    });
    try {
        const task = await service.create(input);
        await started;
        await service.cancel(task.id);
        release();
        assert.equal((await service.get(task.id)).status, "cancelled");
        assert.equal((await service.get(task.id)).text, "");
    } finally { release(); await fs.rm(directory, { recursive: true, force: true }); }
});

test("restart reconciles only the recorded completed turn and never submits generation", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-task-reconcile-test-"));
    const id = "11111111-1111-4111-8111-111111111111";
    try {
        const record = { version: 1, id, requestId: input.requestId, kind: "text", target: input.target, status: "running", text: "", artifacts: [], acknowledged: false, input, files: {}, items: {}, threadId: "persisted-thread", turnId: "persisted-turn" };
        await fs.writeFile(path.join(directory, `${id}.json`), JSON.stringify(record));
        const service = new GenerationService(directory, () => undefined, async () => { throw new Error("must not generate"); }, async (_emit, threadId) => {
            assert.equal(threadId, "persisted-thread");
            return { id: threadId, turns: [{ id: "persisted-turn", status: "completed", items: [{ id: "persisted-item", type: "agentMessage", text: "已完成的原始结果" }] }] };
        });
        const recovered = await service.reconcile(id);
        assert.equal(recovered.status, "succeeded");
        assert.equal(recovered.text, "已完成的原始结果");
        assert.equal(recovered.target.nodeId, "node-1");
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("conversation outputs keep frozen targets, copy registered files and survive restart", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-conversation-test-"));
    const workspace = path.join(directory, "site");
    const taskDirectory = path.join(directory, "tasks");
    const target = input.target;
    const item = { id: "conversation-image", type: "imageGeneration", savedPath: path.join(workspace, "原始 图片.png"), status: "completed" };
    const read = async () => ({ id: "conversation-thread", turns: [{ id: "conversation-turn", status: "completed", items: [item] }] });
    try {
        await fs.mkdir(workspace);
        await fs.writeFile(item.savedPath, Buffer.from([137,80,78,71,13,10,26,10]));
        const service = new GenerationService(taskDirectory, () => undefined, async () => { throw new Error("must not generate"); }, read);
        await service.registerConversationTarget("conversation-thread", "conversation-turn", target, workspace);
        const tasks = await service.reconcileConversations(target);
        assert.equal(tasks.length, 1);
        const task = tasks[0];
        assert.equal(task.target.canvasId, "canvas-1");
        assert.equal(task.status, "succeeded");
        assert.equal(service.ownsThread("conversation-thread"), false);
        assert.equal((await service.artifact(task.id, task.artifacts[0].id)).mimeType, "image/png");
        assert.equal((await service.adoptConversationOutput({ threadId: "conversation-thread", turnId: "conversation-turn", item, target, workspace })).id, task.id);
        await assert.rejects(service.registerConversationTarget("conversation-thread", "conversation-turn", { ...target, canvasId: "wrong-canvas" }, workspace));
        await fs.unlink(item.savedPath);
        const restarted = new GenerationService(taskDirectory, () => undefined, async () => { throw new Error("must not generate"); }, read);
        assert.equal((await restarted.get(task.id)).status, "succeeded");
        assert.equal((await restarted.artifact(task.id, task.artifacts[0].id)).mimeType, "image/png");
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("failed task reports login failure without leaking upstream secrets or paths", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-task-failure-test-"));
    try {
        const service = new GenerationService(directory, () => undefined, async () => { throw new Error("401 authentication rejected token=private-secret /var/lib/codex/auth.json"); });
        const created = await service.create(input);
        const task = await settled(service, created.id);
        assert.equal(task.status, "failed");
        assert.match(task.error || "", /登录无效/);
        assert.doesNotMatch(task.error || "", /private-secret|auth\.json/);
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("artifact delivery and conversation adoption use the same validated byte snapshot when a path changes after close", async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-artifact-snapshot-test-"));
    const workspace = path.join(directory, "site");
    const taskDirectory = path.join(directory, "tasks");
    const bytes = Buffer.from([137,80,78,71,13,10,26,10,10,20,30]);
    const replacement = Buffer.from("unvalidated private file content");
    const originalOpen = fs.open.bind(fs);
    let replaceAfterClose = "";
    const mocked = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
        const handle = await originalOpen(...args);
        if (String(args[0]) === replaceAfterClose) {
            const close = handle.close.bind(handle);
            handle.close = async () => {
                await close();
                if (String(args[0]) !== replaceAfterClose) return;
                const file = replaceAfterClose;
                replaceAfterClose = "";
                await fs.writeFile(file, replacement);
            };
        }
        return handle;
    });
    try {
        await fs.mkdir(workspace);
        const savedPath = path.join(workspace, "original.png");
        await fs.writeFile(savedPath, bytes);
        const service = new GenerationService(taskDirectory, () => undefined, async () => { throw new Error("must not generate"); }, async () => ({ turns: [] }));
        replaceAfterClose = savedPath;
        const task = await service.adoptConversationOutput({ threadId: "thread", turnId: "turn", item: { id: "item", type: "imageGeneration", savedPath }, target: input.target, workspace });
        assert.deepEqual(await fs.readFile(savedPath), replacement);
        const stored = JSON.parse(await fs.readFile(path.join(taskDirectory, `${task.id}.json`), "utf8")) as { files: Record<string, string> };
        const outputPath = stored.files[task.artifacts[0].id];
        assert.deepEqual(await fs.readFile(outputPath), bytes);
        replaceAfterClose = outputPath;
        const delivered = await service.artifact(task.id, task.artifacts[0].id);
        assert.deepEqual(delivered.bytes, bytes);
        assert.deepEqual(await fs.readFile(outputPath), replacement);
        await assert.rejects(service.artifact(task.id, task.artifacts[0].id), /内容与图片类型不符/);
    } finally {
        mocked.mock.restore();
        await fs.rm(directory, { recursive: true, force: true });
    }
});
