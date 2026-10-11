# Third-party notices

deck is MIT-licensed (see `LICENSE`). It includes the following third-party code in its own
source tree, under that code's licence.

## jmespath.js 0.16.0

- **What:** the JMESPath reference implementation for JavaScript, which evaluates a widget's
  `select` on the server.
- **Source:** https://github.com/jmespath/jmespath.js (npm `jmespath@0.16.0`).
- **Copyright:** Copyright 2014 James Saryerwinnie.
- **Licence:** Apache License 2.0. The full text is in `packages/schema/src/select/LICENSE`.
- **Where:** `packages/schema/src/select/jmespath.js`.
- **Modified:** yes. deck's changes are marked `deck:` in the file and listed in its header: an
  ES module exporting the interpreter, unforgeable expression references, own-property reads,
  number-only ordering, a work meter, and linear `starts_with`/`ends_with`.
