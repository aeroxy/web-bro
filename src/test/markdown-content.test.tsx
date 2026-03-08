import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MarkdownContent } from "../components/MarkdownContent";

describe("MarkdownContent", () => {
  it("renders headings and fenced code blocks", () => {
    render(
      <MarkdownContent
        content={`# Web Bro

\`\`\`markdown
hello
\`\`\``}
      />,
    );

    expect(
      screen.getByRole("heading", {
        name: "Web Bro",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("hello")).toBeInTheDocument();
  });
});
