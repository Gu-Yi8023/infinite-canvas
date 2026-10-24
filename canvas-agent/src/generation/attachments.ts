import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import type { AgentAttachment } from "../agent/types.js";

/** NAS 附件始终写进本轮工作空间，保持原始字节并遵循固定的读权限。 */
export async function writeCodexAttachmentFiles(attachments: AgentAttachment[], cwd?: string) {
    const images = attachments.filter((item) => item.dataUrl?.startsWith("data:image/"));
    if (!images.length) return [];
    const nas = process.env.NAS_MODE === "true";
    if (nas && (!cwd || !path.isAbsolute(cwd))) throw new Error("NAS 图片附件缺少有效工作目录");
    const directory = nas ? await fs.mkdtemp(path.join(await fs.realpath(cwd!), ".canvas-attachments-")) : os.tmpdir();
    const files: string[] = [];
    try {
        for (const image of images) {
            const match = /^data:([^;]+);base64,(.+)$/s.exec(image.dataUrl || "");
            if (!match?.[2]) throw new Error("图片附件内容无效");
            const type = match[1];
            const extension = type.includes("png") ? "png" : type.includes("webp") ? "webp" : type.includes("gif") ? "gif" : "jpg";
            const file = path.join(directory, `${crypto.randomUUID()}.${extension}`);
            await fs.writeFile(file, Buffer.from(match[2], "base64"), { mode: 0o600 });
            files.push(file);
        }
        return files;
    } catch (error) {
        await Promise.all(files.map((file) => fs.unlink(file).catch(() => undefined)));
        if (nas) await fs.rmdir(directory).catch(() => undefined);
        throw error;
    }
}

