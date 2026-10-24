/**
 * Headless check of the lab speech providers: speak one sentence through lab TTS, resample the
 * 24 kHz audio to 16 kHz, transcribe it back through lab STT, and print both texts.
 *
 *   PASEO_LAB_TTS_URL=<ws url> PASEO_LAB_STT_URL=<ws url> \
 *     npx tsx scripts/pyrgos/lab-speech-roundtrip.mts ["sentence"]
 *
 * Exit 0 when the transcript matches the sentence (case and punctuation ignored).
 */
import pino from "pino";
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
  `chain: tts lab=${Boolean(config.ttsUrl)} pc=${Boolean(config.pcTtsUrl)}, stt lab=${Boolean(config.sttUrl)} pc=${Boolean(config.pcSttUrl)}`,
);
const started = Date.now();
const { stream, format } = await tts.synthesizeSpeech(sentence);
const chunks: Buffer[] = [];
let firstAudioMs: number | null = null;
for await (const chunk of stream) {
  firstAudioMs ??= Date.now() - started;
  chunks.push(Buffer.from(chunk));
}
const audio = Buffer.concat(chunks);
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
const heard = await transcript;
session.close();

const normalize = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .trim();
const ok = normalize(heard) === normalize(sentence);
console.log(`said:  ${sentence}\nheard: ${heard}\n${ok ? "PASS" : "FAIL"}`);
process.exit(ok ? 0 : 1);
