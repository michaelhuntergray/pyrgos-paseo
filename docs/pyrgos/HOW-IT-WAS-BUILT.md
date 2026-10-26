# How it was built (Pyrgos Paseo)

A formal log of the Pyrgos additions to this fork, in build order. Each entry says what was decided, who decided, why, what was rejected and the consequence, and carries a status: verified (with evidence) or assumed (with what would settle it). No dates.

## Design note first (MIC-750 A)

- **Decided:** write `docs/pyrgos/DESIGN.md` before B (conversation agent), C (ledger and overseer feed) and D (lab speech) start, so the three can be built in parallel against fixed interfaces.
- **Who:** the overseer session set the plan; Claude drafted the note.
- **Chosen:** a direct "voice brain" hook on `VoiceSession` instead of binding voice mode to a Paseo agent. **Rejected:** the stock path (agent turn plus MCP `speak` call per reply), because it adds latency against the 2 s target.
- **Chosen:** a new `lab` speech provider id, which needs a small edit to the closed enum in `speech-types.ts`. **Rejected:** a plugin-only route, because plugins cannot register speech providers (`packages/plugin/src/server/contracts.ts`).
- **Consequence:** about three small core edits; everything else is under `pyrgos/` and `plugins/pyrgos-ledger/`.
- **Status:** verified for the cited seams (files and symbols read in this checkout). The latency claim for the stock path is **assumed**; B settles it by measuring.

## Lab speech providers (MIC-750 D)

- **Decided:** speak and listen through the lab's local TTS/STT WebSockets by default, with Paseo's stock provider as the fallback. The orchestrator specified it; Claude chose the shape.
- **Shape:** new `providers/lab/` directory plus one call in `speech-runtime.ts` that wraps whatever the stock path built. Rejected: a new `SpeechProviderId` and config schema entries (touches core types, config persistence and the UI, and makes upstream merges harder). Consequence: lab is selected by env vars, not by the settings UI, and the effective-provider label for TTS still reads as the stock one. This reverses the design note's choice of a new `lab` provider id.
- **Fallback:** TTS falls back only before the first audio frame, so a sentence never switches voice midway. STT falls back at `connect()` and resamples 16 kHz to the fallback's rate with linear interpolation.
- **Status:** verified. Provider tests with a fake loopback WebSocket server pass (13 tests). A headless script spoke "The quick brown fox jumps over the lazy dog." through the lab TTS and the lab STT returned the same text; first audio took 542 ms on that cold-ish call.
- **Status:** assumed. The settings UI and the "effective provider" readout do not know about the lab; settle by wiring a provider id once ticket A's design says where it should surface. Linear-interpolation resampling is adequate for speech recognition; settle with a fallback-path accuracy test against the stock STT.

## Action-item ledger (MIC-750 C)

**Decided:** a pure TypeScript state machine (`draft | refined | agreed | dropped`) with an injected store, announcer and launcher, in `packages/server/src/server/pyrgos/ledger/`. Agreement needs an explicit `agree(id, { confirmed: true })` and a complete item (scope, project, done-criteria).
**Who:** the orchestrator specified the ticket and the contract; Claude chose the details below.
**Why:** the voice agent must never act on a half-formed or merely overheard request; the guard lives in the ledger so no caller can skip it.
**Rejected:** shelling out to the Python `feed.py` (the brief says port the ideas); putting the launch call inside the ledger (it is injected so the design note can wire the dispatch lanes).
**Consequence:** the contract names `agree`; the ticket text names `confirm`. Only `agree` exists. A `confirm` name is a one-line alias if the brain wants it.
**Status:** verified, by `ledger.test.ts` (transitions, rejection of incomplete items, launch-error handling, reload).

## Ledger persistence in its own file

**Decided:** item changes append to `<session>.ledger.jsonl` (full item per row, last row per id wins on load). The transcript `<session>.jsonl` stays as the feed's speaker rows, so announce line numbers are unchanged.
**Who:** Claude.
**Why:** the transcript line number is what the announce line cites; mixing item snapshots into it would shift those numbers and break the contract with the Python feed.
**Rejected:** one combined file.
**Consequence:** two files per session; the panel reads only the ledger file.
**Status:** verified, by `feed.test.ts` and the fixture-driven panel test.

## Port of the feed (lock, announce, replies, turn gate)

