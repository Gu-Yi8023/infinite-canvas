import { Router, type Response } from "express";
import { z } from "zod";
import { GenerationService } from "./service.js";
import { terminalTask, type GenerationTask } from "./types.js";

export const targetSchema = z.object({ clientId: z.string().min(1), pageId: z.string().min(1), kind: z.enum(["canvas", "workbench", "plugin"]), canvasId: z.string().optional(), nodeId: z.string().optional(), slotId: z.string().optional() }).strict();
const inputSchema = z.object({ requestId: z.string().min(1), kind: z.enum(["text", "image"]), prompt: z.string().trim().min(1), model: z.string().optional(), effort: z.enum(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]).optional(), target: targetSchema, referenceImages: z.array(z.string()).optional() }).strict();

/** 在已有内部鉴权之后挂载到 /generation；外部入口代理不接收绝对文件路径。 */
export function createGenerationRouter(service: GenerationService) {
    const router = Router();
    const error = (res: Response) => res.status(400).json({ ok: false, error: "生成请求无效或任务/产物当前不可用" });
    router.post("/reconcile", async (req, res) => {
        try {
            const filter = targetSchema.partial().parse(req.body);
            if (!filter.clientId) return error(res);
            res.json({ tasks: await service.reconcileConversations(filter) });
        } catch { error(res); }
    });
    router.get("/capabilities", async (_req, res) => {
        try { res.json(await service.capabilities()); } catch { error(res); }
    });
    router.post("/tasks", async (req, res) => {
        try { res.json({ task: await service.create(inputSchema.parse(req.body)) }); } catch { error(res); }
    });
    router.get("/tasks", async (req, res) => {
        try {
            const filter = targetSchema.partial().parse(req.query);
            if (!filter.clientId) return error(res);
            res.json({ tasks: await service.list(filter) });
        } catch { error(res); }
    });
    router.get("/tasks/:id", async (req, res) => {
        try { res.json({ task: await service.get(req.params.id) }); } catch { error(res); }
    });
    router.post("/tasks/:id/reconcile", async (req, res) => {
        try { res.json({ task: await service.reconcile(req.params.id) }); } catch { error(res); }
    });
    router.post("/tasks/:id/cancel", async (req, res) => {
        try { res.json({ task: await service.cancel(req.params.id) }); } catch { error(res); }
    });
    router.post("/tasks/:id/approval", async (req, res) => {
        try {
            const input = z.object({ requestId: z.string(), decision: z.enum(["accept", "decline", "cancel"]) }).strict().parse(req.body);
            res.json({ task: await service.approval(req.params.id, input.requestId, input.decision) });
        } catch { error(res); }
    });
    router.post("/tasks/:id/ack", async (req, res) => {
        try { res.json({ task: await service.ack(req.params.id, z.object({ artifactIds: z.array(z.string()) }).strict().parse(req.body).artifactIds) }); } catch { error(res); }
    });
    router.get("/tasks/:id/artifacts/:artifactId", async (req, res) => {
        try {
            const artifact = await service.artifact(req.params.id, req.params.artifactId);
            res.set({ "Content-Type": artifact.mimeType, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }).send(artifact.bytes);
        } catch { error(res); }
    });
    router.get("/tasks/:id/events", async (req, res) => {
        let unsubscribe: (() => void) | undefined;
        try {
            await service.get(req.params.id);
            res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
            res.flushHeaders();
            const send = (task: GenerationTask) => {
                res.write(`event: task\ndata: ${JSON.stringify({ task })}\n\n`);
                if (terminalTask(task)) { unsubscribe?.(); res.end(); }
            };
            unsubscribe = service.subscribe(req.params.id, send);
            req.on("close", () => unsubscribe?.());
            send(await service.get(req.params.id));
        } catch { if (!res.headersSent) error(res); else res.end(); }
    });
    return router;
}






