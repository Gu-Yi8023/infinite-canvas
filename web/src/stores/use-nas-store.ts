import { create } from "zustand";
import { NAS_MODE } from "@/constant/runtime-config";
import type { AgentModel } from "./use-agent-store";

type NasState = { image: { status: "unverified" | "available" | "unavailable"; reason?: string }; models: AgentModel[]; audio: { configured: boolean; model: string }; video: { configured: boolean; available: boolean; model: string }; error: string; loaded: boolean };
export const useNasStore = create<NasState>(() => ({ image: { status: "unverified" }, models: [], audio: { configured: false, model: "" }, video: { configured: false, available: false, model: "" }, error: "", loaded: false }));
let loading: Promise<void> | undefined;
export function loadNasCapabilities(refresh = false) {
    if (refresh) loading = undefined;
    if (!NAS_MODE) return Promise.resolve();
    return loading ||= Promise.allSettled([
        fetch("/api/capabilities").then(async (response) => { if (!response.ok) throw new Error("NAS 服务认证或连接失败"); return response.json(); }).then((capabilities) => useNasStore.setState({ audio: capabilities.audio, video: capabilities.video, image: capabilities.codex?.image || { status: "unverified" } })),
        fetch("/api/agent/agent/codex/models").then(async (response) => { if (!response.ok) throw new Error("Codex 模型读取失败，请检查 NAS 登录状态"); return response.json(); }).then((models) => useNasStore.setState({ models: models.data || [] })),
    ]).then((results) => {
        const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
        if (results[0].status === "rejected") useNasStore.setState({ audio: { configured: false, model: "" }, video: { configured: false, available: false, model: "" } });
        if (results[1].status === "rejected") useNasStore.setState({ models: [] });
        useNasStore.setState({ loaded: true, error: failures.map((result) => result.reason instanceof Error ? result.reason.message : "NAS 连接失败").join("；") });
        if (failures.length) loading = undefined;
    });
}
