import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  collectTelegramAttachments,
  formatAttachmentPrompt,
  formatAttachmentReceipt,
  getMessageIngressText,
  hasUnsupportedTelegramMedia,
  saveTelegramAttachments,
} from "../lib/telegram-attachments.mjs";

test("collectTelegramAttachments selects the largest photo", () => {
  const attachments = collectTelegramAttachments({
    message_id: 42,
    photo: [
      { file_id: "small", file_unique_id: "s", width: 100, height: 100, file_size: 1000 },
      { file_id: "large", file_unique_id: "l", width: 1000, height: 1000, file_size: 9000 },
    ],
  });

  assert.equal(attachments.length, 1);
  assert.equal(attachments[0].kind, "image");
  assert.equal(attachments[0].fileId, "large");
  assert.equal(attachments[0].fileName, "telegram-photo-42.jpg");
});

test("collectTelegramAttachments treats image documents as images and sanitizes names", () => {
  const attachments = collectTelegramAttachments({
    message_id: 7,
    document: {
      file_id: "doc-1",
      file_name: "../screen shot.png",
      mime_type: "image/png",
      file_size: 1234,
    },
  });

  assert.equal(attachments[0].kind, "image");
  assert.equal(attachments[0].fileName, "screen shot.png");
  assert.equal(attachments[0].mimeType, "image/png");
});

test("message ingress text prefers text, then caption", () => {
  assert.equal(getMessageIngressText({ text: "hello", caption: "caption" }), "hello");
  assert.equal(getMessageIngressText({ caption: "caption" }), "caption");
  assert.equal(getMessageIngressText({}), "");
});

test("hasUnsupportedTelegramMedia catches voice and video messages", () => {
  assert.equal(hasUnsupportedTelegramMedia({ voice: { file_id: "v" } }), true);
  assert.equal(hasUnsupportedTelegramMedia({ video: { file_id: "v" } }), true);
  assert.equal(hasUnsupportedTelegramMedia({ document: { file_id: "d" } }), false);
});

test("saveTelegramAttachments writes downloaded files under the storage root", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "codex-tg-attachments-"));
  try {
    const saved = await saveTelegramAttachments({
      token: "token",
      storageDir: tmp,
      now: new Date("2026-04-19T10:00:00.000Z"),
      message: {
        chat: { id: -100 },
        message_id: 55,
        photo: [{ file_id: "photo-1", width: 500, height: 500, file_size: 4 }],
      },
      getFile: async () => ({ file_path: "photos/file_1.jpg", file_size: 4 }),
      downloadFile: async () => Buffer.from("jpeg"),
    });

    assert.equal(saved.length, 1);
    assert.equal(saved[0].localPath, path.join(tmp, "2026-04-19", "-100-55", "telegram-photo-55.jpg"));
    assert.equal(await readFile(saved[0].localPath, "utf8"), "jpeg");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("saveTelegramAttachments rejects oversized files before download", async () => {
  await assert.rejects(
    saveTelegramAttachments({
      token: "token",
      storageDir: os.tmpdir(),
      maxBytes: 3,
      message: {
        chat: { id: -100 },
        message_id: 55,
        document: { file_id: "doc", file_name: "big.pdf", file_size: 10 },
      },
      getFile: async () => ({ file_path: "documents/big.pdf", file_size: 10 }),
      downloadFile: async () => Buffer.from("should-not-download"),
    }),
    /too large/,
  );
});

test("formatAttachmentPrompt gives Codex local paths and markdown image hints", () => {
  const text = formatAttachmentPrompt({
    text: "Что тут не так?",
    attachments: [
      {
        kind: "image",
        fileName: "screen.png",
        mimeType: "image/png",
        size: 2048,
        localPath: "/tmp/screen.png",
      },
    ],
  });

  assert.match(text, /^Что тут не так\?/);
  assert.match(text, /local path: \/tmp\/screen\.png/);
  assert.match(text, /markdown image: !\[screen\.png\]\(\/tmp\/screen\.png\)/);
  assert.match(text, /open the file if visual details matter/);
});

test("formatAttachmentReceipt keeps Telegram progress short", () => {
  assert.equal(formatAttachmentReceipt([{ kind: "image" }]), "Received 1 image. Sending to Codex...");
  assert.equal(
    formatAttachmentReceipt([{ kind: "image" }, { kind: "file" }]),
    "Received 1 image and 1 file. Sending to Codex...",
  );
});
