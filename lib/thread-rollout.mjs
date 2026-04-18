import { createHash } from "node:crypto";
import fs from "node:fs/promises";

import { normalizeText } from "./message-routing.mjs";

export const DEFAULT_OUTBOUND_PHASES = ["final_answer"];
const MAX_FULL_RESYNC_BYTES = 5 * 1024 * 1024;

function normalizePhases(phases) {
  const normalized = Array.from(new Set((Array.isArray(phases) ? phases : DEFAULT_OUTBOUND_PHASES).map(String)));
  return normalized.length ? normalized : [...DEFAULT_OUTBOUND_PHASES];
}

function extractOutputText(content) {
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter((item) => item?.type === "output_text")
    .map((item) => String(item?.text ?? ""))
    .join("");
}

export function makeOutboundMirrorSignature({ phase, text }) {
  const normalizedPhase = normalizeText(phase) || "final_answer";
  const normalizedText = normalizeText(text).replace(/\r\n/g, "\n");
  return createHash("sha1").update(`${normalizedPhase}\n${normalizedText}`).digest("hex");
}

export function parseAssistantMirrorLine(line, { phases = DEFAULT_OUTBOUND_PHASES } = {}) {
  const normalizedLine = String(line ?? "").trim();
  if (!normalizedLine) {
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(normalizedLine);
  } catch {
    return null;
  }

  if (parsed?.type !== "response_item") {
    return null;
  }
  const payload = parsed?.payload ?? {};
  if (payload?.type !== "message" || payload?.role !== "assistant") {
    return null;
  }
  const phase = normalizeText(payload?.phase);
  if (!normalizePhases(phases).includes(phase)) {
    return null;
  }
  const text = normalizeText(extractOutputText(payload?.content));
  if (!text) {
    return null;
  }
  return {
    timestamp: parsed?.timestamp ?? null,
    phase,
    text,
    signature: makeOutboundMirrorSignature({ phase, text }),
  };
}

export function parseAssistantMirrorChunk(text, { carry = "", phases = DEFAULT_OUTBOUND_PHASES } = {}) {
  const combined = `${String(carry ?? "")}${String(text ?? "")}`;
  if (!combined) {
    return {
      messages: [],
      trailingPartial: "",
    };
  }

  const rawLines = combined.replace(/\r\n/g, "\n").split("\n");
  const trailingPartial = combined.endsWith("\n") ? "" : rawLines.pop() ?? "";
  const messages = [];

  for (const rawLine of rawLines) {
    const parsed = parseAssistantMirrorLine(rawLine, { phases });
    if (parsed) {
      messages.push(parsed);
    }
  }

  return {
    messages,
    trailingPartial,
  };
}

function normalizeMirrorState(mirrorState, { threadId = null, rolloutPath = null } = {}) {
  return {
    initialized: mirrorState?.initialized === true,
    threadId: normalizeText(threadId || mirrorState?.threadId) || null,
    rolloutPath: normalizeText(rolloutPath || mirrorState?.rolloutPath) || null,
    byteOffset:
      Number.isFinite(mirrorState?.byteOffset) && Number(mirrorState.byteOffset) >= 0 ? Number(mirrorState.byteOffset) : 0,
    partialLine: typeof mirrorState?.partialLine === "string" ? mirrorState.partialLine : "",
    lastSignature: normalizeText(mirrorState?.lastSignature) || null,
    suppressions: Array.isArray(mirrorState?.suppressions) ? mirrorState.suppressions.map(String) : [],
    pendingMessages: Array.isArray(mirrorState?.pendingMessages) ? mirrorState.pendingMessages : [],
  };
}

function findLastSignatureIndex(messages, signature) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.signature === signature) {
      return index;
    }
  }
  return -1;
}

async function readFromOffset(filePath, offset, fileSize) {
  const length = Math.max(0, fileSize - offset);
  if (length === 0) {
    return "";
  }
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

export async function readThreadMirrorDelta({
  rolloutPath,
  mirrorState = null,
  threadId = null,
  phases = DEFAULT_OUTBOUND_PHASES,
}) {
  const normalizedPath = normalizeText(rolloutPath) || null;
  const nextBase = normalizeMirrorState(mirrorState, {
    threadId,
  });
  if (!normalizedPath) {
    return {
      messages: [],
      mirror: nextBase,
    };
  }

  let stats;
  try {
    stats = await fs.stat(normalizedPath);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return {
        messages: [],
        mirror: {
          ...nextBase,
          rolloutPath: normalizedPath,
        },
      };
    }
    throw error;
  }

  const normalizedPhases = normalizePhases(phases);
  const fileSize = Number(stats.size) || 0;
  const pathChanged = Boolean(nextBase.rolloutPath && nextBase.rolloutPath !== normalizedPath);
  const truncated = nextBase.byteOffset > fileSize;
  const needsBootstrap = nextBase.initialized !== true;

  if (needsBootstrap) {
    return {
      messages: [],
      mirror: {
        ...nextBase,
        initialized: true,
        rolloutPath: normalizedPath,
        byteOffset: fileSize,
        partialLine: "",
      },
    };
  }

  if (pathChanged || truncated) {
    if (!nextBase.lastSignature || fileSize > MAX_FULL_RESYNC_BYTES) {
      return {
        messages: [],
        mirror: {
          ...nextBase,
          initialized: true,
          rolloutPath: normalizedPath,
          byteOffset: fileSize,
          partialLine: "",
        },
      };
    }

    const fullText = await fs.readFile(normalizedPath, "utf8");
    const { messages: snapshotMessages, trailingPartial } = parseAssistantMirrorChunk(fullText, {
      phases: normalizedPhases,
    });
    let messages = [];
    const cursor = findLastSignatureIndex(snapshotMessages, nextBase.lastSignature);
    if (cursor >= 0) {
      messages = snapshotMessages.slice(cursor + 1);
    }
    return {
      messages,
      mirror: {
        ...nextBase,
        initialized: true,
        rolloutPath: normalizedPath,
        byteOffset: fileSize,
        partialLine: trailingPartial,
        lastSignature: nextBase.lastSignature,
      },
    };
  }

  if (fileSize === nextBase.byteOffset) {
    return {
      messages: [],
      mirror: {
        ...nextBase,
        rolloutPath: normalizedPath,
      },
    };
  }

  if (fileSize - nextBase.byteOffset > MAX_FULL_RESYNC_BYTES) {
    return {
      messages: [],
      mirror: {
        ...nextBase,
        initialized: true,
        rolloutPath: normalizedPath,
        byteOffset: fileSize,
        partialLine: "",
      },
    };
  }

  const appendedText = await readFromOffset(normalizedPath, nextBase.byteOffset, fileSize);
  const { messages, trailingPartial } = parseAssistantMirrorChunk(appendedText, {
    carry: nextBase.partialLine,
    phases: normalizedPhases,
  });
  return {
    messages,
    mirror: {
      ...nextBase,
      initialized: true,
      rolloutPath: normalizedPath,
      byteOffset: fileSize,
      partialLine: trailingPartial,
    },
  };
}
