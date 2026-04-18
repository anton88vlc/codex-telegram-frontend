import { editMessageText } from "./telegram.mjs";

const PROGRESS_STEPS = [
  { delayMs: 2_500, text: "Got it. Sending this to Codex..." },
  { delayMs: 6_000, text: "Codex is thinking..." },
  { delayMs: 14_000, text: "Codex is still working..." },
  { delayMs: 30_000, text: "Codex is not stuck; this one is just taking longer than usual..." },
];

export function getInitialProgressText() {
  return "Got it. Sending this to Codex...";
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
