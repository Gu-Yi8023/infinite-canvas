import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Request, Response } from "express";
import { JSONFile } from "lowdb/node";
import { Agent, FormData, ProxyAgent, request } from "undici";
import { z } from "zod";
import { audioDestination, type AudioProvider } from "./audio.js";

export type VideoProvider = AudioProvider;
const media = (kind: string) => z.string().regex(new RegExp(`^data:${kind}/[a-zA-Z0-9.+-]+;base64,(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$`));
const input = z.object({
    prompt: z.string().trim().min(1), seconds: z.string().optional(), size: z.string().optional(),
    ratio: z.string().optional(), resolution_name: z.string().optional(), generate_audio: z.boolean().optional(),
    watermark: z.boolean().optional(), mode: z.enum(["frames", "reference"]).optional(),
    images: z.array(media("image")).optional(), videos: z.array(media("video")).optional(), audios: z.array(media("audio")).optional(),
}).strict();
const providerSchema = z.object({ endpoint: z.string(), model: z.string().min(1), key: z.string().min(1), proxy: z.string().optional() }).strict();
const recordSchema = z.object({ version: z.literal(1), remoteId: z.string().regex(/^[A-Za-z0-9_-]+$/), provider: providerSchema }).strict();
type TaskRecord = z.infer<typeof recordSchema>;
const uuid = z.string().uuid();
const statusSchema = z.object({ id: recordSchema.shape.remoteId, status: z.enum(["queued", "in_progress", "completed", "failed", "cancelled"]) });

/** Credentials and upstream task IDs never leave the NAS; immutable records survive config changes. */
export class NasVideoService {
    private constructor(private directory: string, private getProvider: () => VideoProvider | undefined) {}

    static async open(stateDirectory: string, getProvider: () => VideoProvider | undefined) {
        const directory = path.join(stateDirectory, "video-tasks");
        await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        await fs.chmod(directory, 0o700);
        for (const name of await fs.readdir(directory)) {
            // A crashed atomic write stays available for manual recovery, without blocking other tasks.
            if (name.startsWith(".") && name.endsWith(".json.tmp") && uuid.safeParse(name.slice(1, -9)).success) continue;
            if (!name.endsWith(".json") || !uuid.safeParse(name.slice(0, -5)).success) throw new Error("视频任务目录存在未知文件，请保留原文件后检查");
            const file = path.join(directory, name);
            if (!(await fs.lstat(file)).isFile() || !recordSchema.safeParse(JSON.parse(await fs.readFile(file, "utf8"))).success) throw new Error("视频任务记录无效，请保留原文件后检查");
            await fs.chmod(file, 0o600);
        }
        return new NasVideoService(directory, getProvider);
    }

    async create(req: Request, res: Response) {
        const configured = this.getProvider();
        if (!configured) return void res.status(503).json({ code: "VIDEO_NOT_CONFIGURED", error: "视频 API 尚未配置" });
        const provider = structuredClone(configured);
        const parsed = input.safeParse(req.body);
        if (!parsed.success) return void res.status(400).json({ error: "视频生成参数无效" });
        try {
            const { images = [], videos = [], audios = [], ...fields } = parsed.data;
            const body = new FormData();
            body.append("model", provider.model);
            for (const [key, value] of Object.entries(fields)) if (value !== undefined) body.append(key, String(value));
            const append = (key: string, value: string, name: string) => {
                const comma = value.indexOf(",");
                body.append(key, new Blob([Buffer.from(value.slice(comma + 1), "base64")], { type: value.slice(5, value.indexOf(";")) }), name);
            };
            images.forEach((value, index) => {
                if (fields.mode === "frames") {
                    if (index < 2) { append(index ? "last_frame" : "first_frame", value, index ? "last.png" : "first.png"); append("images", value, `ref_${index + 1}.png`); }
                } else { append("image[]", value, `ref_${index + 1}.png`); append("images", value, `ref_${index + 1}.png`); }
            });
            videos.forEach((value) => append("video[]", value, "ref.mp4"));
            audios.forEach((value) => append("audio[]", value, "ref.mp3"));
            await this.upstream(provider, "", "POST", body, res, async (upstream) => {
                const result = statusSchema.parse(await upstream.body.json());
                const id = randomUUID();
                const file = path.join(this.directory, `${id}.json`);
                // Pre-create lowdb's temporary file privately before its atomic rename.
                await fs.writeFile(path.join(this.directory, `.${id}.json.tmp`), "", { flag: "wx", mode: 0o600 });
                await new JSONFile<TaskRecord>(file).write({ version: 1, remoteId: result.id, provider: structuredClone(provider) });
                res.setHeader("Cache-Control", "no-store");
                res.json({ id, status: result.status });
            });
        } catch { this.failure(res); }
    }

    async poll(req: Request, res: Response) { await this.read(req, res, false); }
    async content(req: Request, res: Response) { await this.read(req, res, true); }

    private async read(req: Request, res: Response, content: boolean) {
        if (!uuid.safeParse(req.params.id).success) return void res.status(400).json({ error: "视频任务 ID 无效" });
        try {
            const file = path.join(this.directory, `${req.params.id}.json`);
            if (!(await fs.lstat(file)).isFile()) throw new Error("invalid task");
            const task = recordSchema.parse(JSON.parse(await fs.readFile(file, "utf8")));
            await this.upstream(task.provider, `/${encodeURIComponent(task.remoteId)}${content ? "/content" : ""}`, "GET", undefined, res, async (upstream) => {
                res.setHeader("Cache-Control", "no-store");
                if (!content) {
                    const result = statusSchema.parse(await upstream.body.json());
                    res.json({ id: req.params.id, status: result.status });
                    return;
                }
                const type = String(upstream.headers["content-type"] || "").split(";")[0].trim();
                if (!/^video\/[a-zA-Z0-9.+-]+$/.test(type)) { upstream.body.destroy(); throw new Error("invalid video"); }
                res.setHeader("Content-Type", type);
                await pipeline(Readable.from(upstream.body), res);
            });
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") { res.status(404).json({ error: "视频任务不存在" }); return; }
            this.failure(res);
        }
    }

    private failure(res: Response) {
        if (!res.headersSent) res.status(502).json({ code: "VIDEO_UPSTREAM_ERROR", error: "视频服务请求失败" });
        else if (!res.writableEnded) res.destroy();
    }

    private async upstream(provider: VideoProvider, suffix: string, method: "GET" | "POST", body: FormData | undefined, res: Response, consume: (response: Awaited<ReturnType<typeof request>>) => Promise<void>) {
        const target = await audioDestination(provider.endpoint.replace(/\/+$/, "") + suffix);
        const tls = { servername: target.servername, rejectUnauthorized: true };
        const dispatcher = provider.proxy ? new ProxyAgent({ uri: provider.proxy, requestTls: tls }) : new Agent({ connect: tls });
        const controller = new AbortController();
        const abort = () => { if (!res.writableEnded) controller.abort(); };
        res.once("close", abort);
        try {
            const upstream = await request(target.url, { method, body, dispatcher, signal: controller.signal, headers: { host: target.host, authorization: `Bearer ${provider.key}` } });
            if (upstream.statusCode < 200 || upstream.statusCode >= 300) {
                upstream.body.destroy();
                res.status(502).json({ code: "VIDEO_UPSTREAM_ERROR", error: `视频服务返回 HTTP ${upstream.statusCode}` });
                return;
            }
            await consume(upstream);
        } finally { res.off("close", abort); await dispatcher.close(); }
    }
}
