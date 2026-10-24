import { Readable } from "node:stream";
import type { VoiceSpeakHandler } from "../../voice-types.js";
import { EventEmitter } from "node:events";
import pino from "pino";
import { describe, expect, test, vi } from "vitest";

import {
  VoiceSession,
  type VoiceConversation,
  type VoiceSessionHost,
  type VoiceSessionOptions,
} from "./voice-session.js";
import type { ManagedAgent } from "../../agent/agent-manager.js";
import type { SessionOutboundMessage } from "../../messages.js";
import type {
  SpeechToTextProvider,
  TextToSpeechProvider,
  StreamingTranscriptionCommittedEvent,
  StreamingTranscriptionEvent,
  StreamingTranscriptionSession,
} from "../../speech/speech-provider.js";
import type {
  TurnDetectionProvider,
  TurnDetectionSession,
} from "../../speech/turn-detection-provider.js";

const VOICE_AGENT_ID = "11111111-1111-4111-8111-111111111111";

class FakeVoiceTurnDetectionSession extends EventEmitter implements TurnDetectionSession {
  public readonly requiredSampleRate = 16000;

  async connect(): Promise<void> {}

  appendPcm16(_chunk: Buffer): void {}

  flush(): void {}
  reset(): void {}
  close(): void {}
}

class FakeVoiceSttSession extends EventEmitter implements StreamingTranscriptionSession {
  public readonly requiredSampleRate = 16000;
  public commitCount = 0;

  async connect(): Promise<void> {}

  appendPcm16(_pcm16le: Buffer): void {}

  commit(): void {
    this.commitCount += 1;
  }

  clear(): void {}
  close(): void {}

  emitCommitted(event: StreamingTranscriptionCommittedEvent): void {
    this.emit("committed", event);
  }

  emitTranscript(event: StreamingTranscriptionEvent): void {
    this.emit("transcript", event);
  }
}

interface FakeVoiceHost extends VoiceSessionHost {
  readonly emitted: SessionOutboundMessage[];
  readonly spokenInput: Array<{ agentId: string; text: string }>;
}

function createFakeHost(): FakeVoiceHost {
  const emitted: SessionOutboundMessage[] = [];
  const spokenInput: Array<{ agentId: string; text: string }> = [];
  return {
    emitted,
    spokenInput,
    emit: (msg) => {
      emitted.push(msg);
    },
    loadAgent: async (agentId) =>
      ({ id: agentId, config: { systemPrompt: undefined } }) as unknown as ManagedAgent,
    reloadAgentSession: async (agentId) => ({ id: agentId }) as unknown as ManagedAgent,
    sendSpokenInput: async (agentId, text) => {
      spokenInput.push({ agentId, text });
    },
    interruptAgentIfRunning: async () => {},
    hasActiveAgentRun: () => false,
  };
}

function createVoiceSession(
  tts: TextToSpeechProvider | null = null,
  conversation?: VoiceSessionOptions["conversation"],
  logger: pino.Logger = pino({ level: "silent" }),
) {
  let speakHandler: VoiceSpeakHandler | undefined;
  const detector = new FakeVoiceTurnDetectionSession();
  const sttSession = new FakeVoiceSttSession();
  const stt: SpeechToTextProvider = {
    id: "local",
    createSession: vi.fn(() => sttSession),
  };
  const turnDetection: TurnDetectionProvider = {
    id: "local",
    createSession: vi.fn(() => detector),
  };
  const host = createFakeHost();
  const voiceSession = new VoiceSession({
    host,
    logger,
    sessionId: "voice-session-test",
    sttLanguage: "en",
    conversation,
    tts,
    voiceBridge: {
      registerVoiceSpeakHandler: (_id, handler) => {
        speakHandler = handler;
      },
    },
    stt,
    voice: { turnDetection },
  });
  return {
    voiceSession,
    detector,
    sttSession,
    host,
    speak: (args: Parameters<VoiceSpeakHandler>[0]) => {
      if (!speakHandler) throw new Error("Voice speak handler not registered");
      return speakHandler(args);
    },
  };
}

