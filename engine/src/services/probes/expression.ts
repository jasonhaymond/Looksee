// A small, safe calculator for check values: "value / 10", "(a - b) / a * 100",
// "max(value, 0)", "round(ref * 8 / 1e6, 2)".
//
// Where this sits: SNMP checks apply their "Calculate" setting to the value
// they read (probes/snmp.ts), and "Calculated value" checks combine other
// checks' latest values (services/calculated.ts). No database access, so the
// site collector can use it too.
//
// Security: the expression is typed by an admin, but it is never run as code.
// It's read character by character into numbers, names, operators and
// brackets (a "tokenizer"), then worked out by a hand-written parser that
// only knows + - * / % ^, brackets, the variables it's given, and the
// functions listed in FUNCTIONS. Anything else is an error. Length and
// nesting are limited so a hostile expression can't use up CPU or memory.

/** Functions an expression may call, with how many arguments each takes. */
const FUNCTIONS: Record<string, { min: number; max: number; fn: (...a: number[]) => number }> = {
  min: { min: 1, max: 20, fn: (...a) => Math.min(...a) },
  max: { min: 1, max: 20, fn: (...a) => Math.max(...a) },
  abs: { min: 1, max: 1, fn: (x) => Math.abs(x) },
  // round(x) or round(x, digits) — digits after the decimal point (0–10).
  round: { min: 1, max: 2, fn: (x, d = 0) => Math.round(x * 10 ** Math.min(10, Math.max(0, Math.trunc(d)))) / 10 ** Math.min(10, Math.max(0, Math.trunc(d))) },
  floor: { min: 1, max: 1, fn: (x) => Math.floor(x) },
  ceil: { min: 1, max: 1, fn: (x) => Math.ceil(x) },
  sqrt: { min: 1, max: 1, fn: (x) => Math.sqrt(x) },
  log10: { min: 1, max: 1, fn: (x) => Math.log10(x) },
};

const MAX_LENGTH = 500;
const MAX_DEPTH = 30;

type Token = { kind: "num"; value: number } | { kind: "name"; value: string } | { kind: "op"; value: string };

/**
 * Splits an expression into tokens. Numbers may use a decimal point and an
 * exponent (1e6, 2.5E-3); names are letters, digits and underscores starting
 * with a letter or underscore; operators are + - * / % ^ ( ) and the comma.
 */
function tokenize(text: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  // One character at a position ("" past the end).
  const ch = (k: number) => text.charAt(k);
  while (i < text.length) {
    const c = ch(i);
    if (c === " " || c === "\t") {
      i++;
      continue;
    }
    if ((c >= "0" && c <= "9") || (c === "." && ch(i + 1) >= "0" && ch(i + 1) <= "9")) {
      let j = i;
      while (j < text.length && ((ch(j) >= "0" && ch(j) <= "9") || ch(j) === ".")) j++;
      // Optional exponent: e or E, an optional sign, then digits.
      if ((ch(j) === "e" || ch(j) === "E") && /[0-9+-]/.test(ch(j + 1))) {
        j++;
        if (ch(j) === "+" || ch(j) === "-") j++;
        while (j < text.length && ch(j) >= "0" && ch(j) <= "9") j++;
      }
      const n = Number(text.slice(i, j));
      if (!Number.isFinite(n)) throw new Error(`"${text.slice(i, j)}" isn't a number`);
      out.push({ kind: "num", value: n });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < text.length && /[A-Za-z0-9_]/.test(ch(j))) j++;
      out.push({ kind: "name", value: text.slice(i, j) });
      i = j;
      continue;
    }
    if ("+-*/%^(),".includes(c)) {
      out.push({ kind: "op", value: c });
      i++;
      continue;
    }
    throw new Error(`Unexpected "${c}" in the expression`);
  }
  return out;
}

/**
 * Works out an expression with the given variables.
 *
 * @param text e.g. "(a - b) / a * 100"
 * @param vars variable values by name, e.g. { value: 42 } or { a: 10, b: 4 }
 * @returns the result (a finite number)
 * @throws Error with a readable message for any mistake: unknown names,
 *   missing brackets, division by zero, a non-finite result
 */
