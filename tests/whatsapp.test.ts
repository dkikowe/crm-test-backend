import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { gzipSync } from "node:zlib";
import express from "express";
import { createApp } from "../src/app.js";
import { createRepositories } from "../src/repositories/memory.js";
import { createWhatsAppWebhookRoutes } from "../src/routes/whatsapp.js";
import { logWhatsAppEvent } from "../src/services/whatsapp.js";
import { readConfig } from "../src/config.js";

const config = { verifyToken: "test-only-verification-token", appSecret: "test-only-app-secret" };
const path = "/webhooks/whatsapp";
const sign = (body: string | Buffer, secret = config.appSecret) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
const app = () => createApp("https://crm.example.com", createRepositories(), undefined, undefined, config);
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

async function serve(t: TestContext, application: express.Express) {
  const server = application.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert(address && typeof address !== "string");
  return (route: string, init?: RequestInit) => fetch(`http://127.0.0.1:${address.port}${route}`, { ...init, signal: AbortSignal.timeout(5000) });
}

test("WhatsApp GET verifies subscription and returns the unquoted challenge as text", async t => {
  const request = await serve(t, app());
  const challenge = "000123 + проверка";
  const query = new URLSearchParams({ "hub.mode": "subscribe", "hub.verify_token": config.verifyToken, "hub.challenge": challenge });
  const response = await request(`${path}?${query}`);
  assert.equal(response.status, 200); assert.match(response.headers.get("content-type")!, /^text\/plain/);
  assert.equal(response.headers.get("cache-control"), "no-store"); assert.equal(await response.text(), challenge);
  for (const query of [
    "", `hub.mode=unsubscribe&hub.verify_token=${config.verifyToken}&hub.challenge=1`,
    "hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1",
    `hub.mode=subscribe&hub.verify_token=${config.verifyToken}`,
    `hub.mode=subscribe&hub.verify_token=${config.verifyToken}&hub.verify_token=other&hub.challenge=1`,
    `hub.mode=subscribe&hub.verify_token=${config.verifyToken}&hub.challenge=1&hub.challenge=2`,
  ]) assert.equal((await request(`${path}?${query}`)).status, 403);
});

test("WhatsApp POST authenticates exact raw UTF-8 bytes before JSON parsing", async t => {
  const info = t.mock.method(console, "info", () => {});
  const warn = t.mock.method(console, "warn", () => {});
  const request = await serve(t, app());
  const raw = '{\n "object": "whatsapp_business_account", "text": "Привет 👋", "escaped": "\\u0430", "entry": []\n}';
  const post = (body: string, signature?: string) => request(path, { method: "POST", headers: { "Content-Type": "application/json", ...(signature ? { "X-Hub-Signature-256": signature } : {}) }, body });
  const valid = await post(raw, sign(raw)); assert.equal(valid.status, 200); assert.equal(await valid.text(), "OK");
  await tick(); assert.equal(info.mock.callCount(), 1);
  for (const signature of [undefined, "sha256=short", `sha256=${"z".repeat(64)}`, `sha1=${"a".repeat(40)}`, sign(raw, "wrong-secret"), sign(JSON.stringify(JSON.parse(raw))), `${sign(raw)},${sign(raw)}`]) {
    const denied = await post(raw, signature); assert.equal(denied.status, 401);
  }
  assert.equal((await post(`${raw} `, sign(raw))).status, 401);
  assert.equal((await post("{invalid json", sign(raw))).status, 401);
  await tick(); assert.equal(info.mock.callCount(), 1); assert.equal(warn.mock.callCount(), 0);
  // Even JSON parsing happens after acknowledgement, not in the global parser.
  assert.equal((await post("{invalid json", sign("{invalid json"))).status, 200);
  await tick(); assert.equal(warn.mock.callCount(), 1); assert.equal(info.mock.callCount(), 1);
});

