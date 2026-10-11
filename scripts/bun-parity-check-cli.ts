// The command the bun-parity wrapper runs: `bun scripts/bun-parity-check-cli.ts <summary.json>`.
// It always runs `main`. A "was I run directly?" guard could fail open (exit 0 unchecked) when
// the script is reached through a symlink.
import { main } from "./bun-parity-check.ts";

process.exit(main(process.argv[2]));
