import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type pino from "pino";
import { WebSocket } from "ws";
import type {
  SpeechToTextProvider,
  StreamingTranscriptionSession,
  WordTimestamp,
} from "../../speech-provider.js";
import { LAB_STT_SAMPLE_RATE } from "./config.js";

export interface LabSttOptions {
  url: string;
  connectTimeoutMs: number;
  /** Used when the lab cannot be reached at connect(). */
  fallback: SpeechToTextProvider | null;
  /** Cap on audio kept for fallback replay (committed-but-unfinalized plus current); default 60 s. */
  replayMaxBytes?: number;
}

/** 60 s of 16 kHz mono int16 PCM. */
const DEFAULT_REPLAY_MAX_BYTES = LAB_STT_SAMPLE_RATE * 2 * 60;

/** An utterance committed to the lab whose final transcript has not arrived yet. */
interface CommittedUtterance {
  segmentId: string;
  chunks: Buffer[];
  bytes: number;
  /** Audio evicted by the replay cap; the lab may still answer it, the fallback cannot. */
  dropped: boolean;
}

/** Keeps only well-formed {word,start,end} entries (0 <= start <= end; probability kept only in [0,1]); undefined when none survive. */
export function parseWords(raw: unknown): WordTimestamp[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const words: WordTimestamp[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const { word, start, end, probability } = item as Record<string, unknown>;
    if (typeof word !== "string" || typeof start !== "number" || typeof end !== "number") continue;
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    if (start < 0 || end < start) continue;
    words.push({
      word,
      start,
      end,
      ...(typeof probability === "number" && probability >= 0 && probability <= 1
        ? { probability }
        : {}),
    });
  }
  return words.length > 0 ? words : undefined;
}

/** Linear-interpolation resample of PCM16LE mono; only used on the fallback path. */
export function resamplePcm16(pcm: Buffer, fromRate: number, toRate: number): Buffer {
  if (fromRate === toRate || pcm.length < 2) return pcm;
  const samples = Math.floor(pcm.length / 2);
  const input = new Int16Array(samples);
  for (let i = 0; i < samples; i++) input[i] = pcm.readInt16LE(i * 2);
  const outLength = Math.max(1, Math.round((samples * toRate) / fromRate));
  const out = Buffer.alloc(outLength * 2);
  for (let i = 0; i < outLength; i++) {
    const pos = (i * fromRate) / toRate;
    const lo = Math.min(Math.floor(pos), samples - 1);
    const hi = Math.min(lo + 1, samples - 1);
    const frac = pos - lo;
    out.writeInt16LE(Math.round(input[lo]! * (1 - frac) + input[hi]! * frac), i * 2);
  }
  return out;
}

/**
 * Lab faster-whisper STT over WebSocket: 16 kHz int16 PCM frames in, {"type":"end"} at commit,
 * partial/final transcripts out. If the lab is unreachable at connect(), the session delegates to
 * the fallback provider (audio is resampled to the rate the fallback requires).
 */
export class LabSTT implements SpeechToTextProvider {
  public readonly id = "lab" as const;

  constructor(
    private readonly options: LabSttOptions,
    _parentLogger: pino.Logger,
  ) {}

