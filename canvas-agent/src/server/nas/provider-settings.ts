import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { audioDestination, type AudioProvider } from "./audio.js";

const providerSchema = z.object({ endpoint: z.string().trim().min(1), model: z.string().trim().min(1), key: z.string().trim().min(1), useProxy: z.boolean() }).strict();
const fileSchema = z.object({ version: z.literal(1), audio: providerSchema.optional(), video: providerSchema.optional() }).strict();
const inputSchema = providerSchema.omit({ key: true }).extend({ apiKey: z.string().trim().min(1).optional() }).strict();
type ProviderFile = z.infer<typeof fileSchema>;
export type ProviderKind = "audio" | "video";

export class ProviderSettingsError extends Error {}

/** NAS-only credentials. Writes are serialized and atomically replace a validated file. */
export class NasProviderSettings {
    private pending: Promise<unknown> = Promise.resolve();
    private constructor(private file: string, private data: ProviderFile, private defaults: { audio?: AudioProvider; proxy?: string }) {}

    static async open(directory: string, defaults: { audio?: AudioProvider; proxy?: string } = {}) {
        await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        await fs.chmod(directory, 0o700);
        const file = path.join(directory, "provider-config.json");
        const data = await readConfig(file);
        if (data) await fs.chmod(file, 0o600);
        return new NasProviderSettings(file, data || { version: 1 }, defaults);
    }

    private config(kind: ProviderKind) {
        const saved = this.data[kind];
        if (saved) return saved;
        const initial = kind === "audio" ? this.defaults.audio : undefined;
        return initial ? { endpoint: initial.endpoint, model: initial.model, key: initial.key, useProxy: Boolean(initial.proxy) } : undefined;
    }

    getProvider(kind: ProviderKind): AudioProvider | undefined {
        const value = this.config(kind);
        const proxy = this.defaults.proxy || this.defaults.audio?.proxy;
        if (!value || (value.useProxy && !proxy)) return undefined;
        return { endpoint: value.endpoint, model: value.model, key: value.key, ...(value.useProxy ? { proxy } : {}) };
    }

    snapshot() {
        const describe = (kind: ProviderKind) => {
            const value = this.config(kind);
            return { endpoint: value?.endpoint || "", model: value?.model || "", hasKey: Boolean(value?.key), useProxy: value?.useProxy ?? true, configured: Boolean(this.getProvider(kind)) };
        };
        return { audio: describe("audio"), video: describe("video"), proxyAvailable: Boolean(this.defaults.proxy || this.defaults.audio?.proxy) };
    }

    update(kind: ProviderKind, input: unknown) {
        const operation = this.pending.then(async () => {
            const parsed = inputSchema.safeParse(input);
            if (!parsed.success) throw new ProviderSettingsError("供应商配置参数无效");
            const { endpoint, model, apiKey, useProxy } = parsed.data;
            if (useProxy && !this.snapshot().proxyAvailable) throw new ProviderSettingsError("NAS 出站代理未配置，请配置代理或明确关闭使用代理；不会自动直连");
            try { await audioDestination(endpoint); } catch { throw new ProviderSettingsError("供应商地址必须是无凭据、查询参数和片段的公网 HTTPS 地址"); }
            // Check disk on every write, so externally corrupted/unknown files cannot be overwritten.
            const current = await readConfig(this.file) || { version: 1 as const };
            const key = apiKey ?? current[kind]?.key ?? this.config(kind)?.key;
            if (!key) throw new ProviderSettingsError("首次配置供应商必须填写 API Key");
            const next: ProviderFile = { ...current, [kind]: { endpoint, model, key, useProxy } };
            const temporary = `${this.file}.${randomUUID()}.tmp`;
            try {
                await fs.writeFile(temporary, JSON.stringify(next), { flag: "wx", mode: 0o600 });
                await fs.rename(temporary, this.file);
            } finally { await fs.rm(temporary, { force: true }); }
            this.data = next;
            return this.snapshot();
        });
        this.pending = operation.catch(() => {});
        return operation;
    }
}

async function readConfig(file: string): Promise<ProviderFile | undefined> {
    try { return fileSchema.parse(JSON.parse(await fs.readFile(file, "utf8"))); }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw new Error("供应商配置文件格式无效，请保留原文件后检查");
    }
}
