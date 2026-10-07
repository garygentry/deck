import type { DeckConfig } from "@deck/server";
import { useEffect, useState } from "react";

export type ConfigState =
  | { status: "loading" }
  | { status: "ready"; config: DeckConfig }
  | { status: "error"; message: string };

export function useConfig(): ConfigState {
  const [state, setState] = useState<ConfigState>({ status: "loading" });

  useEffect(() => {
    let live = true;
    fetch("/api/config")
      .then(async (response) => {
        if (!response.ok) throw new Error(`GET /api/config → ${response.status}`);
        return (await response.json()) as DeckConfig;
      })
      .then((config) => live && setState({ status: "ready", config }))
      .catch((error: unknown) => {
        if (live) {
          setState({
            status: "error",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      });

    return () => {
      live = false;
    };
  }, []);

  return state;
}
