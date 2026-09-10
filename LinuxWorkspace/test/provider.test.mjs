import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { ChatSSEParser, ProviderError, chatCompletionsURL, streamChat, SessionCredentialStore } from "../src/provider.mjs";

const listen = (handler) => new Promise((resolve) => {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1", () => resolve({
    server,
    port: server.address().port,
    close: () => new Promise((done) => server.close(done)),
  }));
});

const loopbackProvider = (port, overrides = {}) => ({
  apiRoot: `http://127.0.0.1:${port}/v1`,
  modelID: "test-model",
  kind: "chatCompletions",
  allowsLoopbackHTTP: true,
  credentialReference: "reference-1",
  ...overrides,
});

const turns = [{ role: "user", content: "สวัสดี" }];

test("the parser joins deltas and stops at [DONE]", () => {
  const parser = new ChatSSEParser();
  const events = [
    ...parser.append('data: {"choices":[{"delta":{"content":"สวัส"}}]}\n\n'),
    ...parser.append('data: {"choices":[{"delta":{"content":"ดี"}}]}\n\ndata: [DONE]\n\n'),
  ];
  assert.deepEqual(events, [
    { kind: "delta", text: "สวัส" },
    { kind: "delta", text: "ดี" },
    { kind: "finished" },
  ]);
  assert.deepEqual(parser.append('data: {"choices":[{"delta":{"content":"หลังจบ"}}]}\n\n'), []);
});

test("a split multibyte chunk and a finish_reason both terminate cleanly", () => {
  const parser = new ChatSSEParser();
  assert.deepEqual(parser.append('data: {"choices":[{"delta":{"content":"ก'), []);
  const events = parser.append('"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
  assert.deepEqual(events, [{ kind: "delta", text: "ก" }, { kind: "finished" }]);
});

test("malformed payloads and provider error objects fail closed", () => {
  assert.throws(() => new ChatSSEParser().append("data: {oops}\n\n"), ProviderError);
  assert.throws(() => new ChatSSEParser().append('data: {"error":{"message":"nope"}}\n\n'), ProviderError);
  assert.throws(() => new ChatSSEParser({ maxEventBytes: 16 }).append(`data: ${"x".repeat(64)}`), ProviderError);
});

test("an unterminated stream still finishes rather than hanging", () => {
  const parser = new ChatSSEParser();
  parser.append('data: {"choices":[{"delta":{"content":"ครึ่ง"}}]}\n\n');
  assert.deepEqual(parser.finish(), [{ kind: "finished" }]);
});

test("the endpoint is derived per provider kind", () => {
  assert.equal(chatCompletionsURL({ apiRoot: "https://api.example.com/v1" }), "https://api.example.com/v1/chat/completions");
  assert.equal(chatCompletionsURL({ apiRoot: "https://api.example.com/v1/", kind: "codexResponses" }), "https://api.example.com/v1/responses");
});

test("an empty or newline-bearing credential never reaches the network", async () => {
  const { port, close } = await listen(() => assert.fail("ต้องไม่มีการเรียกเครือข่าย"));
  await assert.rejects(streamChat({ provider: loopbackProvider(port), credential: "", turns }),
    (error) => error.code === "invalidCredential");
  await assert.rejects(streamChat({ provider: loopbackProvider(port), credential: "abc\ndef", turns }),
    (error) => error.code === "invalidCredential");
  await assert.rejects(streamChat({ provider: loopbackProvider(port), credential: "k", turns: [] }),
    (error) => error.code === "invalidResponse");
  await close();
});

test("a real SSE reply streams deltas and returns the joined text", async () => {
  let authorization = null;
  let body = null;
  const { port, close } = await listen(async (request, response) => {
    authorization = request.headers.authorization;
    body = JSON.parse(await new Promise((resolve) => {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    }));
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write('data: {"choices":[{"delta":{"content":"ได้"}}]}\n\n');
    response.write('data: {"choices":[{"delta":{"content":"ครับ"}}]}\n\n');
    response.end("data: [DONE]\n\n");
  });
  const seen = [];
  const text = await streamChat({
    provider: loopbackProvider(port), credential: "test-key", turns,
    onEvent: (event) => seen.push(event.kind),
  });
  assert.equal(text, "ได้ครับ");
  assert.deepEqual(seen, ["started", "delta", "delta", "finished"]);
  assert.equal(authorization, "Bearer test-key");
  assert.equal(body.stream, true);
  assert.equal(body.model, "test-model");
  await close();
});

test("HTTP failures, redirects and a wrong MIME type are reported honestly", async () => {
  const statuses = await listen((request, response) => {
    if (request.url.endsWith("/fail/v1/chat/completions")) return response.writeHead(500).end("boom");
    if (request.url.endsWith("/move/v1/chat/completions")) {
      return response.writeHead(302, { location: "https://elsewhere.example/v1" }).end();
    }
    response.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  const { port, close } = statuses;
  await assert.rejects(
    streamChat({ provider: loopbackProvider(port, { apiRoot: `http://127.0.0.1:${port}/fail/v1` }), credential: "k", turns }),
    (error) => error.code === "http" && error.status === 500);
  await assert.rejects(
    streamChat({ provider: loopbackProvider(port, { apiRoot: `http://127.0.0.1:${port}/move/v1` }), credential: "k", turns }),
    (error) => error.code === "redirectRefused");
  await assert.rejects(
    streamChat({ provider: loopbackProvider(port), credential: "k", turns }),
    (error) => error.code === "invalidResponse");
  await close();
});

test("a silent provider times out instead of hanging forever", async () => {
  const { port, close } = await listen((request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    // Deliberately never writes an event.
  });
  await assert.rejects(
    streamChat({
      provider: loopbackProvider(port), credential: "k", turns,
      timeouts: { firstEvent: 120, idle: 120, total: 400 },
    }),
    (error) => error.code === "timedOut");
  await close();
});

test("an aborted stream reports cancellation", async () => {
  const { port, close } = await listen((request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write('data: {"choices":[{"delta":{"content":"เริ่ม"}}]}\n\n');
  });
  const controller = new AbortController();
  const pending = streamChat({
    provider: loopbackProvider(port), credential: "k", turns,
    signal: controller.signal,
    onEvent: (event) => { if (event.kind === "delta") controller.abort(); },
  });
  await assert.rejects(pending, (error) => error.code === "cancelled");
  await close();
});

test("the session credential store reports references but never persists values", () => {
  const store = new SessionCredentialStore();
  store.set("reference-1", "sk-secret");
  assert.equal(store.get("reference-1"), "sk-secret");
  assert.deepEqual(store.references(), ["reference-1"]);
  assert.ok(!JSON.stringify(store).includes("sk-secret"), "ค่า credential ต้องไม่ถูก serialize ออกไป");
  store.remove("reference-1");
  assert.equal(store.has("reference-1"), false);
});
