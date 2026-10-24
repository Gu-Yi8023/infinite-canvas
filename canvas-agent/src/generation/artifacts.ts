import { constants } from "node:fs";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const imageTypes: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };
export async function registeredImage(directory: string, candidate: string) {
    if (!path.isAbsolute(candidate)) throw new Error("产物路径不是绝对路径");
    const root = await fs.realpath(directory);
    const file = await fs.realpath(candidate);
    assertInside(root, file);
    const mimeType = imageTypes[path.extname(file).toLowerCase()];
    if (!mimeType) throw new Error("产物不是支持的图片文件");
    const handle = await fs.open(file, constants.O_RDONLY | (process.platform === "linux" ? constants.O_NOFOLLOW : 0));
    try {
        const opened = await handle.stat();
        if (!opened.isFile()) throw new Error("产物不是支持的图片文件");
        // Linux verifies the opened inode's actual path, including swapped parent symlinks.
        if (process.platform === "linux") assertInside(root, await fs.realpath(`/proc/self/fd/${handle.fd}`));
        const currentPath = await fs.realpath(file);
        assertInside(root, currentPath);
        const current = await fs.stat(currentPath);
        if (opened.dev !== current.dev || opened.ino !== current.ino) throw new Error("产物文件在读取前已被替换");
        const bytes = await handle.readFile();
        const header = bytes.subarray(0, 12);
        const valid = mimeType === "image/png" ? header.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
            : mimeType === "image/jpeg" ? header[0] === 255 && header[1] === 216 && header[2] === 255
            : mimeType === "image/gif" ? /^GIF8[79]a/.test(header.toString("ascii"))
            : header.toString("ascii", 0, 4) === "RIFF" && header.toString("ascii", 8, 12) === "WEBP";
        if (!valid) throw new Error("产物文件内容与图片类型不符");
        return { file, mimeType, bytes };
    } finally { await handle.close(); }
}

/** 仅供已匹配 thread/turn 的 imageGeneration.savedPath 导入；不扫描目录或文本。 */
export async function importGeneratedImage(directory: string, candidate: string, workspace = directory) {
    if (!path.isAbsolute(candidate)) throw new Error("产物路径不是绝对路径");
    const home = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
    const native = path.join(home, "generated_images");
    let sourceDirectory = workspace;
    if (isInside(native, candidate)) {
        const expected = path.join(await fs.realpath(home), "generated_images");
        if (path.relative(expected, await fs.realpath(native))) throw new Error("原生图片目录不能重定向到其他目录");
        sourceDirectory = native;
    }
    const source = await registeredImage(sourceDirectory, candidate);
    if (path.basename(source.file).startsWith("reference-")) throw new Error("参考图不能作为生成产物");
    const root = await fs.realpath(directory);
    if (isInside(root, source.file)) return source;
    const destination = path.join(root, `imported-${createHash("sha256").update(source.file).digest("hex")}${path.extname(source.file)}`);
    try { await fs.writeFile(destination, source.bytes, { flag: "wx", mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    if ((await fs.lstat(destination)).isSymbolicLink()) throw new Error("产物导入位置不能是符号链接");
    const registered = await registeredImage(root, destination);
    if (path.relative(destination, registered.file) || !registered.bytes.equals(source.bytes)) throw new Error("产物导入位置已有冲突内容");
    return registered;
}

function isInside(root: string, file: string) {
    const relative = path.relative(root, file);
    return Boolean(relative && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
function assertInside(root: string, file: string) {
    if (!isInside(root, file)) throw new Error("产物路径超出任务目录");
}

/** 只读取 imageGeneration 的明确输出字段，禁止扫描提示词、参考图和任意嵌套字符串。 */
export function imageOutputPaths(item: Record<string, unknown>): string[] {
    if (item.type !== "image_generation" && item.type !== "imageGeneration") return [];
    return typeof item.savedPath === "string" && item.savedPath ? [item.savedPath] : [];
}
