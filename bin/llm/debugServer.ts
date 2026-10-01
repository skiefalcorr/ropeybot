/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *       http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
    createServer,
    IncomingMessage,
    Server,
    ServerResponse,
} from "node:http";
import { readFileSync } from "node:fs";
import { LLMAgent } from "./agent";

/**
 * A tiny local HTTP debug server for driving and inspecting the LLM bot
 * while it runs against the live server. Binds to 127.0.0.1 only.
 *
 * Endpoints:
 *  - GET  /status   — agent state snapshot (room, participants, rate limit, ...)
 *  - GET  /tools    — all resolved tools with their parameter schemas
 *  - POST /tool     — run a tool directly: { "name": "...", "args": {...} }
 *  - GET  /toollog  — recent tool invocations (LLM + manual), ?limit=N
 *  - GET  /llmlog   — last N entries of the llmLog JSONL file, ?limit=N
 *  - POST /stop     — shut the bot down (same as SIGINT)
 */
export class DebugServer {
    private server: Server;

    constructor(
        private port: number,
        private agent: LLMAgent,
        private llmLogPath: string | undefined,
        private onStop: () => void,
    ) {
        this.server = createServer((req, res) => void this.handle(req, res));
    }

    start(): void {
        this.server.listen(this.port, "127.0.0.1", () => {
            console.log(
                `Debug server listening on http://127.0.0.1:${this.port}`,
            );
        });
    }

    close(): void {
        this.server.close();
    }

    private async handle(
        req: IncomingMessage,
        res: ServerResponse,
    ): Promise<void> {
        const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.port}`);
        const path = url.pathname;
        try {
            if (req.method === "GET" && path === "/status") {
                this.json(res, { status: this.agent.getToolStatus() });
            } else if (req.method === "GET" && path === "/tools") {
                this.json(
                    res,
                    this.agent.getTools().map((t) => ({
                        name: t.name,
                        category: t.category,
                        definition: t.definition,
                    })),
                );
            } else if (req.method === "POST" && path === "/tool") {
                const body = await this.readBody(req);
                let parsed: { name?: unknown; args?: unknown };
                try {
                    parsed = JSON.parse(body);
                } catch {
                    this.json(
                        res,
                        { ok: false, error: "Invalid JSON body." },
                        400,
                    );
                    return;
                }
                const name = String(parsed.name ?? "");
                const args =
                    parsed.args &&
                    typeof parsed.args === "object" &&
                    !Array.isArray(parsed.args)
                        ? (parsed.args as Record<string, unknown>)
                        : {};
                const result = await this.agent.runTool(name, args);
                this.json(res, { ok: true, name, args, result });
            } else if (req.method === "GET" && path === "/toollog") {
                const limit = this.limitParam(url);
                const log = this.agent.getToolLog();
                this.json(res, log.slice(-limit));
            } else if (req.method === "GET" && path === "/llmlog") {
                const limit = this.limitParam(url);
                if (!this.llmLogPath) {
                    this.json(
                        res,
                        {
                            error: "llmLog is not configured; no log file to read.",
                        },
                        404,
                    );
                    return;
                }
                let entries: unknown[];
                try {
                    const raw = readFileSync(this.llmLogPath, "utf-8");
                    const lines = raw
                        .split("\n")
                        .filter((l) => l.trim().length > 0);
                    entries = lines.slice(-limit).map((l) => JSON.parse(l));
                } catch (e) {
                    this.json(
                        res,
                        { error: `Could not read llmLog file: ${String(e)}` },
                        500,
                    );
                    return;
                }
                this.json(res, entries);
            } else if (req.method === "POST" && path === "/stop") {
                this.json(res, { ok: true, message: "Shutting down." });
                // Let the response flush before stopping the process.
                setTimeout(() => this.onStop(), 100);
            } else {
                this.json(res, { error: "Not found." }, 404);
            }
        } catch (e) {
            this.json(res, { ok: false, error: String(e) }, 500);
        }
    }

    private limitParam(url: URL): number {
        const raw = Number(url.searchParams.get("limit") ?? 20);
        return Number.isFinite(raw) && raw > 0 ? Math.min(raw, 200) : 20;
    }

    private readBody(req: IncomingMessage): Promise<string> {
        return new Promise((resolve, reject) => {
            const chunks: Buffer[] = [];
            req.on("data", (c: Buffer) => chunks.push(c));
            req.on("end", () =>
                resolve(Buffer.concat(chunks).toString("utf-8")),
            );
            req.on("error", reject);
        });
    }

    private json(res: ServerResponse, data: unknown, status = 200): void {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data, null, 2));
    }
}
