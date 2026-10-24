import { z } from "zod";
import { LedgerError, type Ledger, type LedgerItem } from "../ledger/ledger.js";
import { redact } from "./redact.js";
import type { ToolDef } from "./tools.js";

// The yes must open the reply (after a filler word), so "I never said yes" is not consent. A
// condition after it ("yes, after I review it") is not a plain yes either.
const YES =
  /^\W*(?:(?:ok|okay|well|um|uh|so|alright|all right|right)\W+)*(?:yes|yeah|yep|yup|do it|go ahead|go for it|confirm(?:ed)?|approved?|please do|make it so|sounds good)\b/i;
const NO =
  /\b(no|nope|not|never|don'?t|do not|wait|hold on|hold off|stop|cancel|never ?mind|after|before|if|unless|until|once|when|but|only|provided|as long as|first|later|tomorrow)\b|n't\b/i;

/** True when the user's last words are a plain yes to a proposal. Code, not the model, decides. */
export function isAffirmative(text: string): boolean {
  return YES.test(text) && !NO.test(text);
}

export interface LedgerToolsOptions {
  ledger: Ledger;
  /** What the user said in the current turn. */
  latestUserText: () => string;
  /** Counts user turns; an item must have been shown to the user in an earlier turn to be agreed. */
  turn: () => number;
  /** `<path>#<line>` of the current user line, stored on a new item. */
  transcriptRef?: () => string | null;
}

function describe(item: LedgerItem): string {
  const parts = [
    `id ${item.id}`,
    item.state,
    item.item,
    `scope: ${item.scope ?? "missing"}`,
    `project: ${item.project ?? "missing"}`,
    `done when: ${item.doneCriteria ?? "missing"}`,
  ];
  if (item.launchError) parts.push(`launch failed: ${item.launchError}`);
  else if (item.launchedAt) parts.push("launched");
  return redact(parts.join(" | "));
}

/**
 * Tools that let the voice brain keep the action-item ledger. The brain can propose, refine and
 * drop. It cannot agree on its own say-so: `agree_action` runs only when the user's latest words
 * are a yes and the item was last changed in an earlier turn. Agreeing announces and launches
 * through the injected ledger path; the brain launches nothing itself.
 */
export function createLedgerTools(options: LedgerToolsOptions): ToolDef[] {
  const { ledger } = options;
  const changedAt = new Map<string, number>();
  const touch = (item: LedgerItem) => {
    changedAt.set(item.id, options.turn());
    return item;
  };
  const guard = async (run: () => Promise<string> | string): Promise<string> => {
    try {
      return await run();
    } catch (error) {
      if (error instanceof LedgerError) return `Not done: ${error.message}`;
      throw error;
    }
  };

  return [
    {
      name: "propose_action",
      description:
        "Record something the user asked to have done as a draft action item. Say it back in one sentence and ask what is missing. Nothing runs yet.",
      shape: { item: z.string().describe("The work, in one sentence") },
      run: (args) =>
        guard(() => {
          const created = touch(
            ledger.propose({
              item: String(args.item ?? ""),
              ...(options.transcriptRef?.()
                ? { transcriptRef: options.transcriptRef() ?? "" }
                : {}),
            }),
          );
          return `Drafted. ${describe(created)}`;
        }),
    },
    {
      name: "refine_action",
      description:
        "Fill in or change a draft: scope, project (folder name), done criteria, or the item text. All three of scope, project and done criteria are needed before it can be agreed. Read the item back and ask the user to confirm.",
      shape: {
        id: z.string(),
        item: z.string().optional(),
        scope: z.string().optional(),
        project: z.string().optional(),
        doneCriteria: z.string().optional(),
      },
      run: (args) =>
        guard(() => {
          const refined = touch(
            ledger.refine(String(args.id ?? ""), {
              ...(typeof args.item === "string" ? { item: args.item } : {}),
              ...(typeof args.scope === "string" ? { scope: args.scope } : {}),
              ...(typeof args.project === "string" ? { project: args.project } : {}),
              ...(typeof args.doneCriteria === "string" ? { doneCriteria: args.doneCriteria } : {}),
            }),
          );
          return `Updated. ${describe(refined)}`;
        }),
    },
    {
      name: "agree_action",
      description:
        "Lock in a refined item and hand it to an agent. Call it only after the user has heard the full item read back and then said yes in their latest message. It is refused otherwise.",
      shape: { id: z.string() },
      run: (args) =>
        guard(async () => {
          const id = String(args.id ?? "");
          const item = ledger.get(id);
          if (!isAffirmative(options.latestUserText())) {
            return "Not done: the user has not said yes in their latest message. Read the item back and ask.";
          }
          if ((changedAt.get(item.id) ?? 0) >= options.turn()) {
            return "Not done: the user has not heard this item read back yet. Read it back and ask for a yes.";
          }
          const agreed = await ledger.agree(id, { confirmed: true });
          return agreed.launchError
            ? `Agreed, but the launch failed: ${redact(agreed.launchError)}. Tell the user.`
            : `Agreed and handed to an agent. ${describe(agreed)}`;
        }),
    },
    {
      name: "drop_action",
      description: "Drop a draft or refined item the user no longer wants.",
      shape: { id: z.string(), reason: z.string().optional() },
      run: (args) =>
        guard(() => {
          const dropped = ledger.drop(
            String(args.id ?? ""),
            typeof args.reason === "string" ? args.reason : undefined,
          );
          return `Dropped. ${describe(dropped)}`;
        }),
    },
    {
      name: "list_actions",
      description: "List the open action items and their state.",
      shape: {},
      run: async () => {
        const open = ledger.list().filter((i) => i.state === "draft" || i.state === "refined");
        return open.length ? open.map(describe).join("\n") : "No open action items.";
      },
    },
  ];
}
