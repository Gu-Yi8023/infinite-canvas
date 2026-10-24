import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { interruptCodexTurn, resolveCodexApproval, readCodexGenerationThread, runCodexGeneration, subscribeCodexEvents } from "../agent/codex.js";
import type { AgentEmit } from "../agent/types.js";
import { field } from "../utils/value.js";
import { imageOutputPaths, importGeneratedImage, registeredImage } from "./artifacts.js";
import { publicTask, terminalTask, type GenerationInput, type GenerationTask, type StoredTask } from "./types.js";

type ConversationTarget = { threadId: string; turnId: string; target: GenerationInput["target"]; workspace: string };

export class GenerationService {
    private conversationTargets = new Map<string, ConversationTarget>();
    private tasks = new Map<string, StoredTask>();
    private writes: Promise<unknown> = Promise.resolve();
    private eventWork = new Map<string, Promise<unknown>>();
    private listeners = new Map<string, Set<(task: GenerationTask) => void>>();
    private ready: Promise<void>;
    private reconciling = new Map<string, Promise<GenerationTask>>();
    private adopting = new Map<string, Promise<GenerationTask>>();
    constructor(private directory: string, private appEmit: AgentEmit, private run: typeof runCodexGeneration = runCodexGeneration, private readThread: typeof readCodexGenerationThread = readCodexGenerationThread) {
        this.ready = this.restore();
        subscribeCodexEvents((type, payload) => this.captureEvent(type, payload));
        void this.ready.then(async () => {
            for (const task of this.tasks.values()) if (task.status === "interrupted") await this.reconcile(task.id).catch(() => undefined);
            await this.reconcileConversations();
        }).catch(() => undefined);
    }
    async capabilities() {
        await this.ready;
        const completed = [...this.tasks.values()].filter((task) => task.kind === "image" && task.status === "succeeded" && task.artifacts.length);
        for (const task of completed) {
            try { for (const file of Object.values(task.files)) await registeredImage(this.workdir(task), file); return { image: { status: "available" as const } }; } catch { /* Existing output may have been removed. */ }
        }
        return { image: { status: "unverified" as const, reason: "尚未通过当前 worker 的真实内置生图与产物读取验证" } };
    }
    ownsThread(threadId: string) { return Boolean(threadId && [...this.tasks.values()].some((task) => !task.conversation && task.threadId === threadId)); }
    async list(filter: Partial<GenerationInput["target"]> = {}) {
        await this.ready;
        return [...this.tasks.values()].filter((task) => Object.entries(filter).every(([key, value]) => value === undefined || task.target[key as keyof typeof task.target] === value)).map(publicTask);
    }
    async get(id: string) { await this.ready; return publicTask(this.task(id)); }
    async registerConversationTarget(threadId: string, turnId: string, target: GenerationInput["target"], workspace: string) {
        await this.ready;
        if (!threadId || !target.clientId || !target.pageId || !path.isAbsolute(workspace)) throw new Error("对话目标绑定无效");
        const key = `${threadId}\0${turnId}`;
        const existing = this.conversationTargets.get(key);
        if (existing && turnId && (JSON.stringify(existing.target) !== JSON.stringify(target) || existing.workspace !== workspace)) throw new Error("该对话 turn 已绑定其他目标");
        this.conversationTargets.set(key, { threadId, turnId, target: structuredClone(target), workspace });
        if (turnId) this.conversationTargets.delete(`${threadId}\0`);
        const content = JSON.stringify({ version: 1, targets: [...this.conversationTargets.values()] });
        const pending = this.writes.catch(() => undefined).then(async () => {
            const file = path.join(this.directory, "conversation-targets.json");
            await fs.writeFile(`${file}.tmp`, content, { mode: 0o600 });
            await fs.rename(`${file}.tmp`, file);
        });
        this.writes = pending;
        await pending;
    }
    async reconcileConversations(filter: Partial<GenerationInput["target"]> = {}) {
        await this.ready;
        for (const binding of this.conversationTargets.values()) {
            if (!binding.turnId || !Object.entries(filter).every(([key, value]) => value === undefined || binding.target[key as keyof typeof binding.target] === value)) continue;
            try {
                const thread = await this.readThread(this.appEmit, binding.threadId, binding.workspace);
                const turns = field(thread, "turns");
                const turn = Array.isArray(turns) ? turns.find((entry) => field(entry, "id") === binding.turnId) : undefined;
                if (!turn || field(turn, "status") !== "completed" || field(turn, "error")) continue;
                const items = field(turn, "items");
                if (!Array.isArray(items)) continue;
                for (const item of items) if (imageOutputPaths(item as Record<string, unknown>).length) await this.adoptConversationOutput({ ...binding, item: item as Record<string, unknown> });
            } catch { /* No inferred targets and no replacement generation on failed history reads. */ }
        }
        return this.list(filter);
    }
    /** 将已生成的侧栏产物复制进任务目录；不生成、不依赖当前活动画布。 */
    async adoptConversationOutput(input: { threadId: string; turnId: string; item: Record<string, unknown>; target: GenerationInput["target"]; workspace: string }): Promise<GenerationTask> {
        await this.ready;
        const itemId = String(input.item.id || "");
        if (!input.threadId || !input.turnId || !itemId || !input.target.clientId || !input.target.pageId) throw new Error("对话产物缺少固定目标");
        const requestId = `conversation:${input.threadId}:${input.turnId}:${itemId}`;
        const pending = this.adopting.get(requestId);
        if (pending) return pending;
        const operation = this.adoptConversationNow(input, requestId, itemId);
        this.adopting.set(requestId, operation);
        try { return await operation; } finally { this.adopting.delete(requestId); }
    }
    private async adoptConversationNow(input: { threadId: string; turnId: string; item: Record<string, unknown>; target: GenerationInput["target"]; workspace: string }, requestId: string, itemId: string) {
        const existing = [...this.tasks.values()].find((task) => task.requestId === requestId);
        if (existing) {
            if (JSON.stringify(existing.target) !== JSON.stringify(input.target)) throw new Error("对话产物已绑定其他目标");
            return publicTask(existing);
        }
        const candidates = imageOutputPaths(input.item);
        if (!candidates.length || ["failed", "cancelled", "interrupted"].includes(String(input.item.status))) throw new Error("对话没有可登记的图片产物");
        const taskInput: GenerationInput = { requestId, kind: "image", prompt: "Codex 对话已生成的图片", target: structuredClone(input.target) };
        const task: StoredTask = { version: 1, conversation: true, id: crypto.randomUUID(), requestId, kind: "image", target: taskInput.target, status: "succeeded", text: "", artifacts: [], acknowledged: false, input: taskInput, files: {}, items: {}, threadId: input.threadId, turnId: input.turnId };
        const directory = this.workdir(task);
        await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        for (const candidate of candidates) {
            const registered = await importGeneratedImage(directory, candidate, input.workspace);
            const artifactId = crypto.randomUUID();
            task.files[artifactId] = registered.file;
            task.artifacts.push({ id: artifactId, itemId, mimeType: registered.mimeType, acknowledged: false });
        }
        await this.save(task);
        this.tasks.set(task.id, task);
        return publicTask(task);
    }
    async create(input: GenerationInput) {
        await this.ready;
        const existing = [...this.tasks.values()].find((task) => task.requestId === input.requestId);
        if (existing) {
            if (JSON.stringify(existing.input) !== JSON.stringify(input)) throw new Error("该请求标识已绑定其他生成参数");
            return publicTask(existing);
        }
        const task: StoredTask = { version: 1, id: crypto.randomUUID(), requestId: input.requestId, kind: input.kind, target: structuredClone(input.target), status: "queued", text: "", artifacts: [], acknowledged: false, input: structuredClone(input), files: {}, items: {} };
        this.tasks.set(task.id, task);
        try { await this.save(task); } catch (error) { this.tasks.delete(task.id); throw error; }
        void this.execute(task).catch(() => undefined);
        return publicTask(task);
    }
    /** 只读核对既有 turn；网络/登录失败保留 interrupted 和原始文件。 */
    async reconcile(id: string): Promise<GenerationTask> {
        await this.ready;
        const current = this.reconciling.get(id);
        if (current) return current;
        const pending = this.reconcileNow(this.task(id));
        this.reconciling.set(id, pending);
        try { return await pending; } finally { this.reconciling.delete(id); }
    }
    private async reconcileNow(task: StoredTask) {
        if (task.status !== "interrupted" || !task.threadId || !task.turnId) return publicTask(task);
        try {
            const thread = await this.readThread(this.appEmit, task.threadId, this.workdir(task));
            const turns = field(thread, "turns");
            const turn = Array.isArray(turns) ? turns.find((value) => field(value, "id") === task.turnId) : undefined;
            if (!turn || field(turn, "status") !== "completed" || field(turn, "error")) return publicTask(task);
            const items = field(turn, "items");
            if (!Array.isArray(items)) return publicTask(task);
            const recovered = structuredClone(task);
            recovered.items = {};
            for (const item of items) {
                const itemId = String(field(item, "id") || "");
                if (!itemId) continue;
                if (["agentMessage", "agent_message"].includes(String(field(item, "type")))) recovered.items[itemId] = String(field(item, "text") || "");
                for (const candidate of imageOutputPaths(item as Record<string, unknown>)) {
                    const registered = await importGeneratedImage(this.workdir(task), candidate);
                    if (path.basename(registered.file).startsWith("reference-")) throw new Error("参考图不能作为生成产物");
                    if (Object.values(recovered.files).includes(registered.file)) continue;
                    const artifactId = crypto.randomUUID();
                    recovered.files[artifactId] = registered.file;
                    recovered.artifacts.push({ id: artifactId, itemId, mimeType: registered.mimeType, acknowledged: false });
                }
            }
            recovered.text = Object.values(recovered.items).join("\n\n");
            if (recovered.kind === "image" ? !recovered.artifacts.length : !recovered.text.trim()) return publicTask(task);
            for (const file of Object.values(recovered.files)) await registeredImage(this.workdir(task), file);
            if (task.status !== "interrupted") return publicTask(task);
            Object.assign(task, recovered, { status: "succeeded", error: undefined, approval: undefined });
            await this.save(task);
        } catch { /* Never turn an uncertain paid request into another generation. */ }
        return publicTask(task);
    }
    async cancel(id: string) {
        await this.ready;
        const task = this.task(id);
        if (terminalTask(task)) return publicTask(task);
        task.status = "cancelled";
        await this.save(task);
        if (task.threadId) await interruptCodexTurn(task.threadId);
        return publicTask(task);
    }
    async approval(id: string, requestId: string, decision: string) {
        await this.ready;
        const task = this.task(id);
        if (task.status !== "approval" || task.approval?.requestId !== requestId) throw new Error("审批不属于该任务");
        if (!["accept", "decline", "cancel"].includes(decision)) throw new Error("审批决定无效");
        if (!await resolveCodexApproval(requestId, decision)) throw new Error("审批已失效");
        return publicTask(task);
    }
    async ack(id: string, artifactIds: string[]) {
        await this.ready;
        const task = this.task(id);
        if (task.status !== "succeeded") throw new Error("任务尚未成功，不能确认导入");
        if (artifactIds.some((artifactId) => !task.artifacts.some((artifact) => artifact.id === artifactId))) throw new Error("产物不属于该任务");
        task.artifacts.forEach((artifact) => { if (artifactIds.includes(artifact.id)) artifact.acknowledged = true; });
        task.acknowledged = task.artifacts.every((artifact) => artifact.acknowledged);
        await this.save(task);
        return publicTask(task);
    }
    async artifact(id: string, artifactId: string) {
        await this.ready;
        const task = this.task(id);
        const artifact = task.artifacts.find((value) => value.id === artifactId);
        if (!artifact || !task.files[artifactId] || task.status !== "succeeded") throw new Error("产物不可读取");
        const registered = await registeredImage(this.workdir(task), task.files[artifactId]);
        return { bytes: registered.bytes, mimeType: registered.mimeType };
    }
    subscribe(id: string, listener: (task: GenerationTask) => void) {
        this.task(id);
        const listeners = this.listeners.get(id) || new Set();
        listeners.add(listener);
        this.listeners.set(id, listeners);
        return () => { listeners.delete(listener); if (!listeners.size) this.listeners.delete(id); };
    }
    captureEvent(type: string, payload: unknown) {
        const threadId = String(field(payload, "threadId") || field(payload, "thread_id") || "");
        const task = [...this.tasks.values()].find((value) => value.threadId === threadId && !terminalTask(value));
        if (!task) return false;
        const pending = (this.eventWork.get(task.id) || Promise.resolve()).then(() => this.applyEvent(task, type, payload));
        this.eventWork.set(task.id, pending);
        // Keep rejection handled until execute joins the event chain.
        void pending.catch(() => undefined);
        return true;
    }
    private async applyEvent(task: StoredTask, type: string, payload: unknown) {
        if (terminalTask(task)) return;
        const turnId = String(field(payload, "turnId") || field(payload, "turn_id") || "");
        if (task.turnId && turnId && task.turnId !== turnId) return;
        if (turnId) task.turnId = turnId;
        if (type === "codex_approval") {
            task.status = "approval";
            task.approval = { requestId: String(field(payload, "requestId") || ""), method: String(field(payload, "method") || "") };
        }
        if (type === "codex_approval_resolved") { task.status = "running"; delete task.approval; }
        if (type === "agent_event") {
            const event = String(field(payload, "type") || "");
            if (event === "turn.completed" && ["failed", "interrupted", "cancelled"].includes(String(field(payload, "status")))) throw new Error("Codex turn 未成功完成");
            const item = field(payload, "item") as Record<string, unknown> | undefined;
            const itemId = String(item?.id || "");
            if (item && itemId && turnId && item.type === "agent_message") {
                if (event === "item.updated") task.items[itemId] = `${task.items[itemId] || ""}${String(item.delta || "")}`;
                if (event === "item.completed") task.items[itemId] = String(item.text || task.items[itemId] || "");
                task.text = Object.values(task.items).join("\n\n");
            }
            if (item && itemId && turnId && event === "item.completed") {
                for (const candidate of imageOutputPaths(item)) {
                    const registered = await importGeneratedImage(this.workdir(task), candidate);
                    if (path.basename(registered.file).startsWith("reference-")) throw new Error("参考图不能作为生成产物");
                    if (Object.values(task.files).includes(registered.file)) continue;
                    const id = crypto.randomUUID();
                    task.files[id] = registered.file;
                    task.artifacts.push({ id, itemId, mimeType: registered.mimeType, acknowledged: false });
                }
            }
        }
        await this.save(task);
    }
    private async execute(task: StoredTask) {
        try {
            const cwd = this.workdir(task);
            await fs.mkdir(cwd, { recursive: true, mode: 0o700 });
            const images: string[] = [];
            for (const [index, dataUrl] of (task.input.referenceImages || []).entries()) {
                const match = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/\r\n]+={0,2})$/.exec(dataUrl);
                if (!match) throw new Error("参考图必须是原始图片 Data URL");
                const file = path.join(cwd, `reference-${index}.${match[1] === "jpeg" ? "jpg" : match[1]}`);
                await fs.writeFile(file, Buffer.from(match[2], "base64"), { mode: 0o600 });
                images.push(file);
            }
            const prompt = task.kind === "image" ? `使用内置 imagegen 生成或编辑位图。${images.length ? "原始参考图已作为图片输入，请使用实际提供的图片输入。" : "没有参考图，请根据用户描述生成新图片；不要设置 referenced_image_paths、num_last_images_to_include 等参考图参数。"}服务器自动接收内置工具产物，无需自行复制或移动图片。不要调用画布/工作台生成工具，不要用代码绘图替代。\n\n${task.input.prompt}` : `直接生成用户需要的文本，不调用画布生成工具。只输出生成内容。\n\n${task.input.prompt}`;
            await this.run(prompt, this.appEmit, { cwd, images, model: task.input.model, effort: task.input.effort, cancelled: () => terminalTask(task), onThread: async (id) => { task.threadId = id; if (!terminalTask(task)) task.status = "running"; await this.save(task); }, onTurn: (id) => { task.turnId = id; void this.save(task).catch(() => undefined); } });
            await this.eventWork.get(task.id);
            if (terminalTask(task)) return;
            if (task.kind === "image" ? !task.artifacts.length : !task.text.trim()) throw new Error(task.kind === "image" ? "Codex 未返回可读取的内置生图产物，当前生图能力尚未验证" : "Codex 未返回生成文本");
            for (const file of Object.values(task.files)) await registeredImage(cwd, file);
            task.status = "succeeded";
            await this.save(task);
        } catch (error) {
            if (terminalTask(task)) return;
            task.status = "failed";
            task.error = generationFailure(error, task.kind);
            await this.save(task);
        }
    }
    private task(id: string) { const task = this.tasks.get(id); if (!task) throw new Error("任务不存在"); return task; }
    private workdir(task: StoredTask) { return path.join(this.directory, task.id); }
    private save(task: StoredTask) {
        const serialized = JSON.stringify(task);
        const snapshot = publicTask(task);
        const pending = this.writes.catch(() => undefined).then(async () => {
            const file = path.join(this.directory, `${task.id}.json`);
            await fs.writeFile(`${file}.tmp`, serialized, { mode: 0o600 });
            await fs.rename(`${file}.tmp`, file);
            this.listeners.get(task.id)?.forEach((listener) => listener(snapshot));
        });
        this.writes = pending;
        return pending;
    }
    private async restore() {
        await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
        try {
            const manifest = JSON.parse(await fs.readFile(path.join(this.directory, "conversation-targets.json"), "utf8")) as { version: number; targets: ConversationTarget[] };
            if (manifest.version !== 1 || !Array.isArray(manifest.targets)) throw new Error("对话目标清单版本未知或损坏，拒绝覆盖");
            for (const binding of manifest.targets) {
                if (!binding.threadId || typeof binding.turnId !== "string" || !binding.target?.clientId || !binding.target.pageId || !path.isAbsolute(binding.workspace)) throw new Error("对话目标清单损坏，拒绝覆盖");
                const key = `${binding.threadId}\0${binding.turnId}`;
                if (this.conversationTargets.has(key)) throw new Error("对话目标清单冲突，拒绝覆盖");
                this.conversationTargets.set(key, binding);
            }
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        for (const entry of await fs.readdir(this.directory)) {
            if (!/^[0-9a-f-]+\.json$/.test(entry)) continue;
            const task = JSON.parse(await fs.readFile(path.join(this.directory, entry), "utf8")) as StoredTask;
            if (task.version !== 1 || entry !== `${task.id}.json` || !task.target?.clientId || !task.target.pageId || !task.input || !task.files || !task.items || !Array.isArray(task.artifacts) || !["queued", "running", "approval", "succeeded", "failed", "cancelled", "interrupted"].includes(task.status)) throw new Error("生成任务清单损坏，拒绝覆盖");
            this.tasks.set(task.id, task);
            if (!terminalTask(task)) {
                task.status = "interrupted";
                task.error = "服务已重启，任务状态待确认；未自动重新生成";
                await this.save(task);
            }
        }
    }
}









/** 仅返回固定业务说明，不把上游请求、绝对路径或凭据回传浏览器。 */
export function generationFailure(error: unknown, kind: "text" | "image") {
    const message = error instanceof Error ? error.message : String(error);
    if (/quota|usage.?limit|rate.?limit|insufficient.*credit|额度|\b429\b/i.test(message)) return "Codex 额度不足或调用受限；未自动重新生成";
    if (/unauthenticated|authentication|not logged|login|登录|\b401\b/i.test(message)) return "Codex 登录无效；请在 worker 中重新登录后手动重试";
    if (/model.*(?:not found|unavailable|unsupported|does not exist)|模型不可用/i.test(message)) return "所选 Codex 模型不可用；请选择实际可用模型后手动重试";
    if (/ECONN|ETIMEDOUT|fetch failed|proxy|network|代理|网络/i.test(message)) return "Codex 网络或出站代理不可用；未自动直连或重新生成";
    if (/产物|ENOENT|EACCES|保存图片/i.test(message)) return "生成产物不可读取；请先核对既有任务与文件，不会自动重新生成";
    return kind === "image" ? "图片生成失败或内置生图能力尚未验证；未自动重试" : "文本生成失败；请检查 Codex 和审批状态，未自动重试";
}


