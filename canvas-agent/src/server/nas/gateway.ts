import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import type { ServerResponse } from "node:http";
import { compare } from "bcryptjs";
import express, { type NextFunction, type Request, type Response } from "express";
import session from "express-session";
import { createProxyMiddleware } from "http-proxy-middleware";
import { NasSessionStore } from "./session-store.js";
import { sendSpeech, type AudioProvider } from "./audio.js";
import { NasProviderSettings, ProviderSettingsError } from "./provider-settings.js";
import { NasVideoService } from "./video.js";

// Explicitly approved NAS login duration. It does not alter Codex authentication or task timeouts.
export const LOGIN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const COOKIE_NAME = "__Host-canvas-session";
const BODY_LIMIT = "30mb"; // Keep the existing Agent JSON request boundary.
export type GatewayOptions = {
    origin: string; workerUrl: string; bridgeToken: string; passwordHash: string; sessionSecret: string;
    stateDirectory: string; staticDirectory: string; audio?: AudioProvider; outboundProxy?: string;
};

export async function createNasGateway(options: GatewayOptions) {
    const origin = new URL(options.origin);
    if (origin.protocol !== "https:" || origin.origin !== options.origin) throw new Error("CANVAS_PUBLIC_ORIGIN 必须是 HTTPS origin，不包含路径");
    const providers = await NasProviderSettings.open(options.stateDirectory, { audio: options.audio, proxy: options.outboundProxy });
    const videoService = await NasVideoService.open(options.stateDirectory, () => providers.getProvider("video"));
    const app = express();
    const connections = new Map<string, Set<ServerResponse>>();
    app.disable("x-powered-by");
    app.use((req, res, next) => {
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Referrer-Policy", "same-origin");
        res.setHeader("Cache-Control", "no-store");
        if (req.headers.host !== origin.host) return void res.status(403).send("访问地址不匹配");
        if (req.headers.origin && req.headers.origin !== origin.origin) return void res.status(403).json({ ok: false, error: "来源不允许" });
        if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && req.headers.origin !== origin.origin) return void res.status(403).json({ ok: false, error: "缺少同源验证" });
        next();
    });
    app.use(session({
        name: COOKIE_NAME, secret: options.sessionSecret, store: await NasSessionStore.open(options.stateDirectory),
        resave: false, saveUninitialized: false, rolling: false,
        cookie: { secure: true, httpOnly: true, sameSite: "strict", path: "/", maxAge: LOGIN_MAX_AGE_MS },
    }));
    app.get("/login", (_req, res) => res.type("html").send(loginPage()));
    app.post("/login", express.urlencoded({ extended: false, limit: BODY_LIMIT }), async (req, res, next) => {
        try {
            if (typeof req.body?.password !== "string" || !await compare(req.body.password, options.passwordHash)) return void res.status(401).type("html").send(loginPage("访问密码不正确"));
            req.session.regenerate((error) => {
                if (error) return next(error);
                req.session.authenticated = true;
                req.session.expiresAt = Date.now() + LOGIN_MAX_AGE_MS;
                req.session.save((saveError) => saveError ? next(saveError) : res.redirect(303, "/"));
            });
        } catch (error) { next(error); }
    });
    app.use((req, res, next) => {
        if (!req.session.authenticated || !req.session.expiresAt || req.session.expiresAt <= Date.now()) {
            return req.path.startsWith("/api/")
                ? void res.status(401).json({ ok: false, code: "LOGIN_REQUIRED", error: "请登录画布" })
                : void res.redirect(303, "/login");
        }
        next();
    });
    app.get("/api/session", (_req, res) => res.json({ authenticated: true }));
    app.get("/api/providers", (_req, res) => res.json(providers.snapshot()));
    app.put("/api/providers/:kind", express.json({ limit: BODY_LIMIT }), async (req, res, next) => {
        const kind = req.params.kind;
        if (kind !== "audio" && kind !== "video") return void res.status(404).json({ ok: false, error: "供应商类型不存在" });
        try { res.json(await providers.update(kind, req.body)); }
        catch (error) {
            if (error instanceof ProviderSettingsError) return void res.status(400).json({ ok: false, error: error.message });
            next(error);
        }
    });
    app.post("/api/logout", (req, res, next) => {
        const sid = req.sessionID;
        req.session.destroy((error) => {
            if (error) return next(error);
            connections.get(sid)?.forEach((connection) => connection.end());
            connections.delete(sid);
            res.clearCookie(COOKIE_NAME, { path: "/", secure: true, httpOnly: true, sameSite: "strict" });
            res.json({ ok: true });
        });
    });
    app.get("/api/capabilities", async (_req, res) => {
        let image = { status: "unverified", reason: "图片能力尚未验证" };
        try {
            const response = await fetch(`${options.workerUrl}/generation/capabilities`, { headers: { "x-canvas-agent-token": options.bridgeToken }, redirect: "error" });
            if (response.ok) image = (await response.json() as { image: typeof image }).image;
        } catch { image = { status: "unavailable", reason: "Codex 执行服务尚未连接" }; }
        const audio = providers.getProvider("audio");
        const video = providers.getProvider("video");
        res.json({ mode: "nas", codex: { image }, audio: { configured: Boolean(audio), model: audio?.model || "" }, video: { available: Boolean(video), configured: Boolean(video), model: video?.model || "" } });
    });
    app.post("/api/audio/speech", express.json({ limit: BODY_LIMIT }), (req, res, next) => { void sendSpeech(req, res, providers.getProvider("audio")).catch(next); });
    app.post("/api/video/tasks", express.json({ limit: BODY_LIMIT }), (req, res, next) => { void videoService.create(req, res).catch(next); });
    app.get("/api/video/tasks/:id", (req, res, next) => { void videoService.poll(req, res).catch(next); });
    app.get("/api/video/tasks/:id/content", (req, res, next) => { void videoService.content(req, res).catch(next); });
    app.use("/api/agent", (req, res, next) => {
        const route = req.path.toLowerCase().replace(/\/+$/, "");
        if (route === "/api/tools" || route === "/agent/local-file/reveal" || route === "/agent/local-image") return void res.status(403).json({ ok: false, error: "NAS 不开放该接口" });
        const sid = req.sessionID;
        const active = connections.get(sid) || new Set<ServerResponse>();
        active.add(res);
        connections.set(sid, active);
        const expires = setTimeout(() => res.end(), req.session.expiresAt! - Date.now());
        expires.unref();
        res.once("close", () => { clearTimeout(expires); active.delete(res); if (!active.size) connections.delete(sid); });
        next();
    }, createProxyMiddleware<Request, Response>({
        target: options.workerUrl, changeOrigin: true, xfwd: false,
        on: {
            proxyReq: (upstream) => {
                for (const header of ["cookie", "authorization", "origin", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-canvas-agent-token"]) upstream.removeHeader(header);
                upstream.setHeader("x-canvas-agent-token", options.bridgeToken);
            },
            proxyRes: (upstream) => { delete upstream.headers["set-cookie"]; delete upstream.headers["access-control-allow-origin"]; upstream.headers["cache-control"] = "no-store"; },
            error: (_error, _req, res) => { if ("writeHead" in res && !res.headersSent) res.writeHead(502, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: false, error: "Codex 执行服务连接失败" })); },
        },
    }));
    app.use("/api", (_req, res) => res.status(404).json({ ok: false, error: "接口不存在" }));
    app.get("/config.js", (_req, res) => res.type("application/javascript").send("window.__RUNTIME_CONFIG__ = { NAS_MODE: true };"));
    app.use(express.static(options.staticDirectory, { index: false, dotfiles: "deny" }));
    app.get("/{*path}", (_req, res) => res.sendFile(path.join(options.staticDirectory, "index.html")));
    app.use((error: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
        if (res.headersSent) return void res.end();
        const status = error.status === 413 ? 413 : 500;
        res.status(status).json({ ok: false, error: status === 413 ? "请求超过现有 30 MB 限制" : "服务请求失败，请检查服务端配置和网络" });
    });
    return app;
}