test("WhatsApp acknowledgement is flushed before processing and does not wait for the handler", async t => {
  let finished = false;
  const started = Promise.withResolvers<unknown>();
  const release = Promise.withResolvers<void>();
  const application = express();
  application.use((_req, res, next) => { res.once("finish", () => { finished = true; }); next(); });
  application.use(path, createWhatsAppWebhookRoutes(config, async event => {
    assert.equal(finished, true);
    started.resolve(event);
    await release.promise;
  }));
  const request = await serve(t, application);
  const body = '{"entry":[]}';
  try {
    const response = await request(path, { method: "POST", headers: { "X-Hub-Signature-256": sign(body) }, body });
    assert.equal(response.status, 200); assert.equal(await response.text(), "OK");
    assert.deepEqual(await started.promise, { entry: [] });
  } finally { release.resolve(); }
});

test("WhatsApp catches synchronous and async handler failures after sending 200", async t => {
  const log = t.mock.method(console, "error", () => {});
  const application = express();
  let calls = 0;
  application.use(path, createWhatsAppWebhookRoutes(config, () => {
    calls++;
    if (calls === 1) throw new Error("private failure details");
    return Promise.reject(new Error("private rejection details"));
  }));
  const request = await serve(t, application);
  for (let i = 0; i < 2; i++) {
    const response = await request(path, { method: "POST", body: "{}", headers: { "X-Hub-Signature-256": sign("{}") } });
    assert.equal(response.status, 200); await response.text(); await tick();
  }
  assert.equal(log.mock.callCount(), 2);
  assert(!JSON.stringify(log.mock.calls.map(c => c.arguments)).includes("private"));
});

test("Webhook bypass is limited to its route; body size and encoding are bounded", async t => {
  t.mock.method(console, "info", () => {});
  const request = await serve(t, app());
  const post = (body: string | Buffer, headers: Record<string, string> = {}) => request(path, { method: "POST", body, headers: { "Content-Type": "application/json", "X-Hub-Signature-256": sign(body), ...headers } });
  // Larger than the normal 100 KB CRM parser limit, within the webhook limit.
  assert.equal((await post(JSON.stringify({ text: "x".repeat(110000) }), { Origin: "https://meta.example" })).status, 200);
  assert.equal((await post(JSON.stringify({ text: "x".repeat(1024 * 1024) }))).status, 413);
  assert.equal((await post(gzipSync("{}"), { "Content-Encoding": "gzip" })).status, 415);
  assert.equal((await request("/clients")).status, 401);
  assert.equal((await request("/clients", { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } })).status, 403);
  assert.equal((await request("/clients", { headers: { Origin: "https://other.example" } })).status, 403);
});

test("Missing or empty environment secrets fail closed without breaking CRM health", async t => {
  for (const settings of [{}, { verifyToken: "", appSecret: "" }]) {
    const request = await serve(t, createApp("https://crm.example.com", createRepositories(), undefined, undefined, settings));
    assert.equal((await request(`${path}?hub.mode=subscribe&hub.verify_token=&hub.challenge=1`)).status, 403);
    assert.equal((await request(path, { method: "POST", body: "{}", headers: { "X-Hub-Signature-256": sign("{}", "") } })).status, 503);
    assert.equal((await request("/health")).status, 200);
  }
  const env = readConfig({ MONGODB_URI: "mongodb://localhost/test", WHATSAPP_VERIFY_TOKEN: config.verifyToken, WHATSAPP_APP_SECRET: config.appSecret });
  assert.equal(env.WHATSAPP_VERIFY_TOKEN, config.verifyToken); assert.equal(env.WHATSAPP_APP_SECRET, config.appSecret);
});

test("Event logs describe incoming events without message contents or personal data", t => {
  const info = t.mock.method(console, "info", () => {});
  logWhatsAppEvent({ object: "whatsapp_business_account", entry: [{ id: "private-account", changes: [{ field: "messages", value: { contacts: [{ name: "private-name" }], messages: [{ from: "private-phone", text: { body: "private-text" } }], statuses: [{ recipient_id: "private-phone" }] } }] }] });
  const args = info.mock.calls[0]!.arguments;
  assert.deepEqual(args[1], { object: "whatsapp_business_account", entries: 1, changes: 1, messages: 1, statuses: 1, errors: 0 });
  assert(!JSON.stringify(args).includes("private"));
});
