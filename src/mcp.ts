/*
 * A small Model Context Protocol server over stdio (#15), written by hand so
 * cloudpin needs no new dependency. JSON-RPC 2.0, one message per line
 * (modelcontextprotocol.io, "Transports: stdio"); only what tools need:
 * initialize, ping, tools/list and tools/call. Every tool is read-only.
 */

import { StringDecoder } from "node:string_decoder";

export interface McpTool {
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments. */
  inputSchema: object;
  call(args: Record<string, unknown>): Promise<unknown>;
}

/** Newest first. Claude Code's newer client offers 2026-07-28 and falls back otherwise (code.claude.com, mcp). */
export const PROTOCOL_VERSIONS: readonly string[] = ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

type Id = string | number | null;
interface Message {
  id?: Id;
  method?: unknown;
  params?: Record<string, unknown>;
}

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

/** Answers one line: the JSON reply, or null for a notification (which never gets one). */
export function createHandler(opts: { version: string; tools: McpTool[] }): (line: string) => Promise<string | null> {
  const reply = (id: Id, body: { result: unknown } | { error: { code: number; message: string } }) =>
    JSON.stringify({ jsonrpc: "2.0", id, ...body });

  const dispatch = async (method: unknown, params: Record<string, unknown>): Promise<unknown> => {
    switch (method) {
      case "initialize": {
        const asked = params.protocolVersion;
        const protocolVersion = typeof asked === "string" && PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0];
        return { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "cloudpin", version: opts.version } };
      }
      case "ping":
        return {};
      case "tools/list":
        return {
          tools: opts.tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
            annotations: { readOnlyHint: true },
          })),
        };
      case "tools/call": {
        if (typeof params.name !== "string") throw new RpcError(-32602, "tools/call needs a tool name");
        const tool = opts.tools.find((t) => t.name === params.name);
        // Tool failures are results the agent can read, not protocol errors.
        if (!tool) return { content: [{ type: "text", text: `unknown tool "${params.name}"` }], isError: true };
        const args = params.arguments && typeof params.arguments === "object" ? (params.arguments as Record<string, unknown>) : {};
        try {
          const value = await tool.call(args);
          return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], structuredContent: value };
        } catch (err) {
          return { content: [{ type: "text", text: (err as Error).message }], isError: true };
        }
      }
      default:
        throw new RpcError(-32601, `method not found: ${String(method)}`);
    }
  };

  return async (line) => {
    let msg: Message;
    try {
      msg = JSON.parse(line.replace(/\r$/, "")) as Message;
    } catch {
      return reply(null, { error: { code: -32700, message: "parse error" } });
    }
    // MCP dropped JSON-RPC batches (2025-06-18), so an array is as invalid as a bare value.
    if (msg === null || typeof msg !== "object" || Array.isArray(msg)) {
      return reply(null, { error: { code: -32600, message: "invalid request" } });
    }
    const isRequest = "id" in msg;
    if (typeof msg.method !== "string") {
      return isRequest ? reply(msg.id ?? null, { error: { code: -32600, message: "invalid request: no method" } }) : null;
    }
    const params = msg.params && typeof msg.params === "object" ? msg.params : {};
    try {
      const result = await dispatch(msg.method, params);
      return isRequest ? reply(msg.id ?? null, { result }) : null;
    } catch (err) {
      if (!isRequest) return null;
      const code = err instanceof RpcError ? err.code : -32603;
      return reply(msg.id ?? null, { error: { code, message: (err as Error).message } });
    }
  };
}

/** Feeds `input` to the handler line by line, writing each answer as one line; resolves when input ends. */
export async function serve(
  handler: (line: string) => Promise<string | null>,
  input: NodeJS.ReadableStream,
  output: { write(s: string): unknown },
): Promise<void> {
  let buffer = "";
  // A multi-byte character can straddle two chunks; the decoder holds its first bytes until the rest arrive.
  const decoder = new StringDecoder("utf8");
  const answer = async (line: string) => {
    if (line.trim() === "") return;
    const out = await handler(line);
    if (out !== null) output.write(`${out}\n`);
  };
  for await (const chunk of input) {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk as Buffer);
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      await answer(line);
    }
  }
  await answer(buffer + decoder.end());
}
