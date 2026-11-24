/** Safe to render: key names only, in input order. */
export type Keys = Readonly<
  Record<"added" | "removed" | "preserved", readonly string[]>
>;

type Token = {
  readonly start: number;
  readonly end: number;
  readonly raw: string;
};
type Invalid = {
  readonly ok: false;
  readonly code: "INVALID_ENV";
  readonly message: string;
};

function parse(text: string, role: "Example" | "Local file") {
  const tokens = new Map<string, Token>();
  let i = text.startsWith("\uFEFF") ? 1 : 0;
  function invalid(reason: string): Invalid {
    const line = text.slice(0, i).split("\n").length;
    return {
      ok: false,
      code: "INVALID_ENV",
      message: `${role}, line ${line}: ${reason}. Check the file and retry.`,
    };
  }
  if (/\0|\r(?!\n)/.test(text))
    return invalid("expected text with LF or CRLF endings");
  // Sticky expressions consume one physical line at a time, except quoted values.
  const head = /[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z_0-9]*)[ \t]*=/y;
  const trivia = /[ \t]*(?:#[^\r\n]*)?(?:\r?\n|$)/y;
  const spaces = /[ \t]*/y;
  const unquoted = /[^#\r\n]*/y;
  while (i < text.length) {
    trivia.lastIndex = i;
    if (trivia.test(text)) {
      i = trivia.lastIndex;
      continue;
    }
    head.lastIndex = i;
    const key = head.exec(text)?.[1];
    if (!key) return invalid("expected KEY=value or a comment");
    if (tokens.has(key)) return invalid("duplicate key");
    spaces.lastIndex = head.lastIndex;
    spaces.test(text);
    let start = spaces.lastIndex;
    let end = start;
    const quote = text[start];
    if (quote === '"' || quote === "'" || quote === "`") {
      end++;
      while (end < text.length && text[end] !== quote)
        end += text[end] === "\\" ? 2 : 1;
      if (end >= text.length) return invalid("unterminated quoted value");
      end++;
    } else {
      unquoted.lastIndex = start;
      unquoted.test(text);
      let stop = unquoted.lastIndex;
      while (
        stop > start &&
        (text[stop - 1] === " " || text[stop - 1] === "\t")
      )
        stop--;
      const raw = text.slice(start, stop);
      if (raw.endsWith("\\"))
        return invalid("unquoted trailing escapes are unsupported");
      // In `A=  # hint`, keep the gap on the comment side of a replacement.
      if (!raw) start = head.lastIndex;
      end = start + raw.length;
    }
    trivia.lastIndex = end;
    if (!trivia.test(text)) return invalid("unexpected text after value");
    tokens.set(key, { start, end, raw: text.slice(start, end) });
    i = trivia.lastIndex;
  }
  return { ok: true, tokens } as const;
}

/** Replace only template value spans. The resulting text is secret; never render it. */
export function merge(example: string, local: string) {
  const template = parse(example, "Example");
  if (!template.ok) return template;
  const existing = parse(local, "Local file");
  if (!existing.ok) return existing;
  let last = 0;
  const chunks: string[] = [],
    added: string[] = [],
    preserved: string[] = [];
  for (const [key, token] of template.tokens) {
    const old = existing.tokens.get(key);
    (old ? preserved : added).push(key);
    chunks.push(example.slice(last, token.start), old?.raw ?? token.raw);
    last = token.end;
  }
  chunks.push(example.slice(last));
  const removed = [...existing.tokens.keys()].filter(
    (key) => !template.tokens.has(key),
  );
  return {
    ok: true,
    text: chunks.join(""),
    keys: { added, preserved, removed },
  } as const;
}
