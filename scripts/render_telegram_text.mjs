#!/usr/bin/env node

import process from "node:process";

import { renderTelegramChunks } from "../lib/telegram-format.mjs";

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const raw = await new Promise((resolve, reject) => {
  let data = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    data += chunk;
  });
  process.stdin.on("end", () => resolve(data));
  process.stdin.on("error", reject);
});
const input = raw.trim() ? JSON.parse(raw) : {};
const texts = input?.texts;
if (!Array.isArray(texts)) {
  fail("expected JSON payload: {\"texts\":[...]}");
}

const rendered = texts.map((text) => renderTelegramChunks(String(text ?? "")));
process.stdout.write(`${JSON.stringify({ rendered })}\n`);
