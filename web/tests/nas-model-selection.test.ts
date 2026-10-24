import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { beforeEach, mock, test } from "bun:test";
import type { AgentModel } from "../src/stores/use-agent-store";

// Keep NAS runtime configuration isolated from the static deployment tests.
if (process.env.NAS_MODEL_TEST_WORKER !== "1") {
    test("NAS model defaults and persistence in an isolated browser worker", () => {
        const result = spawnSync(process.execPath, ["test", import.meta.path], { cwd: new URL("..", import.meta.url), env: { ...process.env, NAS_MODEL_TEST_WORKER: "1" }, encoding: "utf8" });
        assert.equal(result.status, 0, result.stdout + result.stderr);
    });
} else {
    const values = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
    } });
    Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage } });
    mock.module("../src/constant/runtime-config", () => ({ NAS_MODE: true }));
    const { defaultConfig, useConfigStore, resolveModelForCapability, selectableModelsByCapability } = await import("../src/stores/use-config-store");
    const { useNasStore } = await import("../src/stores/use-nas-store");
    const { buildGenerationConfig } = await import("../src/lib/canvas/canvas-generation-helpers");
    const models = [{ model: "server-default", isDefault: true }, { model: "preferred-image" }, { model: "preferred-text" }] as AgentModel[];
    const config = { ...defaultConfig, imageModel: "preferred-image", textModel: "preferred-text" };
    beforeEach(() => {
        values.clear();
        useConfigStore.setState({ config: defaultConfig });
        useNasStore.setState({ models, audio: { configured: true, model: "nas-tts" }, video: { configured: true, available: true, model: "nas-video" }, loaded: true });
    });

    test("new image and text generation use their configured defaults", () => {
        assert.equal(buildGenerationConfig(config, undefined, "image").model, "preferred-image");
        assert.equal(buildGenerationConfig(config, undefined, "text").model, "preferred-text");
        assert.equal(resolveModelForCapability(config, "server-default", "image"), "server-default");
    });

    test("initial channel defaults fall back to the Codex server default", () => {
        assert.equal(resolveModelForCapability(defaultConfig, undefined, "image"), "server-default");
        assert.equal(resolveModelForCapability(defaultConfig, undefined, "text"), "server-default");
    });

    test("removed Codex defaults remain selected so readiness rejects generation", () => {
        const selected = buildGenerationConfig({ ...config, imageModel: "removed-model" }, undefined, "image");
        assert.equal(selected.model, "removed-model");
        assert.equal(useConfigStore.getState().isAiConfigReady(selected, selected.model), false);
    });

    test("refresh preserves raw Codex IDs even when a channel has the same model", async () => {
        useConfigStore.setState({ config: { ...config, channels: [{ ...defaultConfig.channels[0], models: [{ name: "preferred-image", capability: "image" }, { name: "preferred-text", capability: "text" }] }] } });
        const saved = values.get("infinite-canvas:ai_config_store")!;
        useConfigStore.setState({ config: defaultConfig });
        values.set("infinite-canvas:ai_config_store", saved);
        await useConfigStore.persist.rehydrate();
        assert.equal(useConfigStore.getState().config.imageModel, "preferred-image");
        assert.equal(useConfigStore.getState().config.textModel, "preferred-text");
        assert.equal(buildGenerationConfig(useConfigStore.getState().config, undefined, "image").model, "preferred-image");
    });

    test("available selections follow NAS models and media configuration", () => {
        assert.deepEqual(selectableModelsByCapability(config, "image"), models.map((entry) => entry.model));
        assert.deepEqual(selectableModelsByCapability(config, "audio"), ["nas-tts"]);
        assert.deepEqual(selectableModelsByCapability(config, "video"), ["nas-video"]);
        assert.equal(resolveModelForCapability(config, "old-video", "video"), "nas-video");
        assert.equal(useConfigStore.getState().isAiConfigReady(config, "nas-video"), true);
        useNasStore.setState({ models: [], audio: { configured: false, model: "nas-tts" }, video: { configured: false, available: false, model: "" } });
        assert.deepEqual(selectableModelsByCapability(config, "image"), []);
        assert.deepEqual(selectableModelsByCapability(config, "audio"), []);
        assert.deepEqual(selectableModelsByCapability(config, "video"), []);
        assert.equal(useConfigStore.getState().isAiConfigReady(config, "nas-video"), false);
    });
}
