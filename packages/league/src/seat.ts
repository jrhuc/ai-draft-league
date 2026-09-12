import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { z } from "zod";

import type { AgentContextQuery } from "./agent-context.js";
import type { AgentRunner, AgentTask } from "./agent-runtime.js";
import type { JsonObject, JsonValue, ToolDefinition } from "./types.js";
import { isRecord, text } from "./value.js";

interface SeatExchangeView extends JsonObject {
  id: number;
  task: string;
  system: string;
  prompt: string;
  submission: { name: string; parameters: JsonObject };
}

interface PendingExchange {
  id: number;
  task: AgentTask<unknown>;
  submit: (input: JsonObject) => void;
  reject: (error: Error) => void;
}

interface SeatBridgeOptions {
  context?: (query: AgentContextQuery) => JsonObject;
  onExchange?: (view: SeatExchangeView) => void;
  onTool?: (name: string, args: JsonObject, result: string) => void;
}

const POLL_LIMIT_MS = 55_000;
const BODY_LIMIT_BYTES = 1_000_000;
const TCP_ADDRESS_SCHEMA = z.object({ port: z.number() });

/** Localhost agent bridge that exposes only one seat's prompts and menus. */
export class SeatBridge {
  readonly token = randomBytes(16).toString("hex");
  status: JsonObject = {};
  private readonly server: Server;
  private exchange: PendingExchange | undefined;
  private sequence = 0;
  private pollWaiters: Array<() => void> = [];
  private closed = false;

  constructor(private readonly options: SeatBridgeOptions) {
    this.server = createServer((request, response) => {
      void this.handle(request, response).catch(() => {
        if (!response.headersSent)
          response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
        if (!response.writableEnded) response.end(JSON.stringify({ error: "internal error" }));
      });
    });
  }

