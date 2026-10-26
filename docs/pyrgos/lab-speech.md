# Lab speech providers

Voice STT and TTS can run on a local GPU box ("the lab") over WebSocket. When the lab is unreachable, Paseo's stock provider takes over for that turn.

Code: `packages/server/src/server/speech/providers/lab/` (`tts.ts`, `stt.ts`, `config.ts`, `runtime.ts`). The only core change is one call to `applyLabSpeechServices` in `speech-runtime.ts`, after the OpenAI/local services are built. Those services become the fallbacks.

## Environment

| Variable                        | Meaning                                                                                                        | Default                                   |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `PASEO_LAB_TTS_URL`             | `ws(s)://` URL of the lab TTS server. Unset turns lab TTS off.                                                 | unset                                     |
| `PASEO_LAB_STT_URL`             | `ws(s)://` URL of the lab STT server. Unset turns lab STT off.                                                 | unset                                     |
| `PASEO_LAB_TTS_VOICE`           | Voice or saved profile id sent with each `speak`.                                                              | `profile:winner-r6-s49-heart-alice-bella` |
| `PASEO_LAB_CONNECT_TIMEOUT_MS`  | Connect timeout before falling back.                                                                           | `1500`                                    |
| `PASEO_LAB_TTS_IDLE_TIMEOUT_MS` | TTS first-audio and between-frame timeout; before audio it falls back to stock, after audio the stream errors. | `3000`                                    |
| `PASEO_LAB_TTS_SPEED`           | Speech-rate multiplier (finite, > 0) sent with each `speak`. Invalid values are ignored.                       | unset (server default)                    |
| `PASEO_LAB_TTS_PITCH`           | Pitch shift (any finite number) sent with each `speak`.                                                        | unset (server default)                    |
| `PASEO_LAB_TTS_EMOTION`         | Emotion label sent with each `speak`.                                                                          | unset (server default)                    |
| `PASEO_PC_TTS_URL`              | `ws(s)://` URL of a TTS server on the PC (same protocol as the lab). Second tier, used when the lab fails.     | unset                                     |
| `PASEO_PC_STT_URL`              | `ws(s)://` URL of an STT server on the PC (same protocol as the lab). Second tier, used when the lab fails.    | unset                                     |

Values are never committed. Set them in the daemon's environment.

## TTS speed, pitch and emotion

Config sets the defaults; a per-request override wins: `lab.synthesizeSpeech(text, { speed, pitch, emotion })`. Only fields that are set go on the wire: `{"type":"speak","text","voice","speed"?,"pitch"?,"emotion"?}`. `TextToSpeechProvider.synthesizeSpeech` takes an optional second `SpeechSynthesisOptions` argument, so overrides work through the service the runtime returns; stock providers ignore it. Validation is the same for config and overrides: `speed` finite, > 0 and <= 4; `pitch` finite; `emotion` non-blank. Invalid per-request values are dropped (the default applies), never sent. Overrides are forwarded down the failover chain, so the PC tier honours them too.

Backend support today (lab `tts_server.py`, Kokoro):

| Option    | Lab backend                                                                                                                                                    |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `speed`   | **Supported** (voice-agent MIC-757). The server passes a finite `0 < speed <= 4` to Kokoro and uses 1.0 for anything else; 1.5 gave a clip about 1.5x shorter. |
| `pitch`   | **Unsupported.** Kokoro has no pitch control. The field is sent and ignored; nothing is faked client-side.                                                     |
| `emotion` | **Unsupported.** Kokoro has no emotion control. Sent and ignored, as above.                                                                                    |

## Word timestamps

`StreamingTranscriptionEvent` has an optional `words: { word, start, end, probability? }[]` (seconds from utterance start). The lab STT session fills it when a `partial` or `final` message carries a `words` array; malformed entries are dropped and the field is omitted when none are valid. Stock providers never set it.

Backend support today: **the lab STT server emits words on `final` messages** (voice-agent MIC-757: faster-whisper `word_timestamps=True`, about +14 ms on a 3 to 4 s utterance; `STT_WORDS=0` on the server turns it off). Partials carry no words. **TTS alignment is unsupported**: the TTS server returns only PCM and `done`, so no alignment type exists in the provider results.

