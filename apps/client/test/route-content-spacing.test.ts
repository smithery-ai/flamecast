import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testDir = dirname(fileURLToPath(import.meta.url));
const expectedContentSpacing = 'className="flex flex-col gap-8 py-6"';

function readRouteSource(name: string): string {
  return readFileSync(resolve(testDir, `../src/routes/${name}.tsx`), "utf8");
}

describe("settings area route spacing", () => {
  it("keeps the same top and bottom content padding across settings, agents, and queue", () => {
    expect(readRouteSource("settings")).toContain(expectedContentSpacing);
    expect(readRouteSource("agents")).toContain(expectedContentSpacing);
    expect(readRouteSource("queue")).toContain(expectedContentSpacing);
  });
});
