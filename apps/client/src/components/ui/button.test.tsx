import { render, screen } from "@testing-library/react";
import { describe, it } from "vitest";

import { Button } from "#/components/ui/button";

describe("Button", () => {
  it("renders the provided label", () => {
    render(<Button>Hello world</Button>);

    screen.getByRole("button", { name: "Hello world" });
  });
});
