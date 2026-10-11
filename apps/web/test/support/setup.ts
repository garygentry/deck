import "@testing-library/jest-dom/vitest";

// Tell React that this environment supports `act()`, so state updates flushed
// through `act` don't log "not wrapped in act(...)" warnings.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Every test starts with an empty shared query cache, as a fresh page load would.
import { afterEach } from "vitest";
import { resetQueryClient } from "../../src/data/query-client.js";

afterEach(() => {
  resetQueryClient();
});
