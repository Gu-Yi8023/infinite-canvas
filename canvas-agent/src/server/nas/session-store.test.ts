import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import session, { type SessionData } from "express-session";
import { NasSessionStore } from "./session-store.js";

function record(expiresAt = Date.now() + 604800000): SessionData { return { authenticated: true, expiresAt, cookie: new session.Cookie({ path: "/", secure: true, httpOnly: true, sameSite: "strict", maxAge: 604800000 }) }; }
function get(store: NasSessionStore, sid: string) { return new Promise<SessionData | null | undefined>((resolve, reject) => store.get(sid, (error, value) => error ? reject(error) : resolve(value))); }
function set(store: NasSessionStore, sid: string, value: SessionData) { return new Promise<void>((resolve, reject) => store.set(sid, value, (error) => error ? reject(error) : resolve())); }
async function directory(t: { after: (fn: () => unknown) => void }) { const dir = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-login-test-")); t.after(() => fs.rm(dir, { recursive: true, force: true })); return dir; }

test("session store survives restart, returns clones, retains cookie serialization and never rolls expiry", async (t) => {
    const dir = await directory(t); const store = await NasSessionStore.open(dir); const value = record();
    await set(store, "signed-session", value);
    const persisted = JSON.parse(await fs.readFile(path.join(dir, "sessions.json"), "utf8"));
    assert.equal(persisted.sessions["signed-session"].cookie.expires, value.cookie.expires!.toISOString());
    assert.equal(persisted.sessions["signed-session"].cookie._expires, undefined);
    const reopened = await NasSessionStore.open(dir); const loaded = (await get(reopened, "signed-session"))!;
    assert.equal(loaded.expiresAt, value.expiresAt); loaded.authenticated = false;
    assert.equal((await get(reopened, "signed-session"))!.authenticated, true);
    const before = await fs.readFile(path.join(dir, "sessions.json"), "utf8");
    await new Promise<void>((resolve) => reopened.touch("signed-session", record(), resolve));
    assert.equal(await fs.readFile(path.join(dir, "sessions.json"), "utf8"), before);
    await new Promise<void>((resolve, reject) => reopened.destroy("signed-session", (error) => error ? reject(error) : resolve()));
    assert.equal(await get(await NasSessionStore.open(dir), "signed-session"), null);
});

test("expired and unknown sessions fail closed", async (t) => {
    const dir = await directory(t); const store = await NasSessionStore.open(dir);
    await set(store, "expired", record(Date.now() - 1));
    assert.equal(await get(store, "expired"), null); assert.equal(await get(store, "missing"), null);
    assert.equal(await get(await NasSessionStore.open(dir), "expired"), null);
});

test("unknown version, malformed JSON and corrupt session records reject open without altering files", async (t) => {
    const dir = await directory(t); const file = path.join(dir, "sessions.json");
    const valid = JSON.parse(JSON.stringify(record()));
    for (const value of ["{broken", "null", JSON.stringify({ version: 2, sessions: {} }), JSON.stringify({ version: 1, sessions: [] }), JSON.stringify({ version: 1, sessions: { sid: { ...valid, expiresAt: "invalid" } } }), JSON.stringify({ version: 1, sessions: { sid: { ...valid, cookie: null } } })]) {
        await fs.writeFile(file, value);
        await assert.rejects(NasSessionStore.open(dir), value);
        assert.equal(await fs.readFile(file, "utf8"), value);
    }
});
