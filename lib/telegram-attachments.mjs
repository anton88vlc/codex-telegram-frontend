import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export const DEFAULT_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;
export const DEFAULT_ATTACHMENT_MAX_COUNT = 4;

function cleanText(value) {
  return String(value ?? "").trim();
}

function sanitizeFileName(value, fallback = "telegram-attachment") {
  const baseName = path.basename(cleanText(value).replace(/\\/g, "/"));
  const name = baseName
    .replace(/[/\\?%*:|"<>]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^\.+/, "")
    .trim();
  return name || fallback;
}

function extensionFromFilePath(filePath, fallback = "") {
  const ext = path.extname(cleanText(filePath)).toLowerCase();
  return ext && ext.length <= 12 ? ext : fallback;
}

function formatBytes(bytes) {
  const number = Number(bytes);
  if (!Number.isFinite(number) || number < 0) {
    return "unknown size";
  }
  if (number >= 1024 * 1024) {
    return `${(number / (1024 * 1024)).toFixed(number >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
  }
  if (number >= 1024) {
    return `${Math.round(number / 1024)} KB`;
  }
  return `${number} B`;
}

function selectLargestPhoto(photos) {
  const items = Array.isArray(photos) ? photos.filter((photo) => photo?.file_id) : [];
  if (!items.length) {
    return null;
  }
  return [...items].sort((a, b) => {
    const aScore = Number(a.file_size) || Number(a.width) * Number(a.height) || 0;
    const bScore = Number(b.file_size) || Number(b.width) * Number(b.height) || 0;
    return bScore - aScore;
  })[0];
}

export function getMessageIngressText(message = {}) {
  if (typeof message.text === "string") {
    return message.text;
  }
  if (typeof message.caption === "string") {
    return message.caption;
  }
  return "";
}

export function collectTelegramAttachments(message = {}, { maxCount = DEFAULT_ATTACHMENT_MAX_COUNT } = {}) {
  const attachments = [];
  const photo = selectLargestPhoto(message.photo);
  if (photo) {
    attachments.push({
      kind: "image",
      source: "photo",
      fileId: photo.file_id,
      fileUniqueId: photo.file_unique_id || null,
      fileName: `telegram-photo-${message.message_id || Date.now()}.jpg`,
      mimeType: "image/jpeg",
      size: Number(photo.file_size) || null,
      width: Number(photo.width) || null,
      height: Number(photo.height) || null,
    });
  }

  const document = message.document;
  if (document?.file_id) {
    const mimeType = cleanText(document.mime_type) || "application/octet-stream";
    attachments.push({
      kind: mimeType.startsWith("image/") ? "image" : "file",
      source: "document",
      fileId: document.file_id,
      fileUniqueId: document.file_unique_id || null,
      fileName: sanitizeFileName(document.file_name, `telegram-document-${message.message_id || Date.now()}`),
      mimeType,
      size: Number(document.file_size) || null,
    });
  }

  return attachments.slice(0, Math.max(1, Number(maxCount) || DEFAULT_ATTACHMENT_MAX_COUNT));
}

export function hasUnsupportedTelegramMedia(message = {}) {
  return Boolean(message.voice || message.audio || message.video || message.video_note || message.sticker);
}

function buildStoredFileName({ attachment, filePath, index }) {
  const originalName = sanitizeFileName(attachment.fileName, `telegram-attachment-${index + 1}`);
  if (path.extname(originalName)) {
    return originalName;
  }
  return `${originalName}${extensionFromFilePath(filePath, attachment.kind === "image" ? ".jpg" : "")}`;
}

export async function saveTelegramAttachments({
  token,
  message,
  storageDir,
  maxBytes = DEFAULT_ATTACHMENT_MAX_BYTES,
  maxCount = DEFAULT_ATTACHMENT_MAX_COUNT,
  getFile,
  downloadFile,
  now = new Date(),
} = {}) {
  if (!token) {
    throw new Error("missing Telegram bot token for attachment download");
  }
  if (!storageDir) {
    throw new Error("missing attachment storage dir");
  }
  if (typeof getFile !== "function" || typeof downloadFile !== "function") {
    throw new Error("missing Telegram file helpers");
  }

  const attachments = collectTelegramAttachments(message, { maxCount });
  const day = now.toISOString().slice(0, 10);
  const chatPart = String(message?.chat?.id ?? "chat").replace(/[^0-9a-z_-]/gi, "_");
  const messagePart = String(message?.message_id ?? now.getTime()).replace(/[^0-9a-z_-]/gi, "_");
  const targetDir = path.resolve(storageDir, day, `${chatPart}-${messagePart}`);
  await mkdir(targetDir, { recursive: true });

  const saved = [];
  for (let index = 0; index < attachments.length; index += 1) {
    const attachment = attachments[index];
    const remoteFile = await getFile(token, { fileId: attachment.fileId });
    const fileSize = Number(remoteFile?.file_size || attachment.size || 0);
    if (Number.isFinite(fileSize) && fileSize > Number(maxBytes)) {
      throw new Error(
        `attachment ${attachment.fileName} is too large (${formatBytes(fileSize)}); max is ${formatBytes(maxBytes)}`,
      );
    }
    if (!remoteFile?.file_path) {
      throw new Error(`Telegram did not return file_path for ${attachment.fileName}`);
    }

    const bytes = await downloadFile(token, { filePath: remoteFile.file_path });
    if (bytes.length > Number(maxBytes)) {
      throw new Error(
        `attachment ${attachment.fileName} is too large (${formatBytes(bytes.length)}); max is ${formatBytes(maxBytes)}`,
      );
    }

    const fileName = buildStoredFileName({
      attachment,
      filePath: remoteFile.file_path,
      index,
    });
    const localPath = path.join(targetDir, fileName);
    await writeFile(localPath, bytes);
    saved.push({
      ...attachment,
      fileName,
      localPath,
      size: bytes.length,
      telegramFilePath: remoteFile.file_path,
    });
  }

  return saved;
}

export function formatAttachmentPrompt({ text = "", attachments = [] } = {}) {
  const promptText = cleanText(text);
  const lines = [];

  if (promptText) {
    lines.push(promptText);
  } else {
    lines.push("The user sent Telegram attachment(s). Inspect them and respond to the thread.");
  }

  if (!attachments.length) {
    return lines.join("\n");
  }

  lines.push("", "[Telegram attachments]");
  attachments.forEach((attachment, index) => {
    const label = attachment.kind === "image" ? "image" : "file";
    lines.push(
      `${index + 1}. ${label}: ${attachment.fileName} (${attachment.mimeType || "unknown"}, ${formatBytes(attachment.size)})`,
    );
    lines.push(`   local path: ${attachment.localPath}`);
    if (attachment.kind === "image") {
      lines.push(`   markdown image: ![${attachment.fileName}](${attachment.localPath})`);
    }
  });

  lines.push(
    "",
    "Use the local path(s) above as the attachment source. For images, open the file if visual details matter; for documents, inspect the file from disk before answering.",
  );

  return lines.join("\n");
}

export function formatAttachmentReceipt(attachments = []) {
  if (!attachments.length) {
    return "Received the attachment. Sending it to Codex...";
  }
  const imageCount = attachments.filter((item) => item.kind === "image").length;
  const fileCount = attachments.length - imageCount;
  const parts = [];
  if (imageCount) {
    parts.push(`${imageCount} image${imageCount === 1 ? "" : "s"}`);
  }
  if (fileCount) {
    parts.push(`${fileCount} file${fileCount === 1 ? "" : "s"}`);
  }
  return `Received ${parts.join(" and ")}. Sending to Codex...`;
}
