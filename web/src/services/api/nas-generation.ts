import { useNasStore } from "@/stores/use-nas-store";
import localforage from "localforage";
import { NAS_MODE } from "@/constant/runtime-config";
import { uploadImage, resolveImageUrl, reuseStoredImage, type UploadedImage } from "@/services/image-storage";
import type { CanvasNodeData } from "@/types/canvas";
import type { AiTextMessage } from "./image";

export type NasTarget = { clientId: string; pageId: string; kind: "canvas" | "workbench" | "plugin"; canvasId?: string; nodeId?: string; slotId?: string };
export type NasTask = { id: string; requestId: string; kind: "text" | "image"; target: NasTarget; status: "queued" | "running" | "approval" | "succeeded" | "failed" | "cancelled" | "interrupted"; text?: string; artifacts: Array<{ id: string; mimeType: string; acknowledged?: boolean }>; error?: string; acknowledged?: boolean; approval?: { requestId: string; method: string } };
export type NasDelivery = { task?: NasTask; requestId: string; target: NasTarget; images?: Array<UploadedImage & { id: string }>; text?: string };
const deliveries = localforage.createInstance({ name: "infinite-canvas", storeName: "nas-generation-deliveries" });
const targets = new WeakMap<AbortSignal, NasTarget>();
const active = new Set<string>();
const returned = new Map<string, NasDelivery>();
const heldLocks = new Map<string, () => void>();
const base = "/api/agent/generation/tasks";
const targetKey = (target: NasTarget) => `target:${target.clientId}:${target.kind}:${target.canvasId || ""}:${target.nodeId || ""}:${target.slotId || ""}`;
const terminal = (task: NasTask) => ["succeeded", "failed", "cancelled", "interrupted"].includes(task.status);
function stableId(storage: Storage, key: string) { const current = storage.getItem(key) || crypto.randomUUID(); storage.setItem(key, current); return current; }
export function nasTarget(kind: NasTarget["kind"], extra: Partial<NasTarget> = {}): NasTarget {
    return { clientId: stableId(localStorage, "canvas-nas-client"), pageId: stableId(sessionStorage, "canvas-nas-page"), kind, ...extra };
}
let identity: Promise<void> | undefined;
async function prepareIdentity() {
    if (!navigator.locks) return;
    identity ||= new Promise<void>((resolve) => {
        const pageId = stableId(sessionStorage, "canvas-nas-page");
        void navigator.locks.request(`canvas-nas-page:${pageId}`, { ifAvailable: true }, (lock) => {
            if (!lock) { sessionStorage.setItem("canvas-nas-page", crypto.randomUUID()); identity = undefined; resolve(); return; }
            resolve(); return new Promise<void>(() => undefined);
        });
    });
    await identity;
    if (!identity) await prepareIdentity();
}
export function nasGenerationTarget(signal?: AbortSignal): Partial<NasTarget> { const target = signal ? targets.get(signal) : undefined; return target ? { kind: target.kind, canvasId: target.canvasId, nodeId: target.nodeId, slotId: target.slotId } : {}; }
export function bindNasGeneration(signal: AbortSignal, canvasId: string, nodeId: string) { if (NAS_MODE) targets.set(signal, nasTarget("canvas", { canvasId, nodeId })); }
async function json<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${base}${path}`, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(response.status === 401 ? "NAS 认证已失效，请打开 /login 登录" : data.error || `NAS 请求失败（${response.status}）`);
    return data as T;
}
export function cancelNasTask(id: string) { return json<{ task: NasTask }>(`/${encodeURIComponent(id)}/cancel`, {}); }
async function waitTask(task: NasTask, signal?: AbortSignal, onDelta?: (text: string) => void): Promise<NasTask> {
    if (signal?.aborted) { await cancelNasTask(task.id); throw new DOMException("已取消生成", "AbortError"); }
    if (terminal(task)) return task;
    return new Promise((resolve, reject) => {
        const approvals = new Set<string>();
        const source = new EventSource(`${base}/${encodeURIComponent(task.id)}/events`);
        const close = () => { source.close(); signal?.removeEventListener("abort", abort); };
        const abort = () => { close(); void cancelNasTask(task.id).catch(() => undefined); reject(new DOMException("已取消生成", "AbortError")); };
        signal?.addEventListener("abort", abort, { once: true });
        source.addEventListener("task", (event) => {
            const next = (JSON.parse((event as MessageEvent).data) as { task: NasTask }).task;
            window.dispatchEvent(new CustomEvent("nas-generation-task", { detail: next }));
            if (next.approval && !approvals.has(next.approval.requestId)) {
                approvals.add(next.approval.requestId);
                window.dispatchEvent(new CustomEvent("nas-generation-approval", { detail: { task: next } }));
            }
            if (next.text) onDelta?.(next.text);
            if (terminal(next)) { close(); resolve(next); }
        });
        source.onerror = () => { close(); reject(new Error("生成连接已断开，任务保留在 NAS；重新打开当前页面可接收已有结果，请勿重复提交")); };
    });
}
async function receive(delivery: NasDelivery, signal?: AbortSignal, onDelta?: (text: string) => void) {
    if (!delivery.task) return delivery;
    const task = await waitTask(delivery.task, signal, onDelta);
    delivery.task = task;
    await deliveries.setItem(delivery.requestId, delivery);
    if (task.status === "cancelled") throw new DOMException("已取消生成", "AbortError");
    if (task.status !== "succeeded") throw new Error(task.error || (task.status === "interrupted" ? "NAS 任务已中断，需确认后重新生成" : "Codex 生成失败"));
    if (task.kind === "text") delivery.text = task.text || "";
    else {
        const images = (await Promise.all((delivery.images || []).map(async (image) => ({ ...image, url: await resolveImageUrl(image.storageKey, "") })))).filter((image) => Boolean(image.url));
        for (const artifact of task.artifacts) {
            if (images.some((image) => image.id === artifact.id)) continue;
            const response = await fetch(`${base}/${encodeURIComponent(task.id)}/artifacts/${encodeURIComponent(artifact.id)}`, { signal });
            if (!response.ok) throw new Error("图片已生成，但 NAS 产物读取失败；请重新接收结果");
            const blob = await response.blob();
            const url = URL.createObjectURL(blob);
            try { images.push({ ...await uploadImage(url), id: artifact.id }); }
            finally { URL.revokeObjectURL(url); }
            delivery.images = images;
            await deliveries.setItem(delivery.requestId, delivery);
        }
        delivery.images = images;
        if (!images.length) throw new Error("Codex 未返回可读取的图片产物");
    }
    await deliveries.setItem(delivery.requestId, delivery);
    if (task.kind === "image") useNasStore.setState({ image: { status: "available" } });
    return delivery;
}
async function claimTask(task: NasTask) {
    if (!navigator.locks) throw new Error("当前浏览器无法安全锁定任务接收，请下载已登记产物");
    return new Promise<() => void>((resolve, reject) => {
        void navigator.locks.request(`canvas-nas-task:${task.id}`, { ifAvailable: true }, (lock) => {
            if (!lock) { reject(new Error("任务正在另一个标签页接收，请等待原页面保存或下载产物")); return; }
            return new Promise<void>((release) => resolve(release));
        }).catch(reject);
    });
}
async function completeDelivery(delivery: NasDelivery) {
    const task = delivery.task!;
    // This marker is written only after the consumer has persisted its node/log.
    await deliveries.setItem(`consumed:${task.id}`, true);
    returned.delete(delivery.requestId);
    heldLocks.get(task.id)?.(); heldLocks.delete(task.id);
    await json(`/${encodeURIComponent(task.id)}/ack`, { artifactIds: task.artifacts.map((artifact) => artifact.id) });
    await deliveries.removeItem(delivery.requestId);
}
export function hasNasCanvasDeliveries(canvasId: string) { return [...returned.values()].some((delivery) => delivery.target.canvasId === canvasId); }
export async function commitNasCanvasDeliveries(canvasId: string, nodes: CanvasNodeData[]) {
    for (const delivery of returned.values()) {
        if (delivery.target.canvasId !== canvasId || !delivery.target.nodeId) continue;
        const latest = await deliveries.getItem<string>(targetKey(delivery.target));
        if (latest && latest !== delivery.requestId) {
            returned.delete(delivery.requestId); heldLocks.get(delivery.task!.id)?.(); heldLocks.delete(delivery.task!.id);
            continue;
        }
        const node = nodes.find((node) => node.id === delivery.target.nodeId);
        if (!node) continue;
        const slot = delivery.target.slotId;
        const image = delivery.images?.[0];
        const imageSlot = slot ? node.metadata?.images?.find((item) => item.id === slot) : undefined;
        const textSlot = slot ? node.metadata?.texts?.find((item) => item.id === slot) : undefined;
        const savedImage = imageSlot || (!slot ? node.metadata : undefined);
        const savedText = textSlot || (!slot ? node.metadata : undefined);
        const matches = image ? savedImage?.status === "success" && savedImage.storageKey === image.storageKey : savedText?.status === "success" && savedText.content === delivery.text;
        if (matches) await completeDelivery(delivery);
    }
}
export async function commitNasWorkbenchDeliveries(images: Array<{ storageKey?: string }>) {
    for (const delivery of returned.values()) {
        if (delivery.target.kind !== "workbench" || !delivery.images?.length) continue;
        if (delivery.images.every((image) => image.storageKey && images.some((saved) => saved.storageKey === image.storageKey))) await completeDelivery(delivery);
    }
}
export async function requestNasGeneration(input: { kind: "text" | "image"; prompt: string; model: string; referenceImages?: string[]; messages?: AiTextMessage[] }, options?: { signal?: AbortSignal; onDelta?: (text: string) => void; target?: Partial<NasTarget> }) {
    const boundTarget = options?.signal && targets.get(options.signal);
    await prepareIdentity();
    const target = { ...(boundTarget ? { ...boundTarget, pageId: nasTarget(boundTarget.kind).pageId } : nasTarget("workbench")), ...options?.target };
    if (options?.signal?.aborted) throw new DOMException("已取消生成", "AbortError");
    const requestId = crypto.randomUUID();
    const delivery: NasDelivery = { requestId, target };
    await deliveries.setItem(requestId, delivery);
    await deliveries.setItem(targetKey(target), requestId);
    active.add(requestId);
    let release: (() => void) | undefined;
    try {
        const { task } = await json<{ task: NasTask }>("", { ...input, target, requestId });
        delivery.task = task;
        window.dispatchEvent(new CustomEvent("nas-generation-task", { detail: task }));
        await deliveries.setItem(requestId, delivery);
        release = await claimTask(task);
        const received = await receive(delivery, options?.signal, options?.onDelta);
        if (await deliveries.getItem<string>(targetKey(target)) !== requestId) throw new DOMException("原目标已有更新的生成任务，旧结果保留待接收", "AbortError");
        if (target.canvasId && decodeURIComponent(window.location.pathname) !== `/canvas/${target.canvasId}`) throw new DOMException("已离开原画布，结果保留待接收", "AbortError");
        returned.set(requestId, received);
        heldLocks.set(task.id, release); release = undefined;
        return received;
    } finally { release?.(); active.delete(requestId); }
}
async function restoreTask(task: NasTask, consume: (delivery: NasDelivery) => Promise<boolean>) {
    if (active.has(task.requestId)) return;
    active.add(task.requestId);
    let release: (() => void) | undefined;
    try {
        release = await claimTask(task);
        if (await deliveries.getItem<boolean>(`consumed:${task.id}`)) {
            if (!task.acknowledged) await json(`/${encodeURIComponent(task.id)}/ack`, { artifactIds: task.artifacts.map((artifact) => artifact.id) });
            await deliveries.removeItem(task.requestId);
            return;
        }
        const latest = await deliveries.getItem<string>(targetKey(task.target));
        if (latest && latest !== task.requestId) throw new Error("原目标已有更新的任务，不能覆盖；请下载本任务已登记产物");
        const stored = await deliveries.getItem<NasDelivery>(task.requestId);
        const delivery = stored || { task, requestId: task.requestId, target: task.target };
        delivery.task = task;
        const result = await receive(delivery);
        // Recheck after asynchronous delivery; another page may have submitted a newer task.
        const current = await deliveries.getItem<string>(targetKey(task.target));
        if (current && current !== task.requestId) throw new Error("原目标已有更新的任务，结果保留供下载");
        if (await consume(result)) await completeDelivery(result);
    } finally { release?.(); active.delete(task.requestId); }
}
export async function recoverNasTask(id: string, kinds: NasTarget["kind"][], canvasId: string | undefined, consume: (delivery: NasDelivery) => Promise<boolean>) {
    const target = await createNasTarget(kinds[0]);
    const { task } = await json<{ task: NasTask }>(`/${encodeURIComponent(id)}`);
    if (task.target.clientId !== target.clientId || !kinds.includes(task.target.kind) || task.target.canvasId !== canvasId) throw new Error("任务不属于当前设备或原目标，请在 NAS 任务面板打开正确目标或下载产物");
    if (task.status !== "succeeded") throw new Error("任务尚未成功，请先核对状态；恢复不会重新生成");
    if (await deliveries.getItem<boolean>(`consumed:${task.id}`)) throw new Error("该任务已保存，未重复导入；如需文件请下载已登记产物");
    await restoreTask(task, consume);
}
export async function recoverNasDeliveries(kind: NasTarget["kind"], canvasId: string | undefined, consume: (delivery: NasDelivery) => Promise<boolean>) {
    if (!NAS_MODE) return;
    await prepareIdentity();
    const target = nasTarget(kind, { canvasId });
    const { tasks } = await json<{ tasks: NasTask[] }>(`?clientId=${encodeURIComponent(target.clientId)}&pageId=${encodeURIComponent(target.pageId)}${canvasId ? `&canvasId=${encodeURIComponent(canvasId)}` : ""}`);
    await Promise.all(tasks.filter((task) => task.target.kind === kind && task.target.canvasId === canvasId && !["cancelled", "failed", "interrupted"].includes(task.status)).map((task) => restoreTask(task, consume).catch((error: unknown) => window.dispatchEvent(new CustomEvent("nas-generation-error", { detail: error instanceof Error ? error.message : "NAS 任务交付失败" })))));
}
export async function nasImages(delivery: NasDelivery) {
    return Promise.all((delivery.images || []).map(async (image) => ({ id: image.id, dataUrl: reuseStoredImage({ ...image, url: await resolveImageUrl(image.storageKey, image.url) }).url })));
}

export function approveNasTask(task: NasTask, decision: "accept" | "decline") { return json(`/${encodeURIComponent(task.id)}/approval`, { requestId: task.approval?.requestId, decision }); }

export function reconcileNasTask(id: string) { return json<{ task: NasTask }>(`/${encodeURIComponent(id)}/reconcile`, {}); }

export async function listNasTasks() {
    await prepareIdentity();
    const target = nasTarget("workbench");
    return json<{ tasks: NasTask[] }>(`?clientId=${encodeURIComponent(target.clientId)}`);
}

export async function createNasTarget(kind: NasTarget["kind"], extra: Partial<NasTarget> = {}) { await prepareIdentity(); return nasTarget(kind, extra); }

export async function reconcileNasConversations() {
    const target = await createNasTarget("workbench");
    const response = await fetch("/api/agent/generation/reconcile", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientId: target.clientId }) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "侧栏生成历史核对失败");
    return result as { tasks: NasTask[] };
}

export function nasTaskTargetUrl(task: NasTask) {
    const path = task.target.canvasId ? `/canvas/${encodeURIComponent(task.target.canvasId)}` : "/image";
    return `${path}?nasTask=${encodeURIComponent(task.id)}`;
}
export async function logoutNas() {
    const response = await fetch("/api/logout", { method: "POST" });
    if (!response.ok) throw new Error("退出登录失败，请重试");
    window.location.assign("/login");
}
