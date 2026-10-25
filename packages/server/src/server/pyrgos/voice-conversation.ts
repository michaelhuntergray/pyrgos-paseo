import type {
  VoiceConversation,
  VoiceConversationEvent,
  VoiceConversationIO,
} from "../session/voice/voice-session.js";
import { createPyrgosConversation, type PyrgosConversationOptions } from "./conversation.js";

/** Voice conversation is on unless PYRGOS_VOICE_CONVERSATION=0. */
export function pyrgosConversationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PYRGOS_VOICE_CONVERSATION !== "0";
}

/**
 * The factory a VoiceSession takes as its `conversation` option, or undefined when the feature is
 * off. Maps the conversation agent's events to what the voice session plays.
 */
export function createVoiceConversationFactory(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<PyrgosConversationOptions> = {},
):
  | ((
      onEvent: (event: VoiceConversationEvent) => void,
      io: VoiceConversationIO,
    ) => Promise<VoiceConversation>)
  | undefined {
  if (!pyrgosConversationEnabled(env)) return undefined;
  return (onEvent, io) =>
    createPyrgosConversation({
      env,
      speakReply: io.speak,
      ...overrides,
      onEvent: (event) => {
        if (event.type === "speak") onEvent({ type: "speak", text: event.text, kind: event.kind });
        else if (event.type === "error") onEvent({ type: "error", message: event.message });
        else onEvent({ type: "other" });
      },
    });
}
