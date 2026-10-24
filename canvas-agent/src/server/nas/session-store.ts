import fs from "node:fs/promises";
import path from "node:path";
import session, { type SessionData } from "express-session";
import { Low } from "lowdb";
import { JSONFile } from "lowdb/node";
import { z } from "zod";

type LoginSession = SessionData & { authenticated?: boolean; expiresAt?: number };
type SessionFile = { version: 1; sessions: Record<string, LoginSession> };
const loginSessionSchema = z.object({
    authenticated: z.literal(true), expiresAt: z.number().finite().positive(),
    cookie: z.object({
        expires: z.string().refine((value) => Number.isFinite(Date.parse(value))),
        originalMaxAge: z.number().finite().nonnegative(), secure: z.literal(true),
        httpOnly: z.literal(true), sameSite: z.literal("strict"), path: z.literal("/"),
    }).passthrough(),
}).passthrough();
const sessionFileSchema = z.object({ version: z.literal(1), sessions: z.record(loginSessionSchema) }).strict();

/** Single-process persistent store. lowdb performs atomic writes; unknown/corrupt files fail closed. */
export class NasSessionStore extends session.Store {
    private constructor(private db: Low<SessionFile>) { super(); }

    static async open(directory: string) {
        await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        const file = path.join(directory, "sessions.json");
        let data: unknown;
        try { data = JSON.parse(await fs.readFile(file, "utf8")); }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("登录会话文件格式无效，请保留原文件后检查");
            data = { version: 1, sessions: {} };
        }
        if (!sessionFileSchema.safeParse(data).success) throw new Error("登录会话文件格式无效，请保留原文件后检查");
        const db = new Low<SessionFile>(new JSONFile(file), data as SessionFile);
        return new NasSessionStore(db);
    }

    override get(sid: string, callback: (error: unknown, value?: SessionData | null) => void) {
        const value = Object.hasOwn(this.db.data.sessions, sid) ? this.db.data.sessions[sid] : undefined;
        if (!value || !value.authenticated || !value.expiresAt || value.expiresAt <= Date.now()) {
            if (value) return this.destroy(sid, (error) => callback(error, null));
            return callback(null, null);
        }
        callback(null, structuredClone(value));
    }

    override set(sid: string, value: SessionData, callback?: (error?: unknown) => void) {
        // Preserve express-session Cookie.toJSON(), which structuredClone discards.
        const serialized = JSON.parse(JSON.stringify(value)) as LoginSession;
        if (!loginSessionSchema.safeParse(serialized).success) return callback?.(new Error("登录会话记录无效，拒绝写入"));
        Object.defineProperty(this.db.data.sessions, sid, { configurable: true, enumerable: true, writable: true, value: serialized });
        void this.db.write().then(() => callback?.(), (error) => callback?.(error));
    }

    override destroy(sid: string, callback?: (error?: unknown) => void) {
        delete this.db.data.sessions[sid];
        void this.db.write().then(() => callback?.(), (error) => callback?.(error));
    }

    // Login has a fixed seven-day expiry, rather than silently renewing on every request.
    override touch(_sid: string, _value: SessionData, callback?: () => void) { callback?.(); }
}

declare module "express-session" {
    interface SessionData { authenticated?: boolean; expiresAt?: number }
}
