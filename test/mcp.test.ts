import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createHandler, PROTOCOL_VERSIONS, serve, type McpTool } from "../src/mcp.js";

const echo: McpTool = {
  name: "echo_args",
  description: "Returns its arguments.",
  inputSchema: { type: "object", properties: { x: { type: "string" } } },
  call: async (args) => ({ got: args }),
};
const broken: McpTool = {
  name: "broken",
  description: "Always throws.",
  inputSchema: { type: "object", properties: {} },
  call: async () => {
    throw new Error("folder not found: /nope");
  },
};

const handle = createHandler({ version: "1.1.0", tools: [echo, broken] });
const ask = async (msg: unknown) => {
  const out = await handle(typeof msg === "string" ? msg : JSON.stringify(msg));
  return out === null ? null : (JSON.parse(out) as { id: unknown; result?: any; error?: { code: number; message: string } });
};
const req = (id: unknown, method: string, params?: unknown) => ({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });

describe("initialize", () => {
  it("echoes a protocol version it supports, and names itself", async () => {
    const res = await ask(req(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } }));
    expect(res!.result).toEqual({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "cloudpin", version: "1.1.0" } });
  });

  it("answers with its newest version when the client asks for one it doesn't know", async () => {
    const res = await ask(req(1, "initialize", { protocolVersion: "1999-01-01" }));
    expect(res!.result.protocolVersion).toBe(PROTOCOL_VERSIONS[0]);
    expect(PROTOCOL_VERSIONS[0]).toBe("2026-07-28");
  });
});

describe("tools", () => {
  it("lists every tool with its schema, marked read-only", async () => {
    const res = await ask(req(2, "tools/list"));
    expect(res!.result.tools).toEqual([
      { name: "echo_args", description: "Returns its arguments.", inputSchema: echo.inputSchema, annotations: { readOnlyHint: true } },
      { name: "broken", description: "Always throws.", inputSchema: broken.inputSchema, annotations: { readOnlyHint: true } },
    ]);
  });

  it("calls a tool and returns its result as text and as structured content", async () => {
    const res = await ask(req(3, "tools/call", { name: "echo_args", arguments: { x: "y" } }));
    expect(res!.result).toEqual({
      content: [{ type: "text", text: JSON.stringify({ got: { x: "y" } }, null, 2) }],
      structuredContent: { got: { x: "y" } },
    });
  });

  it("reports a failing tool or an unknown one as a tool error, not a protocol error", async () => {
    const failed = await ask(req(4, "tools/call", { name: "broken", arguments: {} }));
    expect(failed!.result).toEqual({ content: [{ type: "text", text: "folder not found: /nope" }], isError: true });
    const unknown = await ask(req(5, "tools/call", { name: "nope", arguments: {} }));
    expect(unknown!.result.isError).toBe(true);
    expect(unknown!.result.content[0].text).toMatch(/unknown tool "nope"/);
  });

  it("rejects tools/call without a tool name as invalid params", async () => {
    expect((await ask(req(6, "tools/call", { arguments: {} })))!.error!.code).toBe(-32602);
  });
});

describe("protocol", () => {
  it("answers ping with an empty result", async () => {
    expect((await ask(req(7, "ping")))!.result).toEqual({});
  });

  it("answers an unknown method with -32601 and bad JSON with -32700", async () => {
    expect(await ask(req(8, "resources/list"))).toEqual({ jsonrpc: "2.0", id: 8, error: { code: -32601, message: "method not found: resources/list" } });
    expect(await ask("{ not json")).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
  });

  it("echoes ids and stays silent for notifications", async () => {
    expect((await ask(req(0, "ping")))!.id).toBe(0);
    expect((await ask(req("a", "ping")))!.id).toBe("a");
    expect(await ask({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    expect(await ask({ jsonrpc: "2.0", method: "something/unknown" })).toBeNull();
  });

  it("answers a request without a method, or a message that isn't an object, with -32600", async () => {
    expect(await ask({ jsonrpc: "2.0", id: 10 })).toEqual({ jsonrpc: "2.0", id: 10, error: { code: -32600, message: "invalid request: no method" } });
    expect(await ask({ jsonrpc: "2.0", id: 11, method: 5 })).toEqual({ jsonrpc: "2.0", id: 11, error: { code: -32600, message: "invalid request: no method" } });
    for (const msg of ["5", "null", '"ping"', '[{"jsonrpc":"2.0","id":1,"method":"ping"}]']) {
      expect(await ask(msg)).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } });
    }
  });

  it("accepts CRLF lines", async () => {
    expect((await ask(`${JSON.stringify(req(9, "ping"))}\r`))!.result).toEqual({});
  });
});

describe("serve", () => {
  it("buffers split and joined chunks, answering in order, one JSON line each", async () => {
    const input = new PassThrough();
    const lines: string[] = [];
    const done = serve(handle, input, { write: (s: string) => lines.push(s) });
    input.write('{"jsonrpc":"2.0","id":1,"me');
    input.write('thod":"ping"}\r\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n\n{"jsonrpc":"2.0","id":2,"method":"ping"}\n');
    input.end();
    await done;
    expect(lines).toEqual(['{"jsonrpc":"2.0","id":1,"result":{}}\n', '{"jsonrpc":"2.0","id":2,"result":{}}\n']);
  });

  it("keeps a UTF-8 character whole when a chunk boundary splits its bytes", async () => {
    const input = new PassThrough();
    const lines: string[] = [];
    const done = serve(handle, input, { write: (s: string) => lines.push(s) });
    const bytes = Buffer.from(`${JSON.stringify(req(1, "tools/call", { name: "echo_args", arguments: { x: "café ✓" } }))}\n`, "utf8");
    const cut = bytes.indexOf(Buffer.from("✓", "utf8")) + 1; // inside the 3-byte check mark
    input.write(bytes.subarray(0, cut));
    await new Promise((r) => setImmediate(r)); // let serve read the first half on its own
    input.write(bytes.subarray(cut));
    input.end();
    await done;
    expect(JSON.parse(lines[0]!).result.structuredContent).toEqual({ got: { x: "café ✓" } });
  });
});
