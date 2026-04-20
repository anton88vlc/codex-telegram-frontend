import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

export const DEFAULT_VOICE_TRANSCRIPTION_MAX_BYTES = 25 * 1024 * 1024;
export const DEFAULT_VOICE_TRANSCRIPTION_PROVIDER = "auto";
export const DEFAULT_OPENAI_TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe";
export const DEFAULT_DEEPGRAM_TRANSCRIPTION_MODEL = "nova-3";
export const DEFAULT_DEEPGRAM_TRANSCRIPTION_LANGUAGE = "multi";

const execFileAsync = promisify(execFile);

function cleanText(value) {
  return String(value ?? "").trim();
}

function sanitizeFileName(value, fallback = "telegram-voice") {
  const baseName = path.basename(cleanText(value).replace(/\\/g, "/"));
  const name = baseName
    .replace(/[/\\?%*:|"<>]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^\.+/, "")
    .trim();
  return name || fallback;
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

function formatDuration(seconds) {
  const number = Number(seconds);
  if (!Number.isFinite(number) || number <= 0) {
    return null;
  }
  if (number < 60) {
    return `${Math.round(number)}s`;
  }
  const mins = Math.floor(number / 60);
  const secs = Math.round(number % 60);
  return `${mins}m ${String(secs).padStart(2, "0")}s`;
}

function getSourceMessages(message = {}) {
  return Array.isArray(message.telegramMediaGroupMessages) && message.telegramMediaGroupMessages.length
    ? message.telegramMediaGroupMessages
    : [message];
}

function buildAudioRef(sourceMessage, fallbackMessage = sourceMessage) {
  const voice = sourceMessage?.voice;
  if (voice?.file_id) {
    const messageId = sourceMessage.message_id || fallbackMessage.message_id || Date.now();
    return {
      kind: "voice",
      source: "voice",
      sourceMessageId: sourceMessage.message_id ?? null,
      fileId: voice.file_id,
      fileUniqueId: voice.file_unique_id || null,
      fileName: `telegram-voice-${messageId}.ogg`,
      mimeType: cleanText(voice.mime_type) || "audio/ogg",
      size: Number(voice.file_size) || null,
      duration: Number(voice.duration) || null,
    };
  }

  const audio = sourceMessage?.audio;
  if (audio?.file_id) {
    const messageId = sourceMessage.message_id || fallbackMessage.message_id || Date.now();
    return {
      kind: "audio",
      source: "audio",
      sourceMessageId: sourceMessage.message_id ?? null,
      fileId: audio.file_id,
      fileUniqueId: audio.file_unique_id || null,
      fileName: sanitizeFileName(audio.file_name, `telegram-audio-${messageId}`),
      mimeType: cleanText(audio.mime_type) || "audio/mpeg",
      size: Number(audio.file_size) || null,
      duration: Number(audio.duration) || null,
      title: cleanText(audio.title) || null,
      performer: cleanText(audio.performer) || null,
    };
  }

  return null;
}

export function normalizeVoiceTranscriptionProvider(value) {
  const provider = cleanText(value).toLowerCase();
  return ["auto", "openai", "deepgram", "command"].includes(provider)
    ? provider
    : DEFAULT_VOICE_TRANSCRIPTION_PROVIDER;
}

export function collectTelegramVoiceRefs(message = {}, { maxCount = 1 } = {}) {
  const refs = [];
  for (const sourceMessage of getSourceMessages(message)) {
    const ref = buildAudioRef(sourceMessage, message);
    if (ref) {
      refs.push(ref);
    }
  }
  return refs.slice(0, Math.max(1, Number(maxCount) || 1));
}

export function hasTelegramVoice(message = {}) {
  return collectTelegramVoiceRefs(message).length > 0;
}

export function chooseVoiceTranscriptionProvider(config = {}) {
  const provider = normalizeVoiceTranscriptionProvider(config.voiceTranscriptionProvider);
  const command = Array.isArray(config.voiceTranscriptionCommand)
    ? config.voiceTranscriptionCommand.filter(Boolean).map(String)
    : [];
  const candidates =
    provider === "auto"
      ? ["deepgram", "openai", "command"]
      : [provider];

  for (const candidate of candidates) {
    if (candidate === "deepgram" && config.voiceTranscriptionDeepgramApiKey) {
      return {
        provider: "deepgram",
        apiKey: config.voiceTranscriptionDeepgramApiKey,
        apiKeySource: config.voiceTranscriptionDeepgramApiKeySource || "configured",
        model: cleanText(config.voiceTranscriptionModel) || DEFAULT_DEEPGRAM_TRANSCRIPTION_MODEL,
      };
    }
    if (candidate === "openai" && config.voiceTranscriptionOpenAIApiKey) {
      return {
        provider: "openai",
        apiKey: config.voiceTranscriptionOpenAIApiKey,
        apiKeySource: config.voiceTranscriptionOpenAIApiKeySource || "configured",
        model: cleanText(config.voiceTranscriptionModel) || DEFAULT_OPENAI_TRANSCRIPTION_MODEL,
      };
    }
    if (candidate === "command" && command.length) {
      return {
        provider: "command",
        command,
        model: cleanText(config.voiceTranscriptionModel) || "external",
      };
    }
  }

  return null;
}

function getDeepgramLanguage(config = {}) {
  const value = cleanText(config.voiceTranscriptionLanguage);
  return value || DEFAULT_DEEPGRAM_TRANSCRIPTION_LANGUAGE;
}

function getOpenAILanguage(config = {}) {
  const value = cleanText(config.voiceTranscriptionLanguage);
  return value && value !== "multi" && value !== "auto" ? value : "";
}

async function parseJsonResponse(response, label) {
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {}
  if (!response.ok) {
    const detail = payload?.error?.message || payload?.err_msg || payload?.message || text || `HTTP ${response.status}`;
    throw new Error(`${label} transcription failed: ${detail}`);
  }
  return payload || {};
}

async function transcribeWithDeepgram({ bytes, audioRef, apiKey, model, config, fetchImpl = fetch }) {
  if (!apiKey) {
    throw new Error("missing Deepgram API key for voice transcription");
  }

  const baseUrl = cleanText(config.voiceTranscriptionBaseUrl) || "https://api.deepgram.com";
  const url = new URL("/v1/listen", baseUrl.replace(/\/+$/, ""));
  url.searchParams.set("model", model || DEFAULT_DEEPGRAM_TRANSCRIPTION_MODEL);
  url.searchParams.set("smart_format", "true");
  url.searchParams.set("punctuate", "true");
  const language = getDeepgramLanguage(config);
  if (language === "auto") {
    url.searchParams.set("detect_language", "true");
  } else if (language) {
    url.searchParams.set("language", language);
  }

  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      authorization: `Token ${apiKey}`,
      "content-type": audioRef.mimeType || "application/octet-stream",
    },
    body: bytes,
  });
  const payload = await parseJsonResponse(response, "deepgram");
  const alternative = payload?.results?.channels?.[0]?.alternatives?.[0] || {};
  const transcript = cleanText(alternative.transcript);
  if (!transcript) {
    throw new Error("deepgram transcription returned an empty transcript");
  }
  return {
    text: transcript,
    confidence: Number.isFinite(Number(alternative.confidence)) ? Number(alternative.confidence) : null,
    detectedLanguage: payload?.results?.channels?.[0]?.detected_language || null,
  };
}

