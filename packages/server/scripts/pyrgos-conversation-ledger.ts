// Headless check of the voice-turn path with the real brain: several text turns through
// createPyrgosConversation (the same object the daemon's voice session uses), ledger and launcher included.
//   tsx scripts/pyrgos-conversation-ledger.ts "<turn 1>" "<turn 2>" ... [--model haiku|sonnet|opus]
// Env: ALCHEMIST_HARNESS, ALCHEMIST_WORKSHOP, PYRGOS_DISPATCH_CMD (dispatch.sh), PYRGOS_DISPATCH_EXTRA_ARGS
// (for example "--dry-run --test none"), the announce line is printed, not sent.
import { createPyrgosConversation } from "../src/server/pyrgos/conversation.js";
import { parseConversationArgs } from "./pyrgos-conversation-args.js";

const { model, turns } = parseConversationArgs(process.argv.slice(2));
if (model !== undefined) process.env.PYRGOS_CONVERSATION_MODEL = model;
if (turns.length === 0) {
  console.error('usage: pyrgos-conversation-ledger.ts "<turn>"... [--model haiku|sonnet|opus]');
  process.exit(2);
}

const conversation = await createPyrgosConversation({
  // Printed, not sent: this check must not write to the overseer inbox.
  announce: async (item) => console.log(`announce: ${item.item}`),
  onEvent: (event) => {
    if (event.type === "speak" || event.type === "error") console.log(JSON.stringify(event));
  },
});
for (const turn of turns) {
  console.log(`> ${turn}`);
  await conversation.handleTranscript(turn);
}
console.log(JSON.stringify(conversation.ledger.list(), null, 2));
await conversation.close();
const last = conversation.ledger.list().at(-1);
process.exit(last?.state === "agreed" && !last.launchError ? 0 : 1);