export async function startNasGateway() {
    process.umask(0o077);
    const { audio, warning } = loadGatewayAudio();
    if (warning) console.warn(warning);
    let outboundProxy = "";
    try { outboundProxy = secret("OUTBOUND_PROXY_FILE", false); }
    catch { console.warn("NAS 出站代理文件无法读取，使用代理的供应商暂不可用；不会自动直连"); }
    const app = await createNasGateway({
        origin: required("CANVAS_PUBLIC_ORIGIN"), workerUrl: required("CANVAS_WORKER_URL").replace(/\/$/, ""),
        bridgeToken: secret("CANVAS_BRIDGE_TOKEN_FILE"), passwordHash: secret("CANVAS_PASSWORD_HASH_FILE"), sessionSecret: secret("CANVAS_SESSION_SECRET_FILE"),
        stateDirectory: required("CANVAS_GATEWAY_STATE"), staticDirectory: required("CANVAS_WEB_ROOT"),
        ...(audio ? { audio } : {}), ...(outboundProxy ? { outboundProxy } : {}),
    });
    https.createServer({ cert: fs.readFileSync(required("CANVAS_TLS_CERT_FILE")), key: fs.readFileSync(required("CANVAS_TLS_KEY_FILE")) }, app)
        .listen(Number(process.env.PORT) || 3000, "0.0.0.0", () => console.log("Infinite Canvas NAS HTTPS gateway ready"));
}