**Decided:** `createVoiceSession.append` takes a lock file (`wx` create, stale after 10 seconds) plus an in-process queue so the line count and the write are atomic. Replies not spoken because the gate is busy stay queued rather than being dropped.
**Who:** Claude, porting MIC-749 `feed.py`.
**Why:** two writers in one process (and the Python feed in another) must not hand out the same line number.
**Rejected:** a synchronous spin lock (blocks the server's event loop).
**Consequence:** the lock is advisory and only protects writers that use the same lock file name.
**Status:** verified for concurrent same-process writers (test with 20 parallel appends); assumed for interleaving with the Python writer until both run against one session file.

## Panel as a plugin

**Decided:** the list UI is a directory-source Paseo plugin (`plugin-examples/pyrgos-action-ledger/`) polling one RPC; no core changes.
**Who:** Claude, following the plugin seam preference in the brief.
**Why:** keeps the fork's core diff at zero for this feature.
**Rejected:** a core panel; server push (polling at 2 seconds is enough for a list that changes on human timescales).
**Consequence:** the plugin carries its own copy of the item schema because plugins cannot import host server code; the two must be kept in step.
**Status:** verified for rendering from a fixture; assumed for loading inside a running daemon (not launched here).

## Conversation-agent server module (MIC-750 B)

**Decided:** Add `packages/server/src/server/pyrgos/conversation-agent/` as a self-contained module, with no change to Paseo core. The brain sits behind a small `Brain` interface; the production brain (`SdkBrain`) is one warm Claude Agent SDK session on the subscription login, and tests use a fake. **Who:** the orchestrator specified the module; Claude Sonnet 5.5 designed and built it.

**Why:** The voice agent must answer plain turns in under two seconds, so the session stays warm (streaming input, partial messages) instead of spawning per turn. The `Brain` seam keeps the realtime loop testable without a login.

**Ported from the earlier Python voice agent (idea for idea, not shelled out):** sentence chunker with an early first chunk; redacting context builder (handoff, plan, open tickets, framed as data); the filler rule ("One sec." at once for tool-looking questions, or for turns of four or more words on sonnet and opus, else at the first tool call); barge-in with a generation counter; a read-only tool allowlist; `ANTHROPIC_API_KEY` stripped from the subprocess environment so only the subscription login is used.

**Rejected:** a new voice-session class inside core (large diff, hard to merge upstream); a per-turn SDK `query` (process start on every turn); calling the Python repo (two runtimes).

**Output contract:** the module emits `assistant_chunk` (transcript text), `speak` (text for the speech providers, which produce `audio_output`), `turn_end`, `interrupted` and `error`. Wiring those to the voice session host is left to the speech-provider ticket; this module does not touch `voice-session.ts`.

**Tools:** `status`, `open_tickets`, `read_file`, `search`, plus `list_agents` and `read_agent_timeline` when the daemon passes a `PaseoAgentsPort`. All read only. File reads are confined to the configured roots, follow symlinks to their real path, refuse secret-named files, and redact output.

**Status:** verified. Unit tests run against a fake SDK (agent, chunker, context, redaction, tools, brain). A headless script (`packages/server/scripts/pyrgos-conversation-turn.ts`) drove one live text turn on haiku through the subscription login: the filler came out at once and the reply followed; the cold first reply took about 2.4 s including session start. Warm-turn latency on opus is **assumed** under two seconds and still needs measuring.

**Review fixes (Codex REQUEST_CHANGES, orchestrator relayed; Claude fixed):** (1) two transcripts during one turn both passed `bargeIn()`; now the newest ticket wins, barge-in interrupts a running turn once, and turns never overlap. (2) `SdkBrain.runTurn` treated every SDK result as success; now an error subtype or `is_error` throws, which the agent emits as an `error` event (an interrupted turn's error result is ignored by design). (3) `read_file` read the whole file before the cap; now it reads at most 4 bytes per capped character. (4) `status` returned the context uncapped; now redacted and capped like the other tools. **Status:** verified by new unit tests for each (35 tests pass, lint and typecheck clean).

**Review fixes, round 2 (Codex, orchestrator relayed; Claude fixed):** (1) a hung SDK turn never reached its result, so barge-in waited forever; `interruptTimeoutMs` now abandons the turn and the session is rebuilt on the next one. (2) the credential denylist (`.npmrc`, `.netrc` and similar) was checked on the requested path only; it now also checks the resolved real path, so a symlink cannot reach a secret file. **Status:** verified by two new unit tests (37 pass, lint and typecheck clean).

**Review fixes, round 3 (Codex; Claude fixed):** (1) a rejected `brain.interrupt()` escaped the race in `settle()` and blocked the replacement turn; the rejection is now swallowed and the turn is abandoned at the timeout. (2) the secret-name pattern missed multi-suffix names such as `secrets.production.json`; any `secret(s)` or `credential(s)` name with any suffix is now blocked. **Status:** verified by a new agent test and extended tool tests (38 pass, lint and typecheck clean).

**Review fixes, round 5 (Codex; Claude fixed):** (1) `close()` now marks the agent closed first, so a transcript queued behind the interrupted turn cannot start a new one on a closing brain. (2) `SdkBrain` drops its session when `iterator.next()` throws, so the next turn starts a fresh one. (3) `search` skips a file whose read fails. Non-blocking: `..notes.md` no longer counts as an escape from the root; the markdown cleaner keeps `_` and `*` inside identifiers. **Status:** verified by new tests for each (44 pass, lint and typecheck clean).

**Review fixes, round 6 (Codex; Claude fixed):** (1) the system prompt said the brain never dispatches, which contradicted the demo's delegate action; it now says delegation is proposed through the ledger and confirmed and launched only on the ledger's confirm and launch path. (2) URL credentials whose password contained `@` left part of the password and host visible; the pattern now runs to the last `@` before the path. (3) `read_file` now also denies `.aws/*`, `.git/*`, `.kube/config` and `.config/gh/hosts.yml`, beside the existing `.ssh` and `.gnupg`. **Status:** verified by new tests (46 pass, lint and typecheck clean).

## Voice panel talks to the provider through files (MIC-750 C2)

**Decided:** settings, capabilities and word timings pass between the panel and the TTS provider as three files in the voice directory (see `voice-panel.md`).
**Who:** Claude proposed; the orchestrator's brief required a settings panel and word highlight but the provider had no timestamp event yet.
**Why:** plugins cannot register speech providers or read the audio stream, and the file seam works the same on lab and PC.
**Rejected:** a core change to the speech pipeline; a websocket from the plugin to the provider.
**Consequence:** ticket D2 must write `voice-capabilities.json` and `*.words.jsonl` and read `voice-settings.json` per utterance, or the panel shows defaults and no highlight.
**Status:** verified for clamping, file round-trip and rendering from fixtures; assumed for live sync with a real provider and for Android rendering (neither run here).

## Local Android and desktop builds (MIC-750 E)

- **Decided:** build the APKs locally with Gradle through scripted wrappers (`scripts/pyrgos/build-android.sh` and `.ps1`), not through EAS cloud. **Who:** the overseer set the ticket; Claude implemented.
- **Rejected:** EAS cloud (needs an account and signing credentials; the hard rules forbid both). Using the Android Studio JBR as the JDK: it is Java 25 here and the Gradle/React Native toolchain wants 17-21, so a user-local Temurin 21 is used instead.
- **Chosen:** the production APK is a release build signed with a throwaway debug keystore, generated outside git. It is for sideloading, not for stores.
- **Found by failing:** a first build died because npm blocks native-asset postinstalls (`allowScripts`) for `react-native-enriched-markdown` and `@shopify/react-native-skia`. The build script now runs those two itself.
- **Chosen:** the Windows desktop installer script is written but never run on the lab; the PC builds it.
- **Consequence:** one command per platform; the first lab build takes about 10 minutes for both variants.
- **Status:** verified for Android: both APKs built on the lab and `aapt2 dump badging` reports package `sh.paseo` for each; the PowerShell twin was run under `pwsh` on the lab. **Assumed:** install and launch on a device (none attached).
- **Later PC check (MIC-753 E):** on the Windows PC, electron-builder produced the installer, a silent per-user install showed no licence, elevation or terms page, and the installed app launched to its home screen. `build-desktop.ps1` itself stopped because a running copy of the app held a file in its output folder, so the check built into a side output folder instead. A second copy beside a running one starts only with `PASEO_ELECTRON_USER_DATA_DIR` set, because of the single-instance lock. **Status:** verified by the build and install exit codes and a launch screenshot recorded on MIC-753.

## Lab speech controls, word timestamps and PC fallback (MIC-750 D2)

- **Decided:** add optional TTS `speed`, `pitch` and `emotion` (config defaults plus per-request overrides), optional word timestamps on STT transcripts, and a PC-local tier in the failover order lab -> PC local -> stock. **Who:** the overseer set the scope; Claude designed and implemented it.
- **Chosen:** the PC tier is a second `LabTTS` / `LabSTT` instance pointed at a PC server that speaks the lab wire protocol, chained as the lab's fallback. This reuses the existing failover and replay path in `stt.ts` unchanged. **Rejected:** a separate Windows-native provider (SAPI or similar): a second code path, no way to test it here.
- **Chosen:** `words` is an optional field on the transcript event; stock providers never set it, so the shared interface is unchanged for them.
- **Found by reading the backend:** the lab TTS server ignores `speed` (hardcoded 1.0) and has no pitch or emotion control; the lab STT server runs with `without_timestamps=True` and emits no words; neither server returns TTS alignment. **Rejected:** faking any of these client-side (resampling for pitch, estimating word times). The client sends the fields and parses `words` when present; `docs/pyrgos/lab-speech.md` lists what is unsupported.
- **Consequence:** the options and timestamps become live the moment the lab servers read them; until then they are harmless extra fields.
- **Status:** verified by unit tests against a fake websocket lab (field passthrough, overrides, word parsing, lab -> PC -> stock order for TTS and STT). **Assumed:** the PC tier on Windows (PC-CHECK, untested) and the lab servers' behaviour once they read the new fields.

## Wiring the conversation into the voice session (MIC-753)

- **Decided:** `VoiceSession` takes an optional `conversation` factory; a final transcript goes to it instead of `host.sendSpokenInput`, and its `speak` events play through the existing TTS manager in order. Speech start calls `bargeIn`; cleanup closes it. **Who:** overseer set the ticket; Claude implemented.
- **Chosen:** on by default, `PYRGOS_VOICE_CONVERSATION=0` turns it off. **Rejected:** keeping it opt-in, because the ticket asks for the live voice turn to reach the ledger.
- **Chosen:** the brain gets `propose_action`, `refine_action`, `drop_action` and `list_actions`, and an `agree_action` that code refuses unless the latest transcript is a plain yes and the item was last changed in an earlier turn. **Rejected:** letting the prompt alone gate agreement, because the model could confirm for the user.
- **Chosen:** the dispatch launcher runs `$PYRGOS_DISPATCH_CMD worker <spec> --cwd <project folder>` with a fixed argv (no shell), and treats a start error or a non-zero exit within two seconds as a launch failure recorded on the item.
- **Consequence:** voice mode still needs an agent selected in the app, but spoken turns no longer go to it.
- **Status:** verified: unit tests for the tools, launcher, conversation and voice session; a live haiku run reached `agreed` with the dispatcher dry run. **Assumed:** a spoken turn from a real microphone through the app, and a real (non-dry-run) launch.

## Ack overseer replies on audible completion (MIC-753 A)

- **Decided:** a spoken overseer reply counts as delivered only after the client confirms every chunk played. `generateAndWaitForPlayback` now resolves `true`/`false` (heard / cut off), and `ReplyPump` keeps a cut-off reply queued, ends that drain, holds the turn gate for 20 s and re-speaks it at the first idle boundary after the hold, up to 3 tries. **Who:** a Codex review flagged it; the overseer assigned it; Claude implemented. A first Codex review of the PR caught that the retry fired on the very next idle pump and that a final interruption let the next reply play in the same drain; both fixed before merge.
- **Reversal:** the design note acked at playback _start_ (first `audio_output`) to avoid repeats. That lost any reply the user barged in on, because the TTS manager resolves an aborted playback the same way as a finished one.
- **Rejected:** a time-based retry window alone, because it guesses at playback length; a client protocol change, because the client already sends `audio_played` only after a chunk finishes.
- **Consequence:** an interrupted reply may be heard twice in part; a reply that keeps getting cut off is dropped after 3 tries so it cannot block the queue. Existing callers ignore the new return value.
- **Status:** verified: unit tests in `tts-manager.test.ts` and `feed.test.ts`, server typecheck. **Assumed:** behaviour in a live session; `ReplyPump` is not yet wired into the running voice session (done in the next entry).

## Wire the reply pump into the voice session (MIC-753)

- **Decided:** the voice session passes its conversation a `speak` port that plays a line behind any queued speech and resolves heard or cut off. The Pyrgos conversation runs `ReplyPump` on it: a 2 s poll plus a pump at every turn end; the gate is busy while a turn runs and while the user talks (speech start until the VAD stop or a transcript), then holds 20 s. **Who:** the overseer assigned it; Claude implemented. **Reversal:** the first cut used only a 20 s hold from speech start; the Codex review showed a longer utterance would let a reply play over the user, so the user flag was added. Two later review rounds made every transcript start the hold (the conversation misses the first utterance's VAD events) and stopped a late transcript from clearing a newer utterance's flag. **Consequence:** if a VAD stop is ever lost, replies wait until the next one rather than playing over the user.
- **Rejected:** firing overseer replies as ordinary `speak` events, because that path is fire-and-forget and cannot report a cut-off.
- **Consequence:** a reply waits behind the agent's own queued speech rather than interrupting it. The voice session's own `speak` events now share the same queue code.
- **Status:** verified: `conversation.test.ts` (spoken from the replies file, held after barge-in and re-spoken when cut off, held during a turn) and `voice-session-conversation.test.ts` (port resolves true on `audio_played`, false on barge-in); server typecheck. **Assumed:** a live session on the PC; the persisted reply cursor in DESIGN.md §5 is still an in-memory offset in `ReplyWatcher`, so a daemon restart re-reads the replies file from the start.

## Lab STT replays every unfinalized utterance (MIC-753 D)

- **Decided:** on lab socket loss the fallback gets every committed utterance whose final never arrived, oldest first, then the current audio; each replayed commit keeps the segment id already announced. The buffer is capped (60 s) and drops the oldest committed audio with a logged warning. **Who:** a Codex review (round 6) flagged that only the current utterance was replayed; the overseer assigned it; Claude implemented.
- **Changed with it:** the segment id now rotates at commit, not at the final, so two commits awaiting finals no longer share an id; the lab's finals are matched to commits in order.
- **Rejected:** an unbounded buffer (a stuck lab would grow memory); replaying dropped audio from disk (no such store).
- **Also:** `lab-speech-roundtrip.mts` now covers the voice -> ledger -> delegation steps (stubbed spawn) beside transcription.
- **Status:** verified: lab provider tests (4 new), server typecheck, and the script run against a fake loopback lab (all checks pass). **Assumed:** a run against the real lab.

## Lab STT failover becomes one ordered outbox (MIC-753 D)

- **Decided:** the four buffers (replay, pre-connect queue, held caller frames, pending commits) plus id bookkeeping in `LabSTT` were replaced by one ordered outbox of audio and commit frames with a send cursor. Frames leave only when a final answers them; a new sink (reopened lab socket, connected fallback) replays from cursor 0; one byte cap evicts the oldest audio (commit frames stay, so evicted audio replays as an empty commit); one commit cap in `commit()` terminates a connected-but-silent lab and fails over, otherwise finalizes the oldest announced commit empty. `commit()` always announces its own id; the fallback's `committed` only maps ids FIFO. **Who:** Codex review patching did not converge (9 rounds, each finding a new edge case in the state machine); the overseer had an Opus architect pass design the outbox; Claude Sonnet implemented it.
- **Rejected:** a tenth round of patches; keeping the held buffer to order re-entrant commits (the drain loop's re-entrancy guard gives the same order by appending at the tail).
- **Consequence:** live commits after a failover are now announced under the wrapper's own ids (the old fallback-id announcements are gone); a final with no queued commit ends the current utterance and rotates the id.
- **Status:** verified: `lab.test.ts` (59 tests, including one per round-9 finding: commit lost while the fallback connects, unbounded pre-connect commits in one synchronous loop, re-entrant commit order audio A, commit A, audio B, commit B; plus replay from the oldest unanswered frame and evicted audio replaying as an empty commit), server typecheck, oxlint. **Assumed:** a fresh Codex or non-Codex review, and the real-lab roundtrip. Known edge not covered: a commit dropped by the commit cap after it was already sent to a connected fallback can leave that fallback's late final to pop a later commit.

## Open questions

Design and core seams:

- Is the stock bound-agent path fast enough to drop core change 2? B measures time-to-first-audio.
- Does the ledger plugin need a core change to see the ledger, or is reading the shared JSONL enough?
- Does the daemon discover plugins under `plugin-examples/` or only from a configured directory?

Speech:

- Should the lab become a first-class provider id in settings and the readiness snapshot?
- First-audio latency on the first call after idle (542 ms here, against 44 ms p50 measured warm in the lab docs): is the cause server warm-up or the new connection per sentence? A persistent TTS socket would settle it.
- Will D2 adopt the panel's file contract as written, or expose a server event the plugin can subscribe to instead?
- Does the PC-local server start and take over when the lab is down? Settle with the PC-CHECK command in `lab-speech.md`.
- Which lab-side change lands first: Kokoro `speed` passthrough or faster-whisper `word_timestamps`?

Ledger and conversation:

- Which name does the brain call, `agree` or `confirm`?
- Does the design note (ticket A) want the ledger wired at server start, and where does the `launch` implementation live?
- Warm-turn time to first spoken word on opus (target under 2 s) is not yet measured.
- `list_agents` and `read_agent_timeline` need the daemon to supply a `PaseoAgentsPort`; the adapter is not written.
- Barge-in drain: an interrupted session that does not reach its result within the drain timeout is rebuilt on the next turn. The rebuild path is covered only indirectly.

Builds:

- Does the APK start and reach a daemon over the tailnet? Settle with `adb install` on a phone.
- Should `build-desktop.ps1` take a side output folder, or detect a running copy, so it passes while the app is open?
