import { describe, expect, it } from "vitest";
import { merge } from "../src/dotenv.js";

describe("dotenv rebase", () => {
  it("keeps template layout but uses whole local value tokens without evaluating them", () => {
    const template =
      "\uFEFF# new\r\nexport TOKEN = default  # hint\r\nEMPTY=x\r\nNEW='sample'";
    const local = 'OLD=discard\nEMPTY=\nTOKEN="a=#x\n${OTHER}" # old\n';
    const result = merge(template, local);
    expect(result).toEqual({
      ok: true,
      text: "\uFEFF# new\r\nexport TOKEN = \"a=#x\n${OTHER}\"  # hint\r\nEMPTY=\r\nNEW='sample'",
      keys: { added: ["NEW"], removed: ["OLD"], preserved: ["TOKEN", "EMPTY"] },
    });
    if (result.ok)
      expect(merge(template, result.text)).toMatchObject({
        ok: true,
        text: result.text,
      });
  });

  it.each([
    "A=1\nA=2",
    'A="open',
    'A="v"suffix',
    "raw secret",
    "X=one\\\n",
    "X=\0",
    "X=x\rY=y",
  ])("rejects unsupported input %# without echoing it", (local) => {
    expect(merge("A=x", local)).toMatchObject({
      ok: false,
      code: "INVALID_ENV",
    });
  });
});
