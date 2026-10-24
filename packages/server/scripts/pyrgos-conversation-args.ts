export interface ConversationScriptArgs {
  model: string | undefined;
  turns: string[];
}

/** Split argv into turns and the optional `--model <name>`; other `--flags` are ignored. */
export function parseConversationArgs(args: string[]): ConversationScriptArgs {
  const mi = args.indexOf("--model");
  const model = mi >= 0 ? args[mi + 1] : undefined;
  const turns = args.filter(
    (arg, i) => !(mi >= 0 && (i === mi || i === mi + 1)) && !arg.startsWith("--"),
  );
  return { model, turns };
}
