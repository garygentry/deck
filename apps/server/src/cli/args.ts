export interface ParsedArgs {
  dir?: string;
  out?: string;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--config") {
      parsed.dir = argv[index + 1];
      index += 1;
    } else if (argument === "--out") {
      parsed.out = argv[index + 1];
      index += 1;
    } else if (!argument.startsWith("-") && parsed.dir === undefined) {
      parsed.dir = argument;
    }
  }
  return parsed;
}