  listen(port = 0): Promise<string> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, "127.0.0.1", () => {
        const address = TCP_ADDRESS_SCHEMA.safeParse(this.server.address());
        if (!address.success) {
          reject(new Error("seat bridge did not bind a TCP port"));
          return;
        }
        resolve(`http://127.0.0.1:${address.data.port}`);
      });
    });
  }

  readonly runAgent: AgentRunner = async <T>(task: AgentTask<T>) => {
    const started = performance.now();
    task.signal?.throwIfAborted();
    const pending = this.complete(task);
    const exchange = this.exchange;
    const abort = () => {
      if (this.exchange === exchange) this.exchange = undefined;
      exchange?.reject(new Error("seat exchange aborted"));
      this.wakePollers();
    };
    task.signal?.addEventListener("abort", abort, { once: true });
    try {
      const { input, value } = await pending;
      return {
        value,
        sessionID: `external-${task.session}`,
        messageID: `exchange-${exchange?.id}`,
        response: JSON.stringify(input),
        reasoning: "",
        usage: {},
        tools: [],
        attempts: 1,
        latencyMs: performance.now() - started,
      };
    } finally {
      task.signal?.removeEventListener("abort", abort);
    }
  };

  close(): void {
    this.closed = true;
    this.exchange?.reject(new Error("seat bridge closed"));
    this.exchange = undefined;
    this.wakePollers();
    this.server.close();
    this.server.closeAllConnections();
  }

  private complete<T>(task: AgentTask<T>): Promise<{ input: JsonObject; value: T }> {
    if (this.closed) return Promise.reject(new Error("seat bridge closed"));
    if (this.exchange) return Promise.reject(new Error("a seat exchange is already pending"));
    const { promise, resolve, reject } = Promise.withResolvers<{ input: JsonObject; value: T }>();
    this.exchange = {
      id: ++this.sequence,
      task,
      submit: (input) => resolve({ input, value: task.validate(input) }),
      reject,
    };
    const view = this.view();
    if (view) this.options.onExchange?.(view);
    this.wakePollers();
    return promise;
  }

  private view(): SeatExchangeView | null {
    if (!this.exchange) return null;
    const { task } = this.exchange;
    return {
      id: this.exchange.id,
      task: task.task,
      system: task.system,
      prompt: task.prompt,
      submission: { name: task.submission.name, parameters: task.submission.parameters },
    };
  }

  private waitForExchange(ms: number): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    const wake = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      const index = this.pollWaiters.indexOf(wake);
      if (index !== -1) this.pollWaiters.splice(index, 1);
      resolve();
    }, ms);
    this.pollWaiters.push(wake);
    return promise;
  }

  private wakePollers(): void {
    const waiters = this.pollWaiters;
    this.pollWaiters = [];
    for (const wake of waiters) wake();
  }

  private authorized(request: IncomingMessage): boolean {
    const supplied = Buffer.from(request.headers.authorization ?? "");
    const expected = Buffer.from(`Bearer ${this.token}`);
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  }

  private availableTools(): readonly ToolDefinition[] {
    return this.exchange?.task.tools?.map((tool) => tool.definition) ?? [];
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const send = <Body extends object>(statusCode: number, body: Body) => {
      response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(body));
    };
    if (!this.authorized(request)) return send(401, { error: "bad or missing seat token" });
    const route = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (request.method !== "POST") {
      response.setHeader("allow", "POST");
      return send(405, { error: "method must be POST" });
    }
    const contentType = String(request.headers["content-type"] ?? "")
      .split(";", 1)[0]!
      .trim()
      .toLowerCase();
    if (contentType !== "application/json")
      return send(415, { error: "content-type must be application/json" });
    let body: JsonObject;
    try {
      body = await readJson(request);
    } catch (error) {
      const status = error instanceof SeatHttpError ? error.status : 400;
      return send(status, {
        error: error instanceof Error ? error.message : "invalid request body",
      });
    }

    if (route === "/status")
      return send(200, { status: this.status, exchange: this.exchange?.id ?? null });
    if (route === "/tools") {
      const tools = this.availableTools().map((definition) => ({ ...definition }));
      return send(200, { tools });
    }
    if (route === "/poll") {
      const waitMs = Math.max(0, Math.min(Number(body.waitMs) || 0, POLL_LIMIT_MS));
      if (!this.exchange && waitMs && !this.closed) await this.waitForExchange(waitMs);
      return send(200, { exchange: this.view(), status: this.status });
    }
    if (route === "/context") {
      if (!this.options.context) return send(404, { error: "context stream is not available" });
      try {
        const query: AgentContextQuery = {};
        for (const field of ["after", "before"] as const) {
          if (body[field] === undefined) continue;
          const cursor = z.string().safeParse(body[field]);
          if (!cursor.success)
            throw new Error(`invalid context cursor ${JSON.stringify(body[field])}`);
          query[field] = cursor.data;
        }
        if (body.kind !== undefined) {
          const kind = z
            .enum(["episode", "observation", "decision", "reflection"])
            .safeParse(body.kind);
          if (!kind.success) throw new Error(`invalid context kind ${JSON.stringify(body.kind)}`);
          query.kind = kind.data;
        }
        if (body.limit !== undefined && body.limit !== null) {
          const limit = z.number().finite().safeParse(body.limit);
          if (!limit.success)
            throw new Error(`invalid context limit ${JSON.stringify(body.limit)}`);
          query.limit = limit.data;
        }
        return send(200, this.options.context(query));
      } catch (error) {
        return send(400, {
          error: error instanceof Error ? error.message : "invalid context query",
        });
      }
    }
    if (route === "/tool") {
      const name = text(body.name);
      if (!this.availableTools().some((tool) => tool.name === name))
        return send(400, { error: `unknown tool ${name}` });
      const args = isRecord(body.arguments) ? body.arguments : {};
      const tool = this.exchange?.task.tools?.find((tool) => tool.definition.name === name);
      if (!tool) return send(400, { error: `unknown tool ${name}` });
      const result = tool.run(args);
      this.options.onTool?.(name, args, result);
      return send(200, { result });
    }
    if (route === "/submit") {
      const exchange = this.exchange;
      if (!exchange) return send(409, { error: "no pending exchange" });
      const id = z.number().safe().int().safeParse(body.id);
      if (!id.success) return send(400, { error: "id must be a safe integer" });
      if (id.data !== exchange.id)
        return send(409, { error: `stale exchange; the pending exchange is ${exchange.id}` });
      const submitted = z.string().safeParse(body.text);
      if (!submitted.success || !submitted.data.trim())
        return send(400, { error: "text must be a non-empty string" });
      try {
        exchange.submit(z.record(z.string(), z.json()).parse(JSON.parse(submitted.data)));
      } catch (error) {
        return send(400, { error: error instanceof Error ? error.message : String(error) });
      }
      this.exchange = undefined;
      return send(200, { ok: true, id: exchange.id });
    }
    send(404, { error: "unknown route" });
  }
}

class SeatHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function readJson(request: IncomingMessage): Promise<JsonObject> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > BODY_LIMIT_BYTES) throw new SeatHttpError(413, "request body too large");
    chunks.push(buffer);
  }
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new SeatHttpError(400, "request body must be JSON");
  }
  if (!isRecord(parsed)) throw new SeatHttpError(400, "request body must be a JSON object");
  return parsed;
}