function isAudioOutput(message: SessionOutboundMessage): boolean {
  return message.type === "audio_output";
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("VoiceSession conversation", () => {
  test("sends the final transcript to the conversation, plays its speech and barges in", async () => {
    const tts: TextToSpeechProvider = {
      async synthesizeSpeech() {
        return { stream: Readable.from([Buffer.from("audio")]), format: "pcm;rate=24000" };
      },
    };
    const heard: string[] = [];
    const bargeIn = vi.fn(async () => {});
    const close = vi.fn(async () => {});
    const { voiceSession, detector, sttSession, host } = createVoiceSession(
      tts,
      async (onEvent) => ({
        handleTranscript: async (text) => {
          heard.push(text);
          onEvent({ type: "speak", text: "Drafted it.", kind: "reply" });
        },
        bargeIn,
        close,
      }),
    );

    await voiceSession.handleSetVoiceMode(true, VOICE_AGENT_ID);
    detector.emit("speech_started");
    await settle();
    detector.emit("speech_stopped");
    await settle();
    sttSession.emitCommitted({ segmentId: "s1", previousSegmentId: null });
    sttSession.emitTranscript({
      segmentId: "s1",
      transcript: "add a readme line",
      isFinal: true,
      language: "en",
      avgLogprob: -0.1,
      isLowConfidence: false,
    });
    await vi.waitFor(() => expect(host.emitted.filter(isAudioOutput).length).toBeGreaterThan(0));
    expect(heard).toEqual(["add a readme line"]);
    expect(host.spokenInput).toEqual([]);
    await vi.waitFor(() =>
      expect(host.emitted).toContainEqual(
        expect.objectContaining({
          type: "activity_log",
          payload: expect.objectContaining({ type: "assistant", content: "Drafted it." }),
        }),
      ),
    );

    detector.emit("speech_started");
    await settle();
    expect(bargeIn).toHaveBeenCalled();

    await voiceSession.cleanup();
    expect(close).toHaveBeenCalled();
  });

  test("redacts secrets from conversation speech before TTS and the activity log", async () => {
    const tts: TextToSpeechProvider = {
      async synthesizeSpeech() {
        return { stream: Readable.from([Buffer.from("audio")]), format: "pcm;rate=24000" };
      },
    };
    const spoken: string[] = [];
    const synth = vi.spyOn(tts, "synthesizeSpeech").mockImplementation(async (text: string) => {
      spoken.push(text);
      return { stream: Readable.from([Buffer.from("audio")]), format: "pcm;rate=24000" };
    });
    const { voiceSession, detector, sttSession, host } = createVoiceSession(
      tts,
      async (onEvent) => ({
        handleTranscript: async () => {
          onEvent({
            type: "speak",
            text: "The config says API_KEY=hunter2secret ok",
            kind: "reply",
          });
        },
        bargeIn: async () => {},
        close: async () => {},
      }),
    );
    await voiceSession.handleSetVoiceMode(true, VOICE_AGENT_ID);
    detector.emit("speech_started");
    await settle();
    detector.emit("speech_stopped");
    await settle();
    sttSession.emitCommitted({ segmentId: "s1", previousSegmentId: null });
    sttSession.emitTranscript({
      segmentId: "s1",
      transcript: "read the config",
      isFinal: true,
      language: "en",
      avgLogprob: -0.1,
      isLowConfidence: false,
    });
    await vi.waitFor(() => expect(spoken.length).toBeGreaterThan(0));
    expect(synth).toHaveBeenCalled();
    expect(spoken.join(" ")).not.toContain("hunter2secret");
    expect(JSON.stringify(host.emitted)).not.toContain("hunter2secret");
    await voiceSession.cleanup();
  });

  test("cleanup does not hang when the conversation factory never resolves", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const tts: TextToSpeechProvider = {
        async synthesizeSpeech() {
          return { stream: Readable.from([Buffer.from("audio")]), format: "pcm;rate=24000" };
        },
      };
      const { voiceSession, detector, sttSession } = createVoiceSession(
        tts,
        () => new Promise(() => {}),
      );
      await voiceSession.handleSetVoiceMode(true, VOICE_AGENT_ID);
      detector.emit("speech_started");
      await settle();
      detector.emit("speech_stopped");
      await settle();
      sttSession.emitCommitted({ segmentId: "s1", previousSegmentId: null });
      sttSession.emitTranscript({
        segmentId: "s1",
        transcript: "hello",
        isFinal: true,
        language: "en",
        avgLogprob: -0.1,
        isLowConfidence: false,
      });
      await vi.advanceTimersByTimeAsync(0);
      const done = voiceSession.cleanup();
      await vi.advanceTimersByTimeAsync(5000);
      await done;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("VoiceSession conversation: reviewer inputs", () => {
  const finalTranscript = async (
    parts: ReturnType<typeof createVoiceSession>,
    transcript: string,
  ) => {
    const { voiceSession, detector, sttSession } = parts;
    await voiceSession.handleSetVoiceMode(true, VOICE_AGENT_ID);
    detector.emit("speech_started");
    await settle();
    detector.emit("speech_stopped");
    await settle();
    sttSession.emitCommitted({ segmentId: "s1", previousSegmentId: null });
    sttSession.emitTranscript({
      segmentId: "s1",
      transcript,
      isFinal: true,
      language: "en",
      avgLogprob: -0.1,
      isLowConfidence: false,
    });
  };

  test("a conversation that resolves after cleanup never receives the transcript", async () => {
    let resolveFactory!: (c: VoiceConversation) => void;
    const heard: string[] = [];
    const close = vi.fn(async () => {});
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const parts = createVoiceSession(
        null,
        () => new Promise<VoiceConversation>((r) => (resolveFactory = r)),
      );
      await finalTranscript(parts, "yes");
      await vi.advanceTimersByTimeAsync(0);
      const done = parts.voiceSession.cleanup();
      await vi.advanceTimersByTimeAsync(5000);
      await done;
      resolveFactory({
        handleTranscript: async (text) => void heard.push(text),
        bargeIn: async () => {},
        close,
      });
      await vi.advanceTimersByTimeAsync(0);
      await settle();
      expect(heard).toEqual([]);
      expect(close).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test("conversation error messages are redacted before they reach the log", async () => {
    const lines: string[] = [];
    const logger = pino({ level: "warn" }, {
      write: (line: string) => void lines.push(line),
    } as unknown as NodeJS.WritableStream);
    const parts = createVoiceSession(
      null,
      async (onEvent) => ({
        handleTranscript: async () => {
          onEvent({ type: "error", message: "boom API_KEY=hunter2secret" });
        },
        bargeIn: async () => {},
        close: async () => {},
      }),
      logger,
    );
    await finalTranscript(parts, "hello");
    await vi.waitFor(() => expect(lines.join("")).toContain("Voice conversation error"));
    expect(lines.join("")).not.toContain("hunter2secret");
    await parts.voiceSession.cleanup();
  });

  test("a transcript queued behind a pending factory is dropped when the user speaks again", async () => {
    let resolveFactory!: (c: VoiceConversation) => void;
    const heard: string[] = [];
    const bargeIn = vi.fn(async () => {});
    const parts = createVoiceSession(
      null,
      () => new Promise<VoiceConversation>((r) => (resolveFactory = r)),
    );
    await finalTranscript(parts, "first");
    await settle();
    parts.detector.emit("speech_started");
    await settle();
    resolveFactory({
      handleTranscript: async (text) => void heard.push(text),
      bargeIn,
      close: async () => {},
    });
    await vi.waitFor(() => expect(bargeIn).toHaveBeenCalled());
    await settle();
    expect(heard).toEqual([]);
    await parts.voiceSession.cleanup();
  });

  test("a thrown turn error is redacted in the log", async () => {
    const lines: string[] = [];
    const logger = pino({ level: "error" }, {
      write: (line: string) => void lines.push(line),
    } as unknown as NodeJS.WritableStream);
    const parts = createVoiceSession(
      null,
      async () => ({
        handleTranscript: async () => {
          throw new Error("API_KEY=hunter2secret");
        },
        bargeIn: async () => {},
        close: async () => {},
      }),
      logger,
    );
    await finalTranscript(parts, "hello");
    await vi.waitFor(() => expect(lines.join("")).toContain("Voice conversation turn failed"));
    expect(lines.join("")).not.toContain("hunter2secret");
    await parts.voiceSession.cleanup();
  });
});
