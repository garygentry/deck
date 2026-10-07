import type { FreshnessStamp } from "@deck/server";
import { getCards } from "../../registry/registry.js";

const STATIC_FRESHNESS: FreshnessStamp = {
  state: "static",
  observedAt: null,
  ageMs: null,
  ttlMs: null,
};

export function HomePage() {
  const cards = getCards("portal");

  // The persistent HealthHeader region is owned by the shell and rendered
  // in the global <header> on every route — HomePage no longer renders it.
  return (
    <section data-slot="home-page" aria-label="Portal" data-testid="portal" className="flex flex-col gap-6">
      {cards.map((card) => {
        const Card = card.component;
        return <Card key={card.id} data={null} freshness={STATIC_FRESHNESS} />;
      })}
    </section>
  );
}
