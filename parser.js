const NEST_LIMIT = 8;

export function parse(text, options = {}) {
  const parser = new Parser(String(text ?? ""), options);
  return parser.parseDocument();
}

class Parser {
  constructor(text, options = {}) {
    this.text = text;
    this.n = text.length;
    this.i = 0;
    this.nestDepth = options.nestDepth ?? 0;
    this.allowNest = options.nest !== false;
    this.stopped = false;
  }

  eof() {
    return this.i >= this.n;
  }

  peek(offset = 0) {
    return this.text[this.i + offset];
  }

  skipTrivia() {
    while (!this.eof()) {
      const c = this.peek();

      if (c === " " || c === "\t" || c === "\n" || c === "\r") {
        this.i += 1;
        continue;
      }

      if (c === "/" && this.peek(1) === "/") {
        this.i += 2;
        while (!this.eof() && this.peek() !== "\n") this.i += 1;
        continue;
      }

      if (c === "/" && this.peek(1) === "*") {
        this.i += 2;
        while (!this.eof() && !(this.peek() === "*" && this.peek(1) === "/")) {
          this.i += 1;
        }
        if (this.eof()) {
          this.stopped = true;
        } else {
          this.i += 2;
        }
        continue;
      }

      break;
    }
  }

  parseDocument() {
    const items = [];
    this.skipTrivia();

    while (!this.eof()) {
      const start = this.i;
      items.push(this.parseValue());
      this.skipTrivia();

      if (this.i === start) {
        this.i += 1;
        this.stopped = true;
        break;
      }
    }

    if (items.length === 0) {
      return { type: "missing", truncated: this.stopped || this.n > 0 };
    }

    if (items.length === 1) {
      if (this.stopped && !items[0].truncated) items[0].truncated = true;
      return items[0];
    }

    return { type: "doc", items, truncated: this.stopped || items.some((n) => n.truncated) };
  }

  parseValue() {
    this.skipTrivia();

    if (this.eof()) {
      this.stopped = true;
      return { type: "missing", truncated: true };
    }

    const c = this.peek();

    if (c === "{") return this.parseObject();
    if (c === "[") return this.parseArray();
    if (c === '"') return this.parseString(true);

    if (c === "-" || (c >= "0" && c <= "9")) return this.parseNumber();

    if (c === "t" || c === "f" || c === "n") return this.parseLiteral();

    this.i += 1;
    this.stopped = true;
    return { type: "missing", truncated: true };
  }

  parseObject() {
    this.i += 1;
    const entries = [];
    let truncated = false;

    while (true) {
      this.skipTrivia();

      if (this.eof()) {
        truncated = true;
        break;
      }

      if (this.peek() === "}") {
        this.i += 1;
        break;
      }

      if (this.peek() === ",") {
        this.i += 1;
        continue;
      }

      if (this.peek() !== '"') {
        truncated = true;
        this.stopped = true;
        break;
      }

      const keyNode = this.parseString(false);
      this.skipTrivia();

      let value;

      if (this.peek() === ":") {
        this.i += 1;
        this.skipTrivia();
        value = this.eof()
          ? ((this.stopped = true), { type: "missing", truncated: true })
          : this.parseValue();
      } else {
        this.stopped = true;
        truncated = true;
        value = { type: "missing", truncated: true };
      }

      entries.push({
        key: keyNode.value,
        keyTruncated: Boolean(keyNode.truncated),
        value,
      });

      if (keyNode.truncated || value.truncated) truncated = true;

      this.skipTrivia();

      if (this.peek() === ",") {
        this.i += 1;
        continue;
      }

      if (this.peek() === "}") {
        this.i += 1;
        break;
      }

      if (this.eof()) {
        truncated = true;
        this.stopped = true;
        break;
      }

      truncated = true;
      this.stopped = true;
      break;
    }

    return { type: "object", entries, truncated };
  }

  parseArray() {
    this.i += 1;
    const items = [];
    let truncated = false;

    while (true) {
      this.skipTrivia();

      if (this.eof()) {
        truncated = true;
        break;
      }

      if (this.peek() === "]") {
        this.i += 1;
        break;
      }

      if (this.peek() === ",") {
        this.i += 1;
        continue;
      }

      const value = this.parseValue();
      items.push(value);
      if (value.truncated) truncated = true;

      this.skipTrivia();

      if (this.peek() === ",") {
        this.i += 1;
        continue;
      }

      if (this.peek() === "]") {
        this.i += 1;
        break;
      }

      if (this.eof()) {
        truncated = true;
        this.stopped = true;
        break;
      }

      truncated = true;
      this.stopped = true;
      break;
    }

    return { type: "array", items, truncated };
  }

