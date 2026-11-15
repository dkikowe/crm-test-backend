import { z } from "zod";
export const MiB = 1024 * 1024;
export const fileRules = {
  audio: { mime: ["audio/ogg", "audio/mpeg"], max: 20 * MiB },
  photo: { mime: ["image/jpeg", "image/png", "image/webp"], max: 10 * MiB },
  video: { mime: ["video/mp4"], max: 500 * MiB },
} as const;
export const beginFileSchema = z.object({
  type: z.enum(["audio", "photo", "video"]),
  name: z.string().trim().min(1).max(200).refine(v => !/[\x00-\x1f\x7f/\\]/.test(v), "Недопустимое имя файла"),
  contentType: z.enum(["audio/ogg", "audio/mpeg", "image/jpeg", "image/png", "image/webp", "video/mp4"]),
  size: z.number().int().positive(),
  description: z.string().trim().max(1000).default(""),
}).strict().superRefine((data, ctx) => {
  const rule = fileRules[data.type];
  if (!(rule.mime as readonly string[]).includes(data.contentType)) ctx.addIssue({ code: "custom", path: ["contentType"], message: "Формат не соответствует типу файла" });
  if (data.size > rule.max) ctx.addIssue({ code: "custom", path: ["size"], message: `Максимальный размер: ${rule.max / MiB} МБ` });
});
export const completeFileSchema = z.object({ parts: z.array(z.object({ partNumber: z.number().int().min(1).max(64), etag: z.string().min(1).max(200) }).strict()).max(64).default([]) }).strict();
// Signature checks supplement the signed Content-Type and exact byte-length check.
// They identify containers, not codecs or malware; no arbitrary MIME types are allowed.
export function matchesSignature(mime: string, data: Uint8Array) {
  const b = Buffer.from(data);
  if (mime === "image/jpeg") return b.length >= 3 && b[0] === 255 && b[1] === 216 && b[2] === 255;
  if (mime === "image/png") return b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  if (mime === "image/webp") return b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP";
  if (mime === "audio/ogg") return b.toString("ascii", 0, 4) === "OggS" && (b.includes(Buffer.from("OpusHead")) || b.includes(Buffer.from("\x01vorbis", "binary")));
  if (mime === "audio/mpeg") return b.toString("ascii", 0, 3) === "ID3" || (b.length >= 2 && b[0] === 255 && (b[1]! & 0xe0) === 0xe0 && (b[1]! & 0x06) !== 0);
  if (mime === "video/mp4") return b.length >= 12 && b.toString("ascii", 4, 8) === "ftyp" && ["isom", "iso2", "mp41", "mp42", "avc1", "M4V ", "dash", "MSNV"].some(brand => b.subarray(8, Math.min(b.length, 128)).includes(Buffer.from(brand)));
  return false;
}
