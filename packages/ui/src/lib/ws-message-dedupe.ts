const DEFAULT_MAX_SEEN_MESSAGES = 5_000;

export type WsMessageDedupeState = {
  order: string[];
  seen: Set<string>;
};

export function createWsMessageDedupeState(): WsMessageDedupeState {
  return { order: [], seen: new Set() };
}

export function rememberWsMessage(
  state: WsMessageDedupeState,
  rawMessage: string,
  maxSeenMessages = DEFAULT_MAX_SEEN_MESSAGES,
): boolean {
  if (state.seen.has(rawMessage)) {
    return false;
  }

  state.seen.add(rawMessage);
  state.order.push(rawMessage);

  while (state.order.length > maxSeenMessages) {
    const oldest = state.order.shift();
    if (oldest) {
      state.seen.delete(oldest);
    }
  }

  return true;
}