async function transcribeWithOpenAI({ bytes, audioRef, apiKey, model, config, fetchImpl = fetch }) {
  if (!apiKey) {
    throw new Error("missing OpenAI API key for voice transcription");
  }

  const baseUrl = cleanText(config.voiceTranscriptionBaseUrl) || "https://api.openai.com/v1";
  const form = new FormData();
  form.set("model", model || DEFAULT_OPENAI_TRANSCRIPTION_MODEL);
  form.set("file", new Blob([bytes], { type: audioRef.mimeType || "application/octet-stream" }), audioRef.fileName);
  form.set("response_format", "json");
  const language = getOpenAILanguage(config);
  const prompt = cleanText(config.voiceTranscriptionPrompt);
  if (language) {
    form.set("language", language);
  }
  if (prompt) {
    form.set("prompt", prompt);
  }

  const response = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/audio/transcriptions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
    },
    body: form,
  });
  const payload = await parseJsonResponse(response, "openai");
  const transcript = cleanText(payload.text);
  if (!transcript) {
    throw new Error("openai transcription returned an empty transcript");
  }
  return { text: transcript, confidence: null, detectedLanguage: null };
}

function parseCommandOutput(stdout) {
  const text = cleanText(stdout);
  if (!text) {
    return "";
  }
  try {
    const payload = JSON.parse(text);
    return cleanText(payload.text || payload.transcript || payload.result);
  } catch {
    return text;
  }
}

