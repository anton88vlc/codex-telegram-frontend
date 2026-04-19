import { normalizeText } from "./message-routing.mjs";

export function makePromptPreview(text) {
  const normalized = normalizeText(text).replace(/\s+/g, " ");
  if (normalized.length <= 160) {
    return normalized;
  }
  return `${normalized.slice(0, 157)}...`;
}

export function formatOutboundUserMirrorText(text, config = {}) {
  const normalized = normalizeText(text);
  if (!normalized) {
    return "";
  }
  const displayName = normalizeText(config.codexUserDisplayName).replace(/\s+/g, " ") || "Codex Desktop user";
  return `**${displayName} via Codex Desktop**\n\n${normalized}`;
}

export function isFinalAssistantMirrorMessage(message) {
  return message?.role === "assistant" && (normalizeText(message?.phase) || "final_answer") === "final_answer";
}

export function isCommentaryAssistantMirrorMessage(message) {
  return message?.role === "assistant" && normalizeText(message?.phase) === "commentary";
}

export function isPlanMirrorMessage(message) {
  return message?.role === "plan" && normalizeText(message?.phase) === "update_plan";
}

export function formatOutboundAssistantMirrorText(message) {
  const text = normalizeText(message?.text);
  if (!text || message?.role !== "assistant") {
    return text;
  }
  if ((normalizeText(message?.phase) || "final_answer") !== "commentary") {
    return text;
  }
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => (line.trim() ? `> ${line}` : ">"))
    .join("\n");
}
