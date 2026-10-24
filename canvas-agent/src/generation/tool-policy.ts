import type { ToolName } from "../canvas/schemas.js";

/** Codex 工具回调不能再次进入同一串行生成队列。音频由独立适配器执行。 */
export function assertNasToolAllowed(name: ToolName, input: Record<string, unknown>) {
    if (process.env.NAS_MODE !== "true") return;
    if (["canvas_generate_text", "canvas_generate_image", "canvas_generate_video", "workbench_image_generate", "workbench_video_generate"].includes(name)) throw new Error("Codex 请直接生成文本或使用内置 imagegen；视频暂未接入");
    if (name === "canvas_run_generation" && input.mode !== "audio") throw new Error("Codex 工具只允许触发独立音频生成");
    if ((name === "canvas_create_generation_flow" || name === "canvas_create_image_prompt_flow" || name === "canvas_create_config_node") && input.autoRun && input.mode !== "audio") throw new Error("Codex 不能通过自动运行流程递归生成");
    if (name === "canvas_apply_ops" && Array.isArray(input.ops) && input.ops.some((operation) => {
        const op = operation as Record<string, unknown>;
        return op.type === "run_generation" && op.mode !== "audio";
    })) throw new Error("Codex 批量操作不能递归触发文本、图片或视频生成");
}
