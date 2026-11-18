import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { Router, raw } from "express";
import { logWhatsAppEvent, type WhatsAppEventHandler } from "../services/whatsapp.js";

export interface WhatsAppWebhookConfig {
  verifyToken?: string;
  appSecret?: string;
}

function validSignature(body: Buffer, signature: string | undefined, secret: string) {
  if (!signature || !/^sha256=[a-fA-F0-9]{64}$/.test(signature)) return false;
  const expected = createHmac("sha256", secret).update(body).digest();
  return timingSafeEqual(expected, Buffer.from(signature.slice(7), "hex"));
}

export function createWhatsAppWebhookRoutes(
  config: WhatsAppWebhookConfig,
  handleEvent: WhatsAppEventHandler = logWhatsAppEvent,
) {
  const router = Router();
  router.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  router.get("/", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    // Hash tokens to compare equal-length buffers without timing leaks.
    if (mode !== "subscribe" || !config.verifyToken || typeof token !== "string" || typeof challenge !== "string" ||
      !timingSafeEqual(createHash("sha256").update(token).digest(), createHash("sha256").update(config.verifyToken).digest())) {
      res.status(403).type("text/plain").send("Forbidden");
      return;
    }
    res.status(200).type("text/plain").send(challenge);
  });

  // Mounted before express.json(): req.body remains the original bytes. Reject
  // compressed requests rather than silently verifying an inflated payload.
  router.post("/", (req, res, next) => {
    const encoding = req.get("Content-Encoding");
    if (encoding && encoding.toLowerCase() !== "identity") {
      res.status(415).json({ error: { code: "UNSUPPORTED_ENCODING", message: "Отправьте несжатое тело вебхука." } });
      return;
    }
    next();
  }, raw({ type: () => true, limit: "1mb", inflate: false }), (req, res) => {
    if (!config.appSecret) {
      res.status(503).json({ error: { code: "WHATSAPP_NOT_CONFIGURED", message: "Вебхук WhatsApp пока не настроен." } });
      return;
    }
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!validSignature(rawBody, req.get("X-Hub-Signature-256"), config.appSecret)) {
      res.status(401).json({ error: { code: "INVALID_SIGNATURE", message: "Неверная подпись вебхука." } });
      return;
    }
    // Do not parse JSON or start processing until the response has been flushed.
    // This is best-effort logging, not a persistent job queue.
    res.once("finish", () => {
      setImmediate(() => {
        let event: unknown;
        try { event = JSON.parse(rawBody.toString("utf8")); }
        catch { console.warn("WhatsApp webhook: invalid JSON in authenticated event"); return; }
        void Promise.resolve().then(() => handleEvent(event)).catch(() => {
          console.error("WhatsApp webhook: event processing failed");
        });
      });
    });
    res.status(200).type("text/plain").send("OK");
  });
  return router;
}
