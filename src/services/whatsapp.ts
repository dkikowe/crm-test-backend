export type WhatsAppEventHandler = (event: unknown) => void | Promise<void>;

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

// Log event metadata, not message text, contacts, tokens or raw request headers.
export const logWhatsAppEvent: WhatsAppEventHandler = (event) => {
  const entries = list(record(event).entry);
  const changes = entries.flatMap(entry => list(record(entry).changes));
  const values = changes.map(change => record(record(change).value));
  console.info("WhatsApp webhook event", {
    object: record(event).object === "whatsapp_business_account" ? "whatsapp_business_account" : "unknown",
    entries: entries.length,
    changes: changes.length,
    messages: values.reduce((count, value) => count + list(value.messages).length, 0),
    statuses: values.reduce((count, value) => count + list(value.statuses).length, 0),
    errors: values.reduce((count, value) => count + list(value.errors).length, 0),
  });
};
