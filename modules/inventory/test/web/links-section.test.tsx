// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { LinksSection } from "../../web/components/detail-shared.js";

afterEach(cleanup);

describe("LinksSection", () => {
  it("renders a safe href as a link and an unsafe one as text, never as an anchor", () => {
    render(
      <LinksSection
        reality="available"
        links={[
          { title: "Grafana", href: "https://grafana.lab/" },
          { title: "Hosts", href: "/inventory/hosts" },
          { title: "Script", href: "javascript:alert(1)" },
          { title: "Data", href: "data:text/html,<b>x</b>" },
          { title: "Elsewhere", href: "//evil.example/" },
        ]}
      />,
    );
    expect(screen.getByRole("link", { name: "Grafana" })).toHaveAttribute("href", "https://grafana.lab/");
    expect(screen.getByRole("link", { name: "Hosts" })).toHaveAttribute("href", "/inventory/hosts");
    for (const title of ["Script", "Data", "Elsewhere"]) {
      expect(screen.queryByRole("link", { name: title })).toBeNull();
      expect(screen.getByText(title)).toBeInTheDocument();
    }
    expect(screen.getAllByRole("link")).toHaveLength(2);
  });
});
