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
  /** Commits the lab may leave unanswered before it is treated as hung and dropped; default 64. */
  maxPendingCommits?: number;
}

/** 60 s of 16 kHz mono int16 PCM. */
const DEFAULT_REPLAY_MAX_BYTES = LAB_STT_SAMPLE_RATE * 2 * 60;
const DEFAULT_MAX_PENDING_COMMITS = 64;

/** One entry of the ordered outbox: caller audio, or a commit already announced under `segmentId`. */
type Frame = { kind: "audio"; chunk: Buffer } | { kind: "commit"; segmentId: string };

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
    let closed = false;
    let pending: WebSocket | null = null;
    // Latest lab open attempt; connect() follows it when clear() aborts the one it started with.
    let latest: Promise<void> | null = null;
    let connecting = false;
    let failingOver = false;

    // One ordered outbox of everything the caller sent that no final has answered yet: audio and
    // commit frames in call order. `cursor` is the next frame to send to the current sink; frames
    // leave only when a final answers them (the lab answers in order), so what remains is exactly
    // the unanswered commits plus the current uncommitted audio. A new sink replays from cursor 0.
    // Limit: audio evicted by the byte cap replays as an empty commit (its id still gets a final).
    const replayMaxBytes = options.replayMaxBytes ?? DEFAULT_REPLAY_MAX_BYTES;
    const maxPendingCommits = options.maxPendingCommits ?? DEFAULT_MAX_PENDING_COMMITS;
    const outbox: Frame[] = [];
    let cursor = 0;
    let outboxBytes = 0;
    let commitFrames = 0;
    let draining = false;
    // Announced ids of commits sent to the fallback whose "committed" it has not reported yet (FIFO).
    const fallbackIds: string[] = [];

    const removeAt = (index: number) => {
      const [frame] = outbox.splice(index, 1);
      if (frame!.kind === "audio") {
        outboxBytes -= frame!.chunk.length;
      } else {
        commitFrames -= 1;
        const at = fallbackIds.indexOf(frame!.segmentId);
        if (at >= 0) fallbackIds.splice(at, 1);
      }
      if (index < cursor) cursor -= 1;
    };
    // Removes the oldest commit and the audio before it; false if no commit is queued.
    const popOldestCommit = (): boolean => {
      const index = outbox.findIndex((f) => f.kind === "commit");
      if (index < 0) return false;
      for (let i = 0; i <= index; i++) removeAt(0);
      return true;
    };
    const oldestCommitId = (): string | null => {
      const frame = outbox.find((f) => f.kind === "commit");
      return frame && frame.kind === "commit" ? frame.segmentId : null;
    };
    // Evict the oldest audio (whole PCM16 samples, copying the tail) over the byte cap; commits stay.
    const enforceCap = () => {
      while (outboxBytes > replayMaxBytes) {
        const index = outbox.findIndex((f) => f.kind === "audio");
        if (index < 0) return;
        const frame = outbox[index] as { kind: "audio"; chunk: Buffer };
        const excess = outboxBytes - replayMaxBytes;
        const cut = Math.min(frame.chunk.length, excess + (excess % 2));
        if (cut === frame.chunk.length) {
          removeAt(index);
        } else {
          frame.chunk = Buffer.from(frame.chunk.subarray(cut));
          outboxBytes -= cut;
        }
        logger.warn({ bytes: cut }, "Lab STT outbox full; dropping the oldest audio");
      }
    };
    const resetOutbox = () => {
      outbox.length = 0;
      cursor = 0;
      outboxBytes = 0;
      commitFrames = 0;
      fallbackIds.length = 0;
    };
    // Send outbox[cursor..] while a sink is ready. A re-entrant call (a listener committing while
    // we send) returns at once; its frame sits at the tail and is picked up by the running loop.
    const drain = () => {
      if (draining) return;
      draining = true;
      try {
        for (;;) {
          if (closed || cursor >= outbox.length) break;
          const socket = ws && ws.readyState === WebSocket.OPEN ? ws : null;
          if (!delegate && !socket) break;
          const frame = outbox[cursor]!;
          cursor += 1;
          if (delegate) {
            if (frame.kind === "audio") {
              delegate.appendPcm16(
                resamplePcm16(frame.chunk, LAB_STT_SAMPLE_RATE, delegate.requiredSampleRate),
              );
            } else {
              fallbackIds.push(frame.segmentId);
              delegate.commit();
            }
          } else if (frame.kind === "audio") {
            socket!.send(frame.chunk);
          } else {
            socket!.send(JSON.stringify({ type: "end" }));
          }
        }
      } finally {
        draining = false;
      }
    };
    // A final answers the oldest commit; with none queued it ends the current utterance.
    const answered = () => {
      if (popOldestCommit()) return;
      for (let i = outbox.length - 1; i >= 0; i--) if (outbox[i]!.kind === "audio") removeAt(i);
      previousSegmentId = segmentId;
      segmentId = randomUUID();
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
          // New sink: replay everything unanswered.
          cursor = 0;
          drain();
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
            emitter.emit("transcript", {
              segmentId: oldestCommitId() ?? segmentId,
              transcript: message.text ?? "",
              isFinal,
              language: params.language,
              ...(words ? { words } : {}),
            });
            if (isFinal) answered();
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
    // and replay the outbox; with no fallback, surface the error.
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
      // Every commit was already announced under its lab segment id (commit() emits "committed"
      // itself); the fallback's own "committed" only tells us which fallback id answers which
      // announced id, FIFO in the order the commits were sent. Its previousSegmentId is ignored.
      const idMap = new Map<string, string>();
      session.on("committed", (p) => {
        const announced = fallbackIds.shift();
        if (announced !== undefined) idMap.set(p.segmentId, announced);
      });
      session.on("transcript", (p) => {
        const mapped = idMap.get(p.segmentId) ?? p.segmentId;
        emitter.emit("transcript", { ...p, segmentId: mapped });
        if (p.isFinal) {
          idMap.delete(p.segmentId);
          answered();
        }
      });
      session.on("error", (e) => emitter.emit("error", e));
      await session.connect();
      if (closed) {
        session.close();
        return;
      }
      delegate = session;
      // New sink: replay everything unanswered, oldest first.
      cursor = 0;
      drain();
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
        if (closed) return;
        outbox.push({ kind: "audio", chunk });
        outboxBytes += chunk.length;
        enforceCap();
        drain();
      },
      commit() {
        if (closed) return;
        const id = segmentId;
        outbox.push({ kind: "commit", segmentId: id });
        commitFrames += 1;
        // Next utterance starts now; the committed one keeps its id until its final arrives.
        const announcedPrevious = previousSegmentId;
        previousSegmentId = id;
        segmentId = randomUUID();
        emitter.emit("committed", { segmentId: id, previousSegmentId: announcedPrevious });
        if (commitFrames > maxPendingCommits) {
          if (ws && ws.readyState === WebSocket.OPEN) {
            // The lab is up but not answering: drop it and replay from the oldest unanswered frame.
            logger.warn(
              { pending: commitFrames },
              "Lab STT stopped answering commits; dropping it",
            );
            const old = ws;
            ws = null;
            old.terminate();
            abortPending();
            failover(new Error("lab STT stopped answering"));
          } else {
            // No sink is answering (connecting or none): the oldest announced id gets an empty final
            // and its frames go, so no announced id stays silent and the outbox stays bounded.
            const oldest = oldestCommitId();
            logger.warn(
              { segmentId: oldest },
              "Lab STT has too many unanswered commits; finalizing the oldest empty",
            );
            if (oldest !== null) {
              popOldestCommit();
              emitter.emit("transcript", {
                segmentId: oldest,
                transcript: "",
                isFinal: true,
                language: params.language,
              });
            }
          }
        }
        drain();
      },
      clear() {
        resetOutbox();
        segmentId = randomUUID();
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
        const reopen = (latest = openLab());
        reopen.catch((error) => {
          if (!closed && !connecting && error !== aborted) failover(error);
        });
      },
      close() {
        closed = true;
        resetOutbox();
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