## Wire protocol

- TTS: client sends `{"type":"speak","text","voice"}`; server streams binary 24 kHz mono int16 PCM, then `{"type":"done","first_audio_ms"}`. `{"type":"cancel"}` stops a running speak; the provider sends it when the consumer closes the stream early. The stream format reported to Paseo is `pcm;rate=24000`.
- STT: client sends binary 16 kHz mono int16 PCM, then `{"type":"end"}` at commit; server sends `partial` messages and one `final`. The session reports `requiredSampleRate = 16000`.

## Fallback rules

- TTS falls back when the connection fails, times out, errors, or closes before the first audio frame. A failure after audio has started destroys the stream (no mid-sentence switch).
- STT falls back when `connect()` cannot reach the lab. Audio is resampled from 16 kHz to the fallback's required rate. A lab that drops mid-utterance is replayed to the fallback; with no fallback it surfaces as a session `error`.
- STT keeps one ordered outbox of audio and commit frames until a final answers them, and replays it oldest first to whichever sink becomes ready (the fallback after a lab loss), each commit under the segment id already announced for it. The outbox is capped at 60 s of 16 kHz audio (`replayMaxBytes` on `LabSttOptions`): past it the oldest audio is dropped with a logged warning. Unanswered commits are capped by `maxPendingCommits`: a connected lab over the cap is treated as hung and dropped; otherwise the oldest announced commit gets an empty final. **Remaining limit:** an utterance whose audio was dropped replays as an empty commit, so it gets an empty fallback transcript.
- Without a fallback (no stock provider configured), the lab error is thrown.

## PC local fallback (PC-CHECK: untested on Windows)

Order: **lab -> PC local -> stock**. When `PASEO_PC_TTS_URL` / `PASEO_PC_STT_URL` are set, `applyLabSpeechServices` builds a second `LabTTS` / `LabSTT` pointed at the PC and makes it the lab's fallback; the stock provider is the PC tier's fallback. It reuses the same failover and utterance-replay path, so a lab that dies mid-utterance replays the audio to the PC server. The PC tier works without a lab URL too. Nothing changes when the PC variables are unset.

The PC server is the same lab TTS/STT code from the voice-agent project running locally on Windows (loopback ports 8786 and 8785 by default).

**PC-CHECK, not run on Windows.** With the PC servers up, point the lab URLs at a closed port so the lab tier fails, then run one command in PowerShell from the repo root. It must print `PASS`, with the PC tier serving:

```
$env:PASEO_LAB_TTS_URL='ws://127.0.0.1:9'; $env:PASEO_LAB_STT_URL='ws://127.0.0.1:9'; $env:PASEO_PC_TTS_URL='ws://127.0.0.1:8786'; $env:PASEO_PC_STT_URL='ws://127.0.0.1:8785'; npx tsx scripts/pyrgos/lab-speech-roundtrip.mts
```

The unit tests prove the ordering on Linux with fake servers; they do not prove the Windows servers start or answer.

## Check it

Unit tests use a fake lab server on a loopback ephemeral port:

```
cd packages/server && npx vitest run src/server/speech/providers/lab
```

Headless round trip against a real lab, exits 0 only when every check passes:

```
PASEO_LAB_TTS_URL=... PASEO_LAB_STT_URL=... npx tsx scripts/pyrgos/lab-speech-roundtrip.mts
```

1. Transcription: speaks one sentence, transcribes it back, compares.
2. Demo flow (voice -> ledger -> delegation): speaks an action request and then "Yes." through the same TTS -> STT path and feeds the transcripts to the real ledger tools. It checks that the request becomes a draft item, that `agree_action` is refused before the read-back turn, that the spoken yes agrees it, that the real dispatch launcher builds the `worker` command (spawn is stubbed, so no agent starts), that the announce line is written, and that an overseer reply in the replies file is spoken by `ReplyPump`. All files go to a temp folder; nothing touches the real ledger or inbox.

(`.mts` is exempt from the `.sh`/`.ps1` twin rule, like `.mjs`.)