export function evaluateExpression(text: string, vars: Record<string, number>): number {
  if (text.length > MAX_LENGTH) throw new Error(`The expression is longer than ${MAX_LENGTH} characters`);
  const tokens = tokenize(text);
  if (!tokens.length) throw new Error("The expression is empty");
  let pos = 0;
  let depth = 0;
  const peek = () => tokens.at(pos);
  const isOp = (v: string) => peek()?.kind === "op" && peek()!.value === v;
  const expect = (v: string) => {
    if (!isOp(v)) throw new Error(`Expected "${v}"`);
    pos++;
  };
  const nest = <T>(f: () => T): T => {
    if (++depth > MAX_DEPTH) throw new Error("The expression is nested too deeply");
    try {
      return f();
    } finally {
      depth--;
    }
  };

  // expression := term (("+" | "-") term)*
  const expression = (): number =>
    nest(() => {
      let v = term();
      while (isOp("+") || isOp("-")) {
        const op = tokens[pos++].value;
        const r = term();
        v = op === "+" ? v + r : v - r;
      }
      return v;
    });
  // term := unary (("*" | "/" | "%") unary)*
  const term = (): number => {
    let v = unary();
    while (isOp("*") || isOp("/") || isOp("%")) {
      const op = tokens[pos++].value;
      const r = unary();
      if ((op === "/" || op === "%") && r === 0) throw new Error("Division by zero");
      v = op === "*" ? v * r : op === "/" ? v / r : v % r;
    }
    return v;
  };
  // unary := ("-" | "+") unary | power
  const unary = (): number =>
    nest(() => {
      if (isOp("-")) {
        pos++;
        return -unary();
      }
      if (isOp("+")) {
        pos++;
        return unary();
      }
      return power();
    });
  // power := primary ("^" unary)?
  const power = (): number => {
    const base = primary();
    if (isOp("^")) {
      pos++;
      return base ** unary();
    }
    return base;
  };
  // primary := number | name | name "(" args ")" | "(" expression ")"
  const primary = (): number => {
    const t = peek();
    if (!t) throw new Error("The expression ends too early");
    if (t.kind === "num") {
      pos++;
      return t.value;
    }
    if (t.kind === "name") {
      pos++;
      if (isOp("(")) {
        // Object.hasOwn: only the listed functions, never inherited
        // properties like "constructor".
        if (!Object.hasOwn(FUNCTIONS, t.value)) throw new Error(`Unknown function "${t.value}" (available: ${Object.keys(FUNCTIONS).join(", ")})`);
        const f = FUNCTIONS[t.value];
        pos++;
        const args: number[] = [];
        if (!isOp(")")) {
          args.push(expression());
          while (isOp(",")) {
            pos++;
            args.push(expression());
          }
        }
        expect(")");
        if (args.length < f.min || args.length > f.max) throw new Error(`${t.value}() takes ${f.min === f.max ? f.min : `${f.min}–${f.max}`} argument(s)`);
        return f.fn(...args);
      }
      if (!Object.hasOwn(vars, t.value)) throw new Error(`Unknown name "${t.value}" (available: ${Object.keys(vars).join(", ") || "none"})`);
      return vars[t.value];
    }
    if (t.value === "(") {
      pos++;
      const v = expression();
      expect(")");
      return v;
    }
    throw new Error(`Unexpected "${t.value}"`);
  };

  const result = expression();
  if (pos < tokens.length) throw new Error(`Unexpected "${String(tokens.at(pos)?.value)}" after the end of the expression`);
  if (!Number.isFinite(result)) throw new Error("The result isn't a finite number");
  return result;
}

/** The variable names an expression uses (for validation and the form). */
export function expressionNames(text: string): string[] {
  try {
    const tokens = tokenize(text);
    return [...new Set(tokens.filter((t, i) => t.kind === "name" && !(tokens[i + 1]?.kind === "op" && tokens[i + 1].value === "(")).map((t) => String(t.value)))];
  } catch {
    return [];
  }
}
