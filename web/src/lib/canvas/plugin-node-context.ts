import { NAS_MODE } from "@/constant/runtime-config";
import { bindNasGeneration } from "@/services/api/nas-generation";
import { createPluginStorage, emitCanvasEvent, onCanvasEvent } from "@/lib/canvas/canvas-event-bus";
import { getNodePluginId } from "@/lib/canvas/node-registry";
import type { CanvasTheme } from "@/lib/canvas-theme";
import type { CanvasNodeData } from "@/types/canvas";
import type { CanvasNodeContext, CanvasPluginHost } from "@/types/canvas-plugin";

// Assemble host capabilities, node data, theme, and scale into the context injected into plugin nodes.
export function buildNodeContext(host: CanvasPluginHost, node: CanvasNodeData, theme: CanvasTheme, scale: number, isSelected = false): CanvasNodeContext {
    const bindSignal = (signal?: AbortSignal) => {
        const targetSignal = signal || new AbortController().signal;
        const canvasId = decodeURIComponent(window.location.pathname.match(/^\/canvas\/([^/]+)/)?.[1] || "");
        bindNasGeneration(targetSignal, canvasId, node.id);
        return targetSignal;
    };
    const storage = createPluginStorage(getNodePluginId(node.type));
    return {
        node,
        theme,
        scale,
        isSelected,
        updateMetadata: (patch) => host.updateMetadata(node.id, patch),
        updateNode: (patch) => host.updateNode(node.id, patch),
        getNode: (id) => host.getNode(id),
        getNodes: () => host.getNodes(),
        getConnections: () => host.getConnections(),
        getUpstream: () => host.getUpstream(node.id),
        getDownstream: () => host.getDownstream(node.id),
        applyOps: (ops) => host.applyOps(ops),
        emit: (event, payload) => emitCanvasEvent(event, payload),
        on: (event, handler) => onCanvasEvent(event, handler),
        ai: NAS_MODE ? { ...host.ai, generateImage: (prompt, options) => host.ai.generateImage(prompt, { ...options, signal: bindSignal(options?.signal) }), generateText: (prompt, options) => host.ai.generateText(prompt, { ...options, signal: bindSignal(options?.signal) }) } : host.ai,
        openPanel: () => host.openPanel(node.id),
        closePanel: () => host.closePanel(),
        storage,
    };
}
