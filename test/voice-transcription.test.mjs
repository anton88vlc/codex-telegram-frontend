import test from "node:test";
import assert from "node:assert/strict";

import {
  chooseVoiceTranscriptionProvider,
  collectTelegramVoiceRefs,
  formatVoiceTranscriptBubble,
  formatVoiceTranscriptPrompt,
  formatVoiceTranscriptionReceipt,
  transcribeTelegramVoice,
} from "../lib/voice-transcription.mjs";

test("collectTelegramVoiceRefs extracts Telegram voice metadata", () => {
  const refs = collectTelegramVoiceRefs({
    message_id: 42,
    voice: {
      file_id: "voice-file",
      file_unique_id: "unique",
      mime_type: "audio/ogg",
      duration: 7,
      file_size: 2048,
    },
  });

  assert.equal(refs.length, 1);
  assert.equal(refs[0].kind, "voice");
  assert.equal(refs[0].fileId, "voice-file");
  assert.equal(refs[0].fileName, "telegram-voice-42.ogg");
  assert.equal(refs[0].duration, 7);
});

test("chooseVoiceTranscriptionProvider prefers Deepgram in auto mode", () => {
  assert.deepEqual(
    chooseVoiceTranscriptionProvider({
      voiceTranscriptionProvider: "auto",
      voiceTranscriptionDeepgramApiKey: "dg",
      voiceTranscriptionDeepgramApiKeySource: "env DEEPGRAM_API_KEY",
      voiceTranscriptionOpenAIApiKey: "oa",
      voiceTranscriptionModel: "",
    }),
    {
      provider: "deepgram",
      apiKey: "dg",
      apiKeySource: "env DEEPGRAM_API_KEY",
      model: "nova-3",
    },
  );
});

test("transcribeTelegramVoice sends OGG bytes to Deepgram without writing permanent files", async () => {
  const fetchCalls = [];
  const transcripts = await transcribeTelegramVoice({
    token: "bot-token",
    config: {
      voiceTranscriptionProvider: "deepgram",
      voiceTranscriptionDeepgramApiKey: "dg-key",
      voiceTranscriptionModel: "nova-3",
      voiceTranscriptionLanguage: "multi",
    },
    message: {
      chat: { id: -100 },
      message_id: 55,
      voice: {
        file_id: "voice-file",
        mime_type: "audio/ogg",
        duration: 3,
        file_size: 4,
      },
    },
    getFile: async () => ({ file_path: "voice/file_55.oga", file_size: 4 }),
    downloadFile: async () => Buffer.from("opus"),
    fetchImpl: async (url, options) => {
      fetchCalls.push({ url: String(url), options });
      return new Response(
        JSON.stringify({
          results: {
            channels: [
              {
                detected_language: "ru",
                alternatives: [{ transcript: "Привет из войса", confidence: 0.97 }],
              },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });

  assert.equal(fetchCalls.length, 1);
  assert.match(fetchCalls[0].url, /https:\/\/api\.deepgram\.com\/v1\/listen/);
  assert.match(fetchCalls[0].url, /model=nova-3/);
  assert.match(fetchCalls[0].url, /language=multi/);
  assert.equal(fetchCalls[0].options.headers.authorization, "Token dg-key");
  assert.equal(fetchCalls[0].options.headers["content-type"], "audio/ogg");
  assert.equal(Buffer.from(fetchCalls[0].options.body).toString("utf8"), "opus");
  assert.equal(transcripts[0].text, "Привет из войса");
  assert.equal(transcripts[0].detectedLanguage, "ru");
});

test("formats transcript bubble and Codex prompt", () => {
  const transcripts = [
    {
      kind: "voice",
      mimeType: "audio/ogg",
      duration: 8,
      provider: "deepgram",
      model: "nova-3",
      detectedLanguage: "ru",
      text: "Сделай короткий статус проекта.",
    },
  ];

  const bubble = formatVoiceTranscriptBubble(transcripts);
  assert.equal(bubble, "_«Сделай короткий статус проекта.»_");
  assert.doesNotMatch(bubble, /Voice transcript/);
  assert.doesNotMatch(bubble, /voice, 8s/);
  assert.match(bubble, /Сделай короткий статус проекта\./);

  const prompt = formatVoiceTranscriptPrompt({
    text: "Context before voice",
    transcripts,
  });
  assert.match(prompt, /^Context before voice/);
  assert.match(prompt, /\[Telegram voice transcript\]/);
  assert.match(prompt, /stt deepgram\/nova-3/);
});

test("voice transcription receipt stays quiet because the transcript bubble is enough", () => {
  assert.equal(formatVoiceTranscriptionReceipt([{ text: "Привет" }]), "");
});
