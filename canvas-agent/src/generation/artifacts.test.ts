import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { imageOutputPaths, importGeneratedImage, registeredImage } from "./artifacts.js";
import { assertNasToolAllowed } from "./tool-policy.js";

test("image output extraction accepts only explicit output savedPath", () => {
    assert.deepEqual(imageOutputPaths({ type: "image_generation", savedPath: "C:\\产物 空格\\image.png", prompt: "/reference.png", result: { path: "/other.png" } }), ["C:\\产物 空格\\image.png"]);
    assert.deepEqual(imageOutputPaths({ type: "agent_message", savedPath: "/reference.png" }), []);
    assert.deepEqual(imageOutputPaths({ type: "image_generation", images: ["/reference.png"] }), []);
});

test("registered outputs reject traversal, symlink escape, and disguised files", async () => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-generation-test-"));
    try {
        const task = path.join(temporary, "task");
        await fs.mkdir(task);
        const image = path.join(task, "中文 空格.png");
        await fs.writeFile(image, Buffer.from([137,80,78,71,13,10,26,10]));
        assert.equal((await registeredImage(task, image)).mimeType, "image/png");
        const outside = path.join(temporary, "outside.png");
        await fs.copyFile(image, outside);
        await assert.rejects(registeredImage(task, outside));
        await fs.writeFile(path.join(task, "fake.png"), "credentials");
        await assert.rejects(registeredImage(task, path.join(task, "fake.png")));
        await assert.rejects(registeredImage(task, "../outside.png"));
        if (process.platform !== "win32") {
            const link = path.join(task, "escape.png");
            await fs.symlink(outside, link);
            await assert.rejects(registeredImage(task, link));
        }
    } finally { await fs.rm(temporary, { recursive: true, force: true }); }
});

test("native imports validate the fixed root and reuse only identical exclusive destinations", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-native-import-test-"));
    const previous = process.env.CODEX_HOME;
    process.env.CODEX_HOME = path.join(directory, "codex");
    const native = path.join(process.env.CODEX_HOME, "generated_images");
    const task = path.join(directory, "task");
    const bytes = Buffer.from([137,80,78,71,13,10,26,10]);
    try {
        await fs.mkdir(native, { recursive: true }); await fs.mkdir(task);
        const candidate = path.join(native, "native.png"); await fs.writeFile(candidate, bytes);
        const imported = await importGeneratedImage(task, candidate);
        assert.equal(path.dirname(imported.file), await fs.realpath(task));
        assert.deepEqual(imported.bytes, bytes);
        assert.equal((await importGeneratedImage(task, candidate)).file, imported.file);
        for (const outside of [path.join(process.env.CODEX_HOME, "auth.png"), path.join(directory, "outside.png")]) {
            await fs.writeFile(outside, bytes);
            await assert.rejects(importGeneratedImage(task, outside), /超出任务目录/);
        }
        await fs.writeFile(path.join(native, "fake.png"), "credentials");
        await assert.rejects(importGeneratedImage(task, path.join(native, "fake.png")), /内容与图片类型不符/);
        await fs.writeFile(path.join(task, "reference-0.png"), bytes);
        await assert.rejects(importGeneratedImage(task, path.join(task, "reference-0.png")), /参考图/);
        const outsideDirectory = path.join(directory, "outside"); await fs.mkdir(outsideDirectory);
        await fs.writeFile(path.join(outsideDirectory, "escape.png"), bytes);
        await fs.symlink(outsideDirectory, path.join(native, "escape"), process.platform === "win32" ? "junction" : "dir");
        await assert.rejects(importGeneratedImage(task, path.join(native, "escape", "escape.png")), /超出任务目录/);
        const conflicting = Buffer.concat([bytes, Buffer.from("different")]);
        await fs.writeFile(imported.file, conflicting);
        await assert.rejects(importGeneratedImage(task, candidate), /冲突内容/);
        assert.deepEqual(await fs.readFile(imported.file), conflicting);
        if (process.platform !== "win32") {
            await fs.unlink(imported.file); await fs.symlink(candidate, imported.file);
            await assert.rejects(importGeneratedImage(task, candidate), /符号链接/);
        }
        await fs.rename(native, `${native}-original`);
        await fs.symlink(outsideDirectory, native, process.platform === "win32" ? "junction" : "dir");
        await assert.rejects(importGeneratedImage(task, path.join(native, "escape.png")), /原生图片目录不能重定向/);
    } finally {
        if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous;
        await fs.rm(directory, { recursive: true, force: true });
    }
});

test("NAS rejects recursive generation in direct and batch tools, retaining audio", () => {
    const previous = process.env.NAS_MODE;
    process.env.NAS_MODE = "true";
    try {
        assert.throws(() => assertNasToolAllowed("canvas_generate_text", {}));
        assert.throws(() => assertNasToolAllowed("workbench_image_generate", {}));
        assert.throws(() => assertNasToolAllowed("canvas_apply_ops", { ops: [{ type: "run_generation", mode: "image" }] }));
        assert.throws(() => assertNasToolAllowed("canvas_create_config_node", { autoRun: true }));
        assert.doesNotThrow(() => assertNasToolAllowed("canvas_generate_audio", {}));
        assert.doesNotThrow(() => assertNasToolAllowed("canvas_run_generation", { mode: "audio" }));
    } finally { if (previous === undefined) delete process.env.NAS_MODE; else process.env.NAS_MODE = previous; }
});
