#!/usr/bin/env node
import { startHttpServer } from "./server/http.js";
import { startMcpServer } from "./server/mcp.js";

if (process.argv[2] === "gateway") await (await import("./server/nas/gateway.js")).startNasGateway();
else if (process.argv[2] === "mcp") await startMcpServer();
else startHttpServer();
