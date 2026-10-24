import { PassThrough } from "node:stream";
import type pino from "pino";
import { WebSocket } from "ws";
import type { SpeechStreamResult, TextToSpeechProvider } from "../../speech-provider.js";
import { LAB_IDLE_TIMEOUT_MS, LAB_TTS_SAMPLE_RATE } from "./config.js";

/** Per-request TTS controls. Omitted fields fall back to the configured defaults. */
export interface LabSynthesisOptions {
  speed?: number;
  pitch?: number;
  emotion?: string;
}

export interface LabTtsOptions {
  url: string;
  voice: string;
  /** Default controls sent with each speak; per-request values override them. */
  speed?: number;
  pitch?: number;
  emotion?: string;
  connectTimeoutMs: number;
  /** Max silence between frames (and before the first one); default LAB_IDLE_TIMEOUT_MS. */
  idleTimeoutMs?: number;
  /** Used when the lab is unreachable or fails before the first audio frame. */
  fallback: TextToSpeechProvider | null;
}

/**
 * Lab Kokoro TTS over WebSocket. Sends {"type":"speak"}, streams the 24 kHz int16 PCM frames
 * as they arrive, and ends on {"type":"done"}. Falls back to the stock provider when the lab
 * cannot deliver a first frame.
 */
export class LabTTS implements TextToSpeechProvider {
  private readonly logger: pino.Logger;

  constructor(
    private readonly options: LabTtsOptions,
    parentLogger: pino.Logger,
  ) {
    this.logger = parentLogger.child({
      module: "speech",
      provider: "lab",
      component: "tts",
    });
  }

  async synthesizeSpeech(
    text: string,
    overrides?: LabSynthesisOptions,
  ): Promise<SpeechStreamResult> {
    if (!text || text.trim().length === 0) {
      throw new Error("Cannot synthesize empty text");
    }
    try {
      return await this.synthesizeFromLab(text, overrides);
    } catch (error) {
      if (!this.options.fallback) {
        throw new Error(
          `Lab TTS failed: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      this.logger.warn({ err: error }, "Lab TTS unavailable; using fallback provider");
      // Stock providers take only text and ignore the extra argument; a PC LabTTS honours it.
      const next = this.options.fallback as TextToSpeechProvider & {
        synthesizeSpeech(text: string, options?: LabSynthesisOptions): Promise<SpeechStreamResult>;
      };
      return next.synthesizeSpeech(text, overrides);
    }
  }

  private synthesizeFromLab(
    text: string,
    overrides?: LabSynthesisOptions,
  ): Promise<SpeechStreamResult> {
    return new Promise((resolve, reject) => {
      const stream = new PassThrough();
      const ws = new WebSocket(this.options.url, {
        handshakeTimeout: this.options.connectTimeoutMs,
      });
      let delivered = false;
      let idleTimer: NodeJS.Timeout | null = null;
      const idleMs = this.options.idleTimeoutMs ?? LAB_IDLE_TIMEOUT_MS;

      const clearIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = null;
      };
      const fail = (error: Error) => {
        clearIdle();
        if (delivered) {
          stream.destroy(error);
        } else {
          reject(error);
        }
        ws.terminate();
      };
      // Before the first frame a stall rejects (stock fallback runs); after it, the stream errors.
      const armIdle = () => {
        clearIdle();
        idleTimer = setTimeout(() => {
          fail(
            new Error(delivered ? "lab TTS stalled mid-stream" : "lab TTS first audio timed out"),
          );
        }, idleMs);
      };

      ws.on("open", () => {
        const speed = overrides?.speed ?? this.options.speed;
        const pitch = overrides?.pitch ?? this.options.pitch;
        const emotion = overrides?.emotion ?? this.options.emotion;
        ws.send(
          JSON.stringify({
            type: "speak",
            text,
            voice: this.options.voice,
            ...(speed !== undefined ? { speed } : {}),
            ...(pitch !== undefined ? { pitch } : {}),
            ...(emotion !== undefined ? { emotion } : {}),
          }),
        );
        armIdle();
      });
      ws.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
        if (isBinary) {
          armIdle();
          stream.write(Buffer.isBuffer(data) ? data : Buffer.concat(data as Buffer[]));
          if (!delivered) {
            delivered = true;
            resolve({ stream, format: `pcm;rate=${LAB_TTS_SAMPLE_RATE}` });
          }
          return;
        }
        let message: { type?: string; message?: string };
        try {
          message = JSON.parse(data.toString());
        } catch {
          return;
        }
        if (message.type === "error") {
          fail(new Error(message.message ?? "lab TTS error"));
        } else if (message.type === "done") {
          if (!delivered) {
            fail(new Error("lab TTS returned no audio"));
            return;
          }
          clearIdle();
          stream.end();
          ws.close();
        }
      });
      ws.on("error", (error) => fail(error));
      ws.on("close", () => {
        clearIdle();
        if (!delivered) {
          reject(new Error("lab TTS closed before audio"));
        } else if (!stream.writableEnded) {
          stream.destroy(new Error("lab TTS closed mid-stream"));
        }
      });
      stream.on("close", () => {
        clearIdle();
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "cancel" }));
          ws.close();
        }
      });
    });
  }
}