  createSession(params: {
    logger: pino.Logger;
    language?: string;
    prompt?: string;
  }): StreamingTranscriptionSession {
    const { options } = this;
    const logger = params.logger.child({
      provider: "lab",
      component: "stt-session",
    });
    const emitter = new EventEmitter();
    let ws: WebSocket | null = null;
    let delegate: StreamingTranscriptionSession | null = null;
    let segmentId = randomUUID();
    let previousSegmentId: string | null = null;
    // Frames waiting for the socket, in order; null is a commit's "end".
    const queued: Array<Buffer | null> = [];
    let closed = false;
    let pending: WebSocket | null = null;
    // Latest lab open attempt; connect() follows it when clear() aborts the one it started with.
    let latest: Promise<void> | null = null;
    let connecting = false;
    // Audio the lab has not finalized, replayed to the fallback if it dies first: every committed
    // utterance awaiting its final (oldest first; the lab answers in order) plus the current,
    // uncommitted one. Bounded by replayMaxBytes; the oldest committed audio is evicted first.
    // Limit: an evicted utterance (and any audio the fallback never saw) gets no fallback transcript.
    const replayMaxBytes = options.replayMaxBytes ?? DEFAULT_REPLAY_MAX_BYTES;
    const committedUtterances: CommittedUtterance[] = [];
    let utterance: Buffer[] = [];
    let utteranceBytes = 0;
    let bufferedBytes = 0;
    let failingOver = false;
    // Segment id the fallback's replayed commit must report under (see startFallback).
    let replayId: string | null = null;
    const enforceReplayCap = () => {
      while (bufferedBytes > replayMaxBytes) {
        const oldest = committedUtterances.find((u) => !u.dropped);
        if (oldest) {
          bufferedBytes -= oldest.bytes;
          logger.warn(
            { segmentId: oldest.segmentId, bytes: oldest.bytes },
            "Lab STT replay buffer full; dropping committed audio that cannot be replayed",
          );
          oldest.chunks = [];
          oldest.bytes = 0;
          oldest.dropped = true;
        } else if (utterance.length > 0) {
          const first = utterance.shift()!;
          utteranceBytes -= first.length;
          bufferedBytes -= first.length;
          logger.warn(
            { bytes: first.length },
            "Lab STT replay buffer full; dropping the start of the current utterance",
          );
        } else {
          return;
        }
      }
    };
    const resetReplay = () => {
      committedUtterances.length = 0;
      utterance = [];
      utteranceBytes = 0;
      bufferedBytes = 0;
    };
    const aborted = new Error("lab STT connect aborted");
    const dropped = new WeakSet<WebSocket>();
    const abortPending = () => {
      if (pending) dropped.add(pending);
      pending?.terminate();
      pending = null;
    };

    const openLab = (): Promise<void> =>
      new Promise((resolve, reject) => {
        const socket = new WebSocket(options.url, {
          handshakeTimeout: options.connectTimeoutMs,
        });
        pending = socket;
        let opened = false;
        socket.on("open", () => {
          if (pending === socket) pending = null;
          if (closed) {
            socket.terminate();
            reject(aborted);
            return;
          }
          opened = true;
          ws = socket;
          // Already recorded for replay when appended/committed; only the wire send is deferred.
          for (const frame of queued.splice(0)) {
            socket.send(frame ?? JSON.stringify({ type: "end" }));
          }
          resolve();
        });
        socket.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
          if (isBinary || ws !== socket) return;
          let message: {
            type?: string;
            text?: string;
            message?: string;
            words?: unknown;
          };
          try {
            message = JSON.parse(data.toString());
          } catch {
            return;
          }
          if (message.type === "partial" || message.type === "final") {
            const isFinal = message.type === "final";
            const words = parseWords(message.words);
            // The lab answers in commit order: the oldest committed utterance owns this message.
            const owner = committedUtterances[0];
            emitter.emit("transcript", {
              segmentId: owner?.segmentId ?? segmentId,
              transcript: message.text ?? "",
              isFinal,
              language: params.language,
              ...(words ? { words } : {}),
            });
            if (isFinal) {
              if (owner) {
                committedUtterances.shift();
                bufferedBytes -= owner.bytes;
              } else {
                // Final with no commit: the lab ended the current utterance itself.
                bufferedBytes -= utteranceBytes;
                utterance = [];
                utteranceBytes = 0;
                previousSegmentId = segmentId;
                segmentId = randomUUID();
              }
            }
          } else if (message.type === "error") {
            emitter.emit("error", new Error(message.message ?? "lab STT error"));
          }
        });
        socket.on("error", (error) => {
          if (!opened) reject(dropped.has(socket) ? aborted : error);
          else if (ws === socket && !options.fallback) emitter.emit("error", error);
        });
        socket.on("close", () => {
          if (pending === socket) pending = null;
          if (!opened) {
            reject(dropped.has(socket) ? aborted : new Error("lab STT closed before open"));
          } else if (ws === socket) {
            ws = null;
            if (!closed) failover(new Error("lab STT connection lost"));
          }
        });
      });

    // Established lab session died (or the clear() replacement failed): switch to the fallback
    // and replay the current utterance; with no fallback, surface the error.
    const runFailover = async (error: Error): Promise<void> => {
      failingOver = true;
      logger.warn({ err: error }, "Lab STT lost; switching to fallback provider");
      try {
        await startFallback();
      } catch (e) {
        if (!closed) emitter.emit("error", e instanceof Error ? e : new Error(String(e)));
      } finally {
        failingOver = false;
      }
    };
    const failover = (error: Error): void => {
      if (delegate || failingOver || closed) return;
      if (!options.fallback) {
        emitter.emit("error", error);
        return;
      }
      void runFailover(error);
    };

    const startFallback = async (): Promise<void> => {
      if (!options.fallback) throw new Error("lab STT unavailable and no fallback configured");
      const session = options.fallback.createSession(params);
      // Each replayed commit was already announced under its lab segment id; keep that id.
      const idMap = new Map<string, string>();
      session.on("committed", (p) => {
        if (replayId !== null) idMap.set(p.segmentId, replayId);
        else emitter.emit("committed", p);
      });
      session.on("transcript", (p) =>
        emitter.emit("transcript", {
          ...p,
          segmentId: idMap.get(p.segmentId) ?? p.segmentId,
        }),
      );
      session.on("error", (e) => emitter.emit("error", e));
      await session.connect();
      delegate = session;
      const send = (chunk: Buffer) =>
        session.appendPcm16(resamplePcm16(chunk, LAB_STT_SAMPLE_RATE, session.requiredSampleRate));
      // Committed utterances first, oldest first, each replayed with its commit (commit() already
      // emitted "committed" before the lab failed); then the current, uncommitted audio.
      for (const entry of committedUtterances.splice(0)) {
        if (entry.dropped) continue;
        entry.chunks.forEach(send);
        replayId = entry.segmentId;
        session.commit();
        replayId = null;
      }
      utterance.splice(0).forEach(send);
      queued.length = 0;
      resetReplay();
    };

    return {
      requiredSampleRate: LAB_STT_SAMPLE_RATE,
      async connect() {
        connecting = true;
        let attempt = (latest = openLab());
        for (;;) {
          try {
            await attempt;
            break;
          } catch (error) {
            if (closed) break;
            // clear() replaced this attempt: follow the new one, never start the fallback.
            if (error === aborted && latest && latest !== attempt) {
              attempt = latest;
              continue;
            }
            logger.warn({ err: error }, "Lab STT unavailable; using fallback provider");
            await startFallback();
            break;
          }
        }
        connecting = false;
      },
      appendPcm16(chunk: Buffer) {
        if (delegate) {
          delegate.appendPcm16(
            resamplePcm16(chunk, LAB_STT_SAMPLE_RATE, delegate.requiredSampleRate),
          );
        } else {
          utterance.push(chunk);
          utteranceBytes += chunk.length;
          bufferedBytes += chunk.length;
          enforceReplayCap();
          if (ws && ws.readyState === WebSocket.OPEN) ws.send(chunk);
          else queued.push(chunk);
        }
      },
      commit() {
        if (delegate) {
          delegate.commit();
          return;
        }
        emitter.emit("committed", { segmentId, previousSegmentId });
        committedUtterances.push({
          segmentId,
          chunks: utterance,
          bytes: utteranceBytes,
          dropped: false,
        });
        utterance = [];
        utteranceBytes = 0;
        // Next utterance starts now; the committed one keeps its id until its final arrives.
        previousSegmentId = segmentId;
        segmentId = randomUUID();
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "end" }));
        } else {
          queued.push(null);
        }
      },
      clear() {
        queued.length = 0;
        resetReplay();
        if (delegate) {
          delegate.clear();
          return;
        }
        if (closed) return;
        // The lab buffer only resets after a final, so drop the socket and reopen it.
        const old = ws;
        ws = null;
        old?.terminate();
        abortPending();
        segmentId = randomUUID();
        const reopen = (latest = openLab());
        reopen.catch((error) => {
          if (!closed && !connecting && error !== aborted) failover(error);
        });
      },
      close() {
        closed = true;
        queued.length = 0;
        resetReplay();
        delegate?.close();
        const old = ws;
        ws = null;
        old?.close();
        abortPending();
      },
      on(event: string, handler: (...args: never[]) => void) {
        emitter.on(event, handler as (...args: unknown[]) => void);
        return undefined;
      },
    };
  }
}