/** 可选音频配置失败只禁用音频；完整配置仍默认要求显式出站代理。 */
export function loadGatewayAudio(env: NodeJS.ProcessEnv = process.env, readFile: (file: string) => string = (file) => fs.readFileSync(file, "utf8")): { audio?: AudioProvider; warning?: string } {
    const endpoint = env.AUDIO_SPEECH_URL || "";
    const model = env.AUDIO_MODEL || "";
    const keyFile = env.AUDIO_API_KEY_FILE?.trim() || "";
    if (!endpoint && !model && !keyFile) return {};
    if (!endpoint.trim() || !model.trim() || !keyFile) return { warning: "音频配置不完整，音频暂不可用；Codex 网关继续运行" };
    try {
        const key = readFile(keyFile).trim();
        if (!key) return { warning: "音频 Key 文件为空，音频暂不可用；Codex 网关继续运行" };
        if (env.AUDIO_USE_PROXY === "false") return { audio: { endpoint, model, key } };
        const proxyFile = env.OUTBOUND_PROXY_FILE?.trim();
        if (!proxyFile) return { warning: "缺少音频出站代理配置，音频暂不可用；不会自动直连，Codex 网关继续运行" };
        const proxy = readFile(proxyFile).trim();
        if (!proxy) return { warning: "音频出站代理配置为空，音频暂不可用；不会自动直连，Codex 网关继续运行" };
        return { audio: { endpoint, model, key, proxy } };
    } catch { return { warning: "音频配置文件无法读取，音频暂不可用；不会自动直连，Codex 网关继续运行" }; }
}
function required(name: string) { const value = process.env[name]?.trim(); if (!value) throw new Error(`缺少配置 ${name}`); return value; }
function secret(name: string, mandatory = true) {
    const file = process.env[name]?.trim();
    if (!file) { if (mandatory) throw new Error(`缺少配置 ${name}`); return ""; }
    const value = fs.readFileSync(file, "utf8").trim();
    if (!value && mandatory) throw new Error(`配置文件 ${name} 为空`);
    return value;
}
function loginPage(error = "") {
    return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>登录画布</title><style>html{font:16px system-ui;color-scheme:light dark}body{max-width:22rem;margin:15vh auto;padding:1.5rem}input,button{box-sizing:border-box;width:100%;padding:.8rem;margin-top:1rem;font:inherit}p{line-height:1.6}</style><h1>登录画布</h1><p>输入 NAS 画布访问密码。登录有效期为 7 天。</p><form method="post" action="/login"><label>访问密码<input name="password" type="password" autocomplete="current-password" required autofocus></label><button type="submit">登录</button></form><p role="alert">${error}</p></html>`;
}

