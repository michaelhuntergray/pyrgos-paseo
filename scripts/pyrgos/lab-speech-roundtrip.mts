/**
 * Headless check of the lab speech providers and the voice -> ledger flow behind them.
 *
 *   PASEO_LAB_TTS_URL=<ws url> PASEO_LAB_STT_URL=<ws url> \
 *     npx tsx scripts/pyrgos/lab-speech-roundtrip.mts ["sentence"]
 *
 * Step 1 (transcription): speak one sentence through lab TTS, resample the 24 kHz audio to 16 kHz,
 * transcribe it back through lab STT, and compare.
 * Step 2 (demo flow): speak an action request and a "yes" the same way, feed the transcripts to the
 * real ledger tools (propose -> refine -> refused early agree -> agree), then run the real dispatch
 * launcher against a stub spawn (nothing is started), and speak an overseer reply through ReplyPump.
 * Everything step 2 writes goes to a temp folder.
 *
 * Exit 0 when every check passes (case and punctuation ignored for the text matches).
 */
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { createLedgerTools } from "../../packages/server/src/server/pyrgos/conversation-agent/ledger-tools.js";
import {
  createAnnouncer,
  createVoiceSession,
  ReplyPump,
  ReplyWatcher,
  TurnGate,
} from "../../packages/server/src/server/pyrgos/ledger/feed.js";
import {
  createJsonlLedgerStore,
  ledgerFilePath,
} from "../../packages/server/src/server/pyrgos/ledger/jsonl-store.js";
import { createLedger } from "../../packages/server/src/server/pyrgos/ledger/ledger.js";
import { createDispatchLauncher } from "../../packages/server/src/server/pyrgos/launcher.js";
import { resolveLabSpeechConfig } from "../../packages/server/src/server/speech/providers/lab/config.js";
import { applyLabSpeechServices } from "../../packages/server/src/server/speech/providers/lab/runtime.js";
import { resamplePcm16 } from "../../packages/server/src/server/speech/providers/lab/stt.js";

const sentence = process.argv[2] ?? "The quick brown fox jumps over the lazy dog.";
const config = resolveLabSpeechConfig();
if (!(config.ttsUrl || config.pcTtsUrl) || !(config.sttUrl || config.pcSttUrl)) {
  console.error("Set PASEO_LAB_TTS_URL / PASEO_LAB_STT_URL (or the PASEO_PC_* twins).");
  process.exit(2);
}
const logger = pino({ level: "silent" });

// Same chain the daemon builds: lab -> PC local (no stock provider in this script).
const enabled = { provider: "local", explicit: false, enabled: true } as const;
const services = applyLabSpeechServices({
  providers: {
    dictationStt: enabled,
    voiceTurnDetection: enabled,
    voiceStt: enabled,
    voiceTts: enabled,
  },
  existing: {
    turnDetectionService: null,
    sttService: null,
    ttsService: null,
    dictationSttService: null,
  },
  logger,
  config,
});
const tts = services.ttsService!;
const stt = services.sttService!;
console.log(
  `chain: tts lab=${Boolean(config.ttsUrl)} pc=${Boolean(
    config.pcTtsUrl,
  )}, stt lab=${Boolean(config.sttUrl)} pc=${Boolean(config.pcSttUrl)}`,
);

const normalize = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .trim();

/** Speaks `text` through TTS and returns the PCM and how long the first audio took. */
async function speak(
  text: string,
): Promise<{ audio: Buffer; format: string; firstAudioMs: number }> {
  const started = Date.now();
  const { stream, format } = await tts.synthesizeSpeech(text);
  const chunks: Buffer[] = [];
  let firstAudioMs: number | null = null;
  for await (const chunk of stream) {
    firstAudioMs ??= Date.now() - started;
    chunks.push(Buffer.from(chunk));
  }
  return {
    audio: Buffer.concat(chunks),
    format,
    firstAudioMs: firstAudioMs ?? -1,
  };
}

/** Speaks `text`, then transcribes the audio back through STT; resolves to what was heard. */
async function sayAndHear(text: string): Promise<string> {
  const { audio, format, firstAudioMs } = await speak(text);
  const sourceRate = Number(/rate=(\d+)/.exec(format)?.[1] ?? 24000);
  console.log(`tts: ${audio.length} bytes (${format}), first audio ${firstAudioMs} ms`);
  const session = stt.createSession({ logger, language: "en" });
  const transcript = new Promise<string>((resolve, reject) => {
    session.on("transcript", (event) => {
      if (event.isFinal) resolve(event.transcript);
    });
    session.on("error", reject);
    setTimeout(() => reject(new Error("timed out waiting for a final transcript")), 15000);
  });
  await session.connect();
  const pcm16k = resamplePcm16(audio, sourceRate, session.requiredSampleRate);
  for (let offset = 0; offset < pcm16k.length; offset += 6400) {
    session.appendPcm16(pcm16k.subarray(offset, offset + 6400));
  }
  session.commit();
  try {
    return await transcript;
  } finally {
    session.close();
  }
}

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
  if (!ok) failures.push(name);
};

