import "@testing-library/jest-dom/vitest";

// Tell React that this environment supports `act()`, so state updates flushed
// through `act` don't log "not wrapped in act(...)" warnings.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
