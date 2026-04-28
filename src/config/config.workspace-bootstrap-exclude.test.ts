import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

describe("workspace.bootstrap.exclude config schema", () => {
  it("accepts an empty/omitted shape with no behavior change", () => {
    expect(OpenClawSchema.safeParse({}).success).toBe(true);
    expect(OpenClawSchema.safeParse({ workspace: {} }).success).toBe(true);
    expect(OpenClawSchema.safeParse({ workspace: { bootstrap: {} } }).success).toBe(true);
    expect(OpenClawSchema.safeParse({ workspace: { bootstrap: { exclude: [] } } }).success).toBe(
      true,
    );
  });

  it("accepts an array of canonical bootstrap filenames", () => {
    const parsed = OpenClawSchema.safeParse({
      workspace: { bootstrap: { exclude: ["HEARTBEAT.md", "MEMORY.md"] } },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.workspace?.bootstrap?.exclude).toEqual(["HEARTBEAT.md", "MEMORY.md"]);
    }
  });

  it("rejects non-array exclude values", () => {
    const parsed = OpenClawSchema.safeParse({
      workspace: { bootstrap: { exclude: "HEARTBEAT.md" } },
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects unknown sibling keys under workspace.bootstrap (strict)", () => {
    const parsed = OpenClawSchema.safeParse({
      workspace: { bootstrap: { exclude: [], unknownKey: true } },
    });
    expect(parsed.success).toBe(false);
  });
});
