import { editMessageText } from "./telegram.mjs";

const PROGRESS_STEPS = [
  { delayMs: 2_500, text: "Sent to Codex. Waiting for a reply..." },
  { delayMs: 6_000, text: "Still waiting for Codex..." },
  {
    delayMs: 14_000,
    text: "Still waiting. If the Mac slept, Codex restarted, or the connection hiccuped, this may recover or time out.",
  },
  {
    delayMs: 30_000,
    text: "Still waiting for a final reply. I will replace this with the answer or a clear transport error.",
  },
];

export function getInitialProgressText() {
  return "Sent to Codex. Waiting for a reply...";
}

export function getProgressStepTexts() {
  return PROGRESS_STEPS.map((step) => step.text);
}

export function startProgressBubble({ token, target, messageId, onError = null }) {
  let stopped = false;
  let cumulativeDelayMs = 0;
  let lastText = getInitialProgressText();
  const timers = [];

  for (const step of PROGRESS_STEPS) {
    cumulativeDelayMs += step.delayMs;
    const timer = setTimeout(async () => {
      if (stopped || !messageId || step.text === lastText) {
        return;
      }
      try {
        await editMessageText(token, {
          chatId: target.chatId,
          messageId,
          text: step.text,
        });
        lastText = step.text;
      } catch (error) {
        if (typeof onError === "function") {
          onError(error);
        }
      }
    }, cumulativeDelayMs);
    timers.push(timer);
  }

  return {
    async stop() {
      stopped = true;
      for (const timer of timers) {
        clearTimeout(timer);
      }
    },
  };
}
