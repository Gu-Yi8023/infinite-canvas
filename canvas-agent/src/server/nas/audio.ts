import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Request, Response } from "express";
import ipaddr from "ipaddr.js";
import { Agent, ProxyAgent, request } from "undici";
import { z } from "zod";

export type AudioProvider = { endpoint: string; model: string; key: string; proxy?: string };
const speechInput = z.object({
    input: z.string().trim().min(1), model: z.string().optional(), voice: z.string().optional(),
    response_format: z.enum(["mp3", "opus", "aac", "flac", "wav", "pcm"]).optional(),
    speed: z.number().finite().optional(), instructions: z.string().optional(),
}).strict();

export function isPublicAddress(address: string) {
    try { return ipaddr.process(address).range() === "unicast"; } catch { return false; }
}

/** Resolve and pin the public target before connecting, including CONNECT through OpenClash. */
export async function audioDestination(endpoint: string) {
    const url = new URL(endpoint);
    if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search) throw new Error("音频服务地址必须是无凭据和查询参数的 HTTPS 地址");
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const records = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await lookup(hostname, { all: true });
    if (!records.length || records.some(({ address }) => !isPublicAddress(address))) throw new Error("音频服务不能指向本机或内网地址");
    const address = records[0].address;
    const pinned = new URL(url);
    pinned.hostname = address.includes(":") ? `[${address}]` : address;
    return { url: pinned, host: url.host, servername: isIP(hostname) ? undefined : hostname };
}

export async function sendSpeech(req: Request, res: Response, provider?: AudioProvider) {
    if (!provider) return void res.status(503).json({ ok: false, code: "AUDIO_NOT_CONFIGURED", error: "音频 API 尚未配置" });
    const parsed = speechInput.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ ok: false, error: "音频生成参数无效" });
    if (parsed.data.model && parsed.data.model !== provider.model) return void res.status(400).json({ ok: false, error: "音频模型与服务端配置不一致" });
    const target = await audioDestination(provider.endpoint);
    const tls = { servername: target.servername, rejectUnauthorized: true };
    const dispatcher = provider.proxy ? new ProxyAgent({ uri: provider.proxy, requestTls: tls }) : new Agent({ connect: tls });
    const controller = new AbortController();
    const abort = () => { if (!res.writableEnded) controller.abort(); };
    res.once("close", abort);
    try {
        const upstream = await request(target.url, {
            method: "POST", dispatcher, signal: controller.signal,
            headers: { host: target.host, authorization: `Bearer ${provider.key}`, "content-type": "application/json" },
            body: JSON.stringify({ ...parsed.data, model: provider.model }),
        });
        if (upstream.statusCode < 200 || upstream.statusCode >= 300) {
            upstream.body.destroy();
            return void res.status(502).json({ ok: false, code: "AUDIO_UPSTREAM_ERROR", error: `音频服务返回 HTTP ${upstream.statusCode}` });
        }
        const contentType = String(upstream.headers["content-type"] || "");
        if (!contentType.startsWith("audio/") && !contentType.startsWith("application/octet-stream")) {
            upstream.body.destroy();
            return void res.status(502).json({ ok: false, error: "音频服务未返回音频文件" });
        }
        res.setHeader("Content-Type", contentType);
        res.setHeader("Cache-Control", "no-store");
        await pipeline(Readable.from(upstream.body), res);
    } finally {
        res.off("close", abort);
        await dispatcher.close();
    }
}