async function transcribeWithCommand({
  bytes,
  audioRef,
  command,
  config,
  execFileImpl = execFileAsync,
}) {
  if (!Array.isArray(command) || !command.length) {
    throw new Error("missing voice transcription command");
  }

  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-voice-"));
  const localPath = path.join(tmpRoot, sanitizeFileName(audioRef.fileName, "telegram-voice.ogg"));
  try {
    await writeFile(localPath, bytes);
    const [cmd, ...rawArgs] = command;
    const args = rawArgs.length
      ? rawArgs.map((arg) => String(arg).replaceAll("{file}", localPath))
      : [localPath];
    if (!args.some((arg) => arg.includes(localPath))) {
      args.push(localPath);
    }
    const { stdout } = await execFileImpl(cmd, args, {
      timeout: Math.max(1_000, Number(config.voiceTranscriptionTimeoutMs) || 60_000),
      env: {
        ...process.env,
        CODEX_TELEGRAM_AUDIO_FILE: localPath,
        CODEX_TELEGRAM_AUDIO_MIME_TYPE: audioRef.mimeType || "",
      },
    });
    const transcript = parseCommandOutput(stdout);
    if (!transcript) {
      throw new Error("voice transcription command returned an empty transcript");
    }
    return { text: transcript, confidence: null, detectedLanguage: null };
  } finally {
    if (config.voiceTranscriptionKeepFiles !== true) {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  }
}

export async function transcribeTelegramVoice({
  token,
  message,
  config = {},
  maxBytes = DEFAULT_VOICE_TRANSCRIPTION_MAX_BYTES,
  maxCount = 1,
  getFile,
  downloadFile,
  fetchImpl = fetch,
  execFileImpl = execFileAsync,
} = {}) {
  if (!token) {
    throw new Error("missing Telegram bot token for voice download");
  }
  if (typeof getFile !== "function" || typeof downloadFile !== "function") {
    throw new Error("missing Telegram file helpers for voice transcription");
  }
  const selected = chooseVoiceTranscriptionProvider(config);
  if (!selected) {
    throw new Error("voice transcription is not configured");
  }

  const refs = collectTelegramVoiceRefs(message, { maxCount });
  const transcripts = [];
  for (const audioRef of refs) {
    const remoteFile = await getFile(token, { fileId: audioRef.fileId });
    const fileSize = Number(remoteFile?.file_size || audioRef.size || 0);
    if (Number.isFinite(fileSize) && fileSize > Number(maxBytes)) {
      throw new Error(`voice ${audioRef.fileName} is too large (${formatBytes(fileSize)}); max is ${formatBytes(maxBytes)}`);
    }
    if (!remoteFile?.file_path) {
      throw new Error(`Telegram did not return file_path for ${audioRef.fileName}`);
    }

    const bytes = await downloadFile(token, { filePath: remoteFile.file_path });
    if (bytes.length > Number(maxBytes)) {
      throw new Error(`voice ${audioRef.fileName} is too large (${formatBytes(bytes.length)}); max is ${formatBytes(maxBytes)}`);
    }

    let result;
    if (selected.provider === "deepgram") {
      result = await transcribeWithDeepgram({
        bytes,
        audioRef,
        apiKey: selected.apiKey,
        model: selected.model,
        config,
        fetchImpl,
      });
    } else if (selected.provider === "openai") {
      result = await transcribeWithOpenAI({
        bytes,
        audioRef,
        apiKey: selected.apiKey,
        model: selected.model,
        config,
        fetchImpl,
      });
    } else {
      result = await transcribeWithCommand({
        bytes,
        audioRef,
        command: selected.command,
        config,
        execFileImpl,
      });
    }

    transcripts.push({
      ...audioRef,
      provider: selected.provider,
      model: selected.model,
      size: bytes.length,
      telegramFilePath: remoteFile.file_path,
      text: result.text,
      confidence: result.confidence,
      detectedLanguage: result.detectedLanguage,
    });
  }
  return transcripts;
}

export function formatVoiceTranscriptBubble(transcripts = []) {
  const items = transcripts.filter((item) => cleanText(item.text));
  if (!items.length) {
    return "_«Empty voice transcript.»_";
  }

  return items
    .map((item) => cleanText(item.text))
    .map((text) =>
      text
        .replace(/\r\n/g, "\n")
        .split("\n")
        .map((line) => `_«${line || " "}»_`)
        .join("\n"),
    )
    .join("\n\n");
}

export function formatVoiceTranscriptPrompt({ text = "", transcripts = [] } = {}) {
  const promptText = cleanText(text);
  const lines = [];
  if (promptText) {
    lines.push(promptText, "");
  }
  lines.push("[Telegram voice transcript]");
  transcripts.forEach((item, index) => {
    const duration = formatDuration(item.duration);
    const meta = [
      item.kind || "audio",
      item.mimeType || "unknown",
      duration,
      item.detectedLanguage ? `lang ${item.detectedLanguage}` : null,
      item.provider ? `stt ${item.provider}/${item.model || "default"}` : null,
    ].filter(Boolean);
    lines.push(`${index + 1}. ${meta.join(", ")}`);
    lines.push(item.text);
  });
  lines.push("", "Use the transcript above as the user's spoken message and respond to the thread.");
  return lines.join("\n");
}

export function formatVoiceTranscriptionReceipt() {
  return "";
}
