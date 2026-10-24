import type { CodexReasoningEffort } from "../agent/codex-protocol.js";

export type GenerationTarget = { clientId: string; pageId: string; kind: "canvas" | "workbench" | "plugin"; canvasId?: string; nodeId?: string; slotId?: string };
export type GenerationInput = { requestId: string; kind: "text" | "image"; prompt: string; model?: string; effort?: CodexReasoningEffort; target: GenerationTarget; referenceImages?: string[] };
export type GenerationArtifact = { id: string; itemId: string; mimeType: string; acknowledged: boolean };
export type GenerationTask = { id: string; requestId: string; kind: "text" | "image"; target: GenerationTarget; status: "queued" | "running" | "approval" | "succeeded" | "failed" | "cancelled" | "interrupted"; text: string; artifacts: GenerationArtifact[]; acknowledged: boolean; threadId?: string; turnId?: string; error?: string; approval?: { requestId: string; method: string } };
export type StoredTask = GenerationTask & { version: 1; conversation?: true; input: GenerationInput; files: Record<string, string>; items: Record<string, string> };
export const terminalTask = (task: GenerationTask) => ["succeeded", "failed", "cancelled", "interrupted"].includes(task.status);
export function publicTask({ version: _version, conversation: _conversation, input: _input, files: _files, items: _items, ...task }: StoredTask): GenerationTask { return structuredClone(task); }



