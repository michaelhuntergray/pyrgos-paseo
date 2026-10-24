import type { Logger } from "pino";
import type { SpeechToTextProvider, TextToSpeechProvider } from "../../speech-provider.js";
import type { RequestedSpeechProviders } from "../../speech-types.js";
import type { SpeechServices } from "../openai/runtime.js";
import { resolveLabSpeechConfig, type LabSpeechConfig } from "./config.js";
import { LabSTT } from "./stt.js";
import { LabTTS } from "./tts.js";

/**
 * Layers the lab providers over the services already initialised for voice. The previous
 * service (stock local or OpenAI) becomes the fallback, so a dead lab never silences the agent.
 * Does nothing unless PASEO_LAB_TTS_URL / PASEO_LAB_STT_URL are set.
 */
export function applyLabSpeechServices(params: {
  providers: RequestedSpeechProviders;
  existing: SpeechServices;
  logger: Logger;
  config?: LabSpeechConfig;
}): SpeechServices {
  const { providers, existing, logger } = params;
  const config = params.config ?? resolveLabSpeechConfig();
  let ttsService: TextToSpeechProvider | null = existing.ttsService;
  let sttService: SpeechToTextProvider | null = existing.sttService;

  const ttsBase = {
    voice: config.ttsVoice,
    speed: config.ttsSpeed,
    pitch: config.ttsPitch,
    emotion: config.ttsEmotion,
    connectTimeoutMs: config.connectTimeoutMs,
    idleTimeoutMs: config.idleTimeoutMs,
  };

  // Order: lab -> PC local -> stock. The PC tier speaks the lab wire protocol and is optional.
  if ((config.ttsUrl || config.pcTtsUrl) && providers.voiceTts.enabled !== false) {
    let chain: TextToSpeechProvider | null = existing.ttsService;
    if (config.pcTtsUrl) {
      chain = new LabTTS({ ...ttsBase, url: config.pcTtsUrl, fallback: chain }, logger);
    }
    if (config.ttsUrl) {
      chain = new LabTTS({ ...ttsBase, url: config.ttsUrl, fallback: chain }, logger);
    }
    ttsService = chain;
    logger.info(
      { lab: Boolean(config.ttsUrl), pc: Boolean(config.pcTtsUrl) },
      "Lab TTS enabled (stock provider is the last fallback)",
    );
  }
  if ((config.sttUrl || config.pcSttUrl) && providers.voiceStt.enabled !== false) {
    let chain: SpeechToTextProvider | null = existing.sttService;
    if (config.pcSttUrl) {
      chain = new LabSTT(
        {
          url: config.pcSttUrl,
          connectTimeoutMs: config.connectTimeoutMs,
          fallback: chain,
        },
        logger,
      );
    }
    if (config.sttUrl) {
      chain = new LabSTT(
        {
          url: config.sttUrl,
          connectTimeoutMs: config.connectTimeoutMs,
          fallback: chain,
        },
        logger,
      );
    }
    sttService = chain;
    logger.info(
      { lab: Boolean(config.sttUrl), pc: Boolean(config.pcSttUrl) },
      "Lab STT enabled (stock provider is the last fallback)",
    );
  }
  return { ...existing, ttsService, sttService };
}
