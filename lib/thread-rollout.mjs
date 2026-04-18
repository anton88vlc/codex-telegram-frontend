import { createHash } from "node:crypto";
import fs from "node:fs/promises";

import { normalizeText } from "./message-routing.mjs";

export const DEFAULT_OUTBOUND_PHASES = ["final_answer"];
const MAX_FULL_RESYNC_BYTES = 5 * 1024 * 1024;
const USER_FILES_HEADER = "# Files mentioned by the user:";
const CODEX_APP_DIRECTIVE_LINE = /^::[a-z][\w-]*\{.*\}\s*$/i;
const MEMORY_CITATION_BLOCK_PATTERN = /<oai-mem-citation>[\s\S]*?(?:<\/oai-mem-citation>|$)/gi;
const MEMORY_CITATION_CHILD_BLOCK_PATTERN = /<(?:citation_entries|rollout_ids)>[\s\S]*?<\/(?:citation_entries|rollout_ids)>/gi;

function normalizePhases(phases) {
  const normalized = Array.from(new Set((Array.isArray(phases) ? phases : DEFAULT_OUTBOUND_PHASES).map(String)));
  return normalized.length ? normalized : [...DEFAULT_OUTBOUND_PHASES];
}

function extractTextParts(content) {
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter((item) => item?.type === "output_text" || item?.type === "input_text")
    .map((item) => String(item?.text ?? ""))
    .join("");
}

export function cleanupMirrorUserText(text) {
  const normalized = normalizeText(text);
  if (!normalized) {
    return null;
  }
  if (normalized.startsWith("# AGENTS.md instructions")) {
    return null;
  }
  if (normalized.startsWith("<turn_aborted>")) {
    return null;
  }
  if (normalized.startsWith("<heartbeat>")) {
    return null;
  }
  if (normalized.startsWith(USER_FILES_HEADER)) {
    const requestMarker = "## My request for Codex:";
    const files = [];
    for (const line of normalized.split("\n")) {
      const stripped = line.trim();
      if (stripped.startsWith("## ") && stripped.endsWith(":") && stripped !== requestMarker) {
        files.push(stripped.slice(3, -1).trim());
      }
    }

    const request = normalized.includes(requestMarker) ? normalized.split(requestMarker, 2)[1].trim() : normalized;
    const cleanedLines = [];
    let imageCount = 0;
    for (const line of request.split("\n")) {
      const stripped = line.trim();
      if (stripped.startsWith("<image ") || stripped === "</image>") {
        if (stripped.startsWith("<image ")) {
          imageCount += 1;
        }
        continue;
      }
      cleanedLines.push(line);
    }

    const body = cleanedLines.join("\n").trim();
    const parts = [];
    if (files.length) {
      parts.push(`[files]\n${files.map((name) => `- ${name}`).join("\n")}`);
    }
    if (imageCount) {
      parts.push(`[attached images omitted: ${imageCount}]`);
    }
    if (body) {
      parts.push(body);
    }
    return parts.join("\n\n").trim() || null;
  }
  return normalized;
}

export function cleanupMirrorAssistantText(text) {
  const normalized = normalizeText(text).replace(/\r\n/g, "\n");
  if (!normalized) {
    return null;
  }
  const withoutInternalBlocks = normalized
    .replace(MEMORY_CITATION_BLOCK_PATTERN, "")
    .replace(MEMORY_CITATION_CHILD_BLOCK_PATTERN, "");
  const cleaned = withoutInternalBlocks
    .split("\n")
    .filter((line) => !CODEX_APP_DIRECTIVE_LINE.test(line.trim()))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return cleaned || null;
}

export function makeOutboundMirrorSignature({ role = "assistant", phase, text }) {
  const normalizedRole = normalizeText(role) || "assistant";
  const normalizedPhase = normalizeText(phase) || "final_answer";
  const normalizedText = normalizeText(text).replace(/\r\n/g, "\n");
  if (normalizedRole === "assistant") {
    return createHash("sha1").update(`${normalizedPhase}\n${normalizedText}`).digest("hex");
  }
  return createHash("sha1").update(`${normalizedRole}\n${normalizedText}`).digest("hex");
}

export function parseThreadMirrorLine(line, { phases = DEFAULT_OUTBOUND_PHASES } = {}) {
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
  const role = normalizeText(payload?.role);
  if (payload?.type !== "message" || !["assistant", "user"].includes(role)) {
    return null;
  }

  if (role === "assistant") {
    const phase = normalizeText(payload?.phase);
    if (!normalizePhases(phases).includes(phase)) {
      return null;
    }
    const text = cleanupMirrorAssistantText(extractTextParts(payload?.content));
    if (!text) {
      return null;
    }
    return {
      timestamp: parsed?.timestamp ?? null,
      role,
      phase,
      text,
      signature: makeOutboundMirrorSignature({ role, phase, text }),
    };
  }

  const text = cleanupMirrorUserText(extractTextParts(payload?.content));
  if (!text) {
    return null;
  }
  return {
    timestamp: parsed?.timestamp ?? null,
    role,
    phase: null,
    text,
    signature: makeOutboundMirrorSignature({ role, text }),
  };
}

export function parseThreadMirrorChunk(text, { carry = "", phases = DEFAULT_OUTBOUND_PHASES } = {}) {
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
    const parsed = parseThreadMirrorLine(rawLine, { phases });
    if (parsed) {
      messages.push(parsed);
    }
  }

  return {
    messages,
    trailingPartial,
  };
}

export function parseAssistantMirrorLine(line, { phases = DEFAULT_OUTBOUND_PHASES } = {}) {
  const parsed = parseThreadMirrorLine(line, { phases });
  return parsed?.role === "assistant" ? parsed : null;
}

export function parseAssistantMirrorChunk(text, { carry = "", phases = DEFAULT_OUTBOUND_PHASES } = {}) {
  const parsed = parseThreadMirrorChunk(text, { carry, phases });
  return {
    trailingPartial: parsed.trailingPartial,
    messages: parsed.messages.filter((item) => item.role === "assistant"),
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
    const { messages: snapshotMessages, trailingPartial } = parseThreadMirrorChunk(fullText, {
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
  const { messages, trailingPartial } = parseThreadMirrorChunk(appendedText, {
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
