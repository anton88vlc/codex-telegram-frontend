import { normalizeText } from "./message-routing.mjs";
import { rememberOutboundSuppression } from "./state.mjs";
import { makeOutboundMirrorSignature } from "./thread-rollout.mjs";

export function rememberOutbound(binding, sentMessages) {
  if (!binding || !Array.isArray(sentMessages)) {
    return;
  }
  binding.lastOutboundMessageIds = sentMessages
    .map((item) => item?.message_id)
    .filter((value) => Number.isInteger(value));
}

export function rememberOutboundMirrorSuppressionForText(
  state,
  bindingKey,
  text,
  { role = "assistant", phase = "final_answer" } = {},
) {
  const normalizedText = normalizeText(text);
  if (!normalizedText) {
    return null;
  }
  const signature = makeOutboundMirrorSignature({
    role,
    phase,
    text: normalizedText,
  });
  rememberOutboundSuppression(state, bindingKey, signature);
  return signature;
}
