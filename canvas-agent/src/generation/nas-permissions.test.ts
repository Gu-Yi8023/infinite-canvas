import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CodexAppClient, nasPermissionConfig } from "../agent/codex-client.js";
import { CONFIG_DIR } from "../config.js";

test("NAS uses named profiles and rejects credential-boundary approval escalation", async () => {
    const previous = process.env.NAS_MODE;
    process.env.NAS_MODE = "true";
    try {
        const config = nasPermissionConfig();
        assert.equal(config.default_permissions, "canvas-nas");
        const profiles = config.permissions as Record<string, { filesystem: Record<string, unknown>; network: unknown }>;
        assert.equal(profiles["canvas-nas"].filesystem[":root"], "deny");
        assert.deepEqual(profiles["canvas-nas"].filesystem[":workspace_roots"], { ".": "write" });
        assert.deepEqual(profiles["canvas-nas"].network, { enabled: false });
        const codexHome = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
        for (const profile of Object.values(profiles)) {
            const filesystem = profile.filesystem;
            assert.equal(filesystem[":root"], "deny");
            assert.equal(filesystem[codexHome], undefined, "The default deny must leave the two specific support paths reachable");
            assert.equal(filesystem[path.join(codexHome, "tmp", "arg0")], "read");
            assert.equal(filesystem[path.join(codexHome, "skills", ".system", "imagegen")], "read");
            assert.equal(filesystem[path.resolve(CONFIG_DIR)], "deny");
            assert.equal(Object.values(filesystem).includes("write"), false, "Only the scoped workspace may grant writes");
            assert.equal(filesystem[path.join(codexHome, "auth.json")], undefined);
            assert.equal(filesystem[path.join(codexHome, "generated_images")], undefined);
            assert.equal(filesystem["/run/secrets"], undefined);
        }
        assert.deepEqual(profiles["canvas-nas-readonly"].filesystem[":workspace_roots"], { ".": "read" });
        assert.equal((config.shell_environment_policy as Record<string, unknown>).inherit, "none");
        const writes: Record<string, unknown>[] = [];
        const child = { stdin: { write: (line: string) => { writes.push(JSON.parse(line)); return true; } } };
        const client = Reflect.construct(CodexAppClient, [child, () => undefined, { record: async () => undefined, recordTurn: async () => undefined }]) as CodexAppClient;
        const internals = client as unknown as { handle(message: unknown): void; answerServerRequest(message: unknown): void };
        const starting = client.startThread("F:/workspace", "full");
        const request = writes.at(-1)!;
        const params = request.params as Record<string, unknown>;
        assert.equal(params.permissions, "canvas-nas");
        assert.equal((params.config as Record<string, unknown>).default_permissions, "canvas-nas");
        assert.equal("sandbox" in params, false);
        internals.handle({ id: request.id, result: { thread: { id: "nas-thread", cwd: "F:/workspace" } } });
        await starting;
        const turning = client.startTurn("nas-thread", "test", [], "full");
        const turnRequest = writes.at(-1)!;
        const turnParams = turnRequest.params as Record<string, unknown>;
        assert.equal("permissions" in turnParams, false);
        assert.equal("sandboxPolicy" in turnParams, false);
        internals.handle({ id: turnRequest.id, result: { turn: { id: "nas-turn" } } });
        internals.handle({ method: "turn/completed", params: { threadId: "nas-thread", turn: { id: "nas-turn", status: "completed", items: [] } } });
        await turning;
        const drafting = client.startSkillDraftThread("F:/workspace");
        const draftRequest = writes.at(-1)!;
        const draftParams = draftRequest.params as Record<string, unknown>;
        assert.equal(draftParams.permissions, "canvas-nas-readonly");
        assert.equal((draftParams.config as Record<string, unknown>).default_permissions, "canvas-nas-readonly");
        internals.handle({ id: draftRequest.id, result: { thread: { id: "nas-draft", cwd: "F:/workspace" } } });
        await drafting;
        const generating = client.generateSkillDraft("nas-draft", "test", { type: "object" });
        const draftTurn = writes.at(-1)!;
        assert.equal("permissions" in (draftTurn.params as Record<string, unknown>), false);
        internals.handle({ id: draftTurn.id, error: { message: "stop before model execution" } });
        await assert.rejects(generating, /stop before model execution/);
        internals.answerServerRequest({ id: 33, method: "item/commandExecution/requestApproval", params: { threadId: "nas-thread" } });
        assert.deepEqual(writes.at(-1), { id: 33, result: { decision: "decline" } });
        internals.answerServerRequest({ id: 34, method: "item/permissions/requestApproval", params: { threadId: "nas-thread", permissions: { filesystem: { read: ["/var/lib/codex"] } } } });
        assert.deepEqual(writes.at(-1), { id: 34, result: { permissions: {}, scope: "turn" } });
    } finally { if (previous === undefined) delete process.env.NAS_MODE; else process.env.NAS_MODE = previous; }
});

