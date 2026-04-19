import { isClosedSyncBinding } from "./project-sync.mjs";

export function isOutboundMirrorBindingEligible(binding) {
  if (!binding?.threadId) {
    return false;
  }
  if ((binding.transport || "native") !== "native") {
    return false;
  }
  if (isClosedSyncBinding(binding)) {
    return false;
  }
  if (!binding.chatId) {
    return false;
  }
  return true;
}

export function isStatusBarBindingEligible(binding) {
  if (!isOutboundMirrorBindingEligible(binding)) {
    return false;
  }
  return binding.messageThreadId != null;
}