// Step 1: transcription.
const heard = await sayAndHear(sentence);
console.log(`said:  ${sentence}\nheard: ${heard}`);
check("transcription", normalize(heard) === normalize(sentence));

// Step 2: voice -> ledger -> delegation, all local to a temp folder.
const root = mkdtempSync(join(tmpdir(), "lab-roundtrip-"));
const workshop = join(root, "workshop");
mkdirSync(join(workshop, "Professional", "demo-project"), { recursive: true });
const feedDir = join(root, "feed");
const inbox = join(root, "inbox.md");
const sessionId = `roundtrip-${Date.now()}`;
const session = createVoiceSession({ dir: feedDir, session: sessionId });

// The real launcher, with a spawn that records the dispatch command instead of starting it.
const spawned: Array<{ file: string; args: string[] }> = [];
const stubSpawn = (file: string, args: string[]) => {
  spawned.push({ file, args });
  const child = new EventEmitter() as EventEmitter & { unref(): void };
  child.unref = () => {};
  setImmediate(() => child.emit("exit", 0));
  return child as unknown as ChildProcess;
};
const ledger = createLedger({
  store: createJsonlLedgerStore(ledgerFilePath({ dir: feedDir, session: sessionId })),
  announce: createAnnouncer({
    session,
    inboxPath: inbox,
    env: { VOICE_OVERSEER_SURFACE: "" },
  }),
  launch: createDispatchLauncher({
    env: {
      PYRGOS_DISPATCH_CMD: "dispatch-stub",
      ALCHEMIST_WORKSHOP: workshop,
      PYRGOS_DISPATCH_EXTRA_ARGS: "--dry-run",
    },
    spawnFn: stubSpawn,
    logDir: join(root, "logs"),
  }),
});

let turn = 0;
let latestUserText = "";
const tools = createLedgerTools({
  ledger,
  latestUserText: () => latestUserText,
  turn: () => turn,
  transcriptRef: () => `${session.path}#${turn}`,
});
const tool = (name: string) => tools.find((t) => t.name === name)!;
const userSays = async (text: string): Promise<string> => {
  turn += 1;
  latestUserText = await sayAndHear(text);
  await session.append("user", latestUserText);
  console.log(`user (turn ${turn}): ${latestUserText}`);
  return latestUserText;
};

const spokenRequest = "Add a README line saying the demo ran.";
const request = await userSays(spokenRequest);
// A mis-heard request must fail here, not flow through the ledger and get launched.
check("request heard as spoken", normalize(request) === normalize(spokenRequest), request);
await tool("propose_action").run({ item: request });
const draft = ledger.list()[0]!;
check(
  "utterance yields an action item",
  ledger.list().length === 1 && draft.state === "draft" && draft.item === request,
);
await tool("refine_action").run({
  id: draft.id,
  scope: "README.md only",
  project: "demo-project",
  doneCriteria: "one line added",
});
check("item refined", ledger.get(draft.id).state === "refined");

// Same turn as the last change: the user has not heard it read back, so agreeing is refused.
const early = await tool("agree_action").run({ id: draft.id });
check(
  "agree refused before read-back",
  early.startsWith("Not done") && spawned.length === 0,
  early,
);

const yes = await userSays("Yes.");
const agreedText = await tool("agree_action").run({ id: draft.id });
const agreed = ledger.get(draft.id);
check("spoken yes", normalize(yes) === "yes", yes);
check("item agreed", agreed.state === "agreed" && !agreed.launchError, agreedText);
const dispatchArgs = spawned[0]?.args ?? [];
check(
  "delegation launched through the dispatcher",
  spawned.length === 1 && dispatchArgs.includes("worker") && dispatchArgs.includes("--dry-run"),
  dispatchArgs.slice(0, 2).join(" "),
);
check("overseer announced", readFileSync(inbox, "utf8").includes("[voice] ACTION"));

// An overseer reply written to the replies file is spoken through ReplyPump.
await appendFile(session.repliesPath, `${JSON.stringify({ text: "Started the README task." })}\n`);
const pump = new ReplyPump({
  watcher: new ReplyWatcher(session.repliesPath),
  gate: new TurnGate(),
  session,
  speak: async (line) => (await speak(line)).audio.length > 0,
});
const spoken = await pump.pump();
check("overseer reply spoken", spoken.length === 1 && spoken[0] === "Started the README task.");

console.log(failures.length === 0 ? "PASS" : `FAIL (${failures.join(", ")})`);
process.exit(failures.length === 0 ? 0 : 1);