  parseString(allowNest) {
    this.i += 1;
    let out = "";
    let closed = false;

    while (!this.eof()) {
      const c = this.peek();

      if (c === '"') {
        this.i += 1;
        closed = true;
        break;
      }

      if (c === "\n" || c === "\r") {
        this.stopped = true;
        break;
      }

      if (c === "\\") {
        this.i += 1;
        if (this.eof()) {
          this.stopped = true;
          break;
        }
        out += this.readEscape();
        continue;
      }

      out += c;
      this.i += 1;
    }

    if (!closed) this.stopped = true;

    const node = { type: "string", value: out, truncated: !closed };

    if (allowNest && closed && !node.truncated) this.maybeNest(node);

    return node;
  }

  readEscape() {
    const c = this.peek();
    this.i += 1;

    switch (c) {
      case '"':
      case "\\":
      case "/":
        return c;
      case "b":
        return "\b";
      case "f":
        return "\f";
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      case "u": {
        let hex = "";
        for (let k = 0; k < 4 && !this.eof(); k += 1) {
          hex += this.peek();
          this.i += 1;
        }
        if (hex.length < 4) {
          this.stopped = true;
          return "";
        }
        const code = Number.parseInt(hex, 16);
        return Number.isNaN(code) ? "" : String.fromCharCode(code);
      }
      default:
        return c;
    }
  }

  parseNumber() {
    const start = this.i;

    if (this.peek() === "-") this.i += 1;

    if (this.eof()) {
      this.stopped = true;
      return { type: "missing", truncated: true };
    }

    while (!this.eof() && this.peek() >= "0" && this.peek() <= "9") this.i += 1;

    if (this.peek() === ".") {
      this.i += 1;
      while (!this.eof() && this.peek() >= "0" && this.peek() <= "9") this.i += 1;
    }

    if (this.peek() === "e" || this.peek() === "E") {
      this.i += 1;
      if (this.peek() === "+" || this.peek() === "-") this.i += 1;
      while (!this.eof() && this.peek() >= "0" && this.peek() <= "9") this.i += 1;
    }

    const raw = this.text.slice(start, this.i);

    if (raw === "-" || raw === "." || raw === "-." || raw === "") {
      this.stopped = true;
      return { type: "missing", truncated: true };
    }

    const incomplete =
      raw.endsWith(".") ||
      raw.endsWith("e") ||
      raw.endsWith("E") ||
      raw.endsWith("+") ||
      raw.endsWith("-");

    if (incomplete) this.stopped = true;

    return { type: "number", value: Number(raw), raw, truncated: incomplete };
  }

  parseLiteral() {
    const start = this.i;
    while (!this.eof() && /[a-z]/.test(this.peek())) this.i += 1;
    const word = this.text.slice(start, this.i);

    const table = [
      ["true", { type: "boolean", value: true }],
      ["false", { type: "boolean", value: false }],
      ["null", { type: "null" }],
    ];

    for (const [full, node] of table) {
      if (word === full) return { ...node, truncated: false };
      if (full.startsWith(word) && this.eof()) {
        this.stopped = true;
        return { ...node, truncated: true };
      }
    }

    this.stopped = true;
    return { type: "missing", truncated: true };
  }

  maybeNest(node) {
    if (!this.allowNest || this.nestDepth >= NEST_LIMIT) return;

    const trimmed = node.value.trim();
    if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return;

    const nested = parse(node.value, { nestDepth: this.nestDepth + 1, nest: true });

    if (!isUsefulNest(nested)) return;

    node.nested = nested;
  }
}

function isUsefulNest(node) {
  if (!node) return false;
  if (node.type === "object") {
    return node.entries.length > 0 || !node.truncated;
  }
  if (node.type === "array") {
    return node.items.length > 0 || !node.truncated;
  }
  return false;
}

export function countValues(node) {
  if (!node) return 0;
  if (node.type === "doc") return node.items.filter((n) => n.type !== "missing").length;
  if (node.type === "missing") return 0;
  return 1;
}

export function isEmptyAst(node) {
  return !node || node.type === "missing";
}
