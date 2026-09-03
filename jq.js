export function applyJq(inputs, filter) {
  const trimmed = String(filter ?? "").trim();
  if (!trimmed) return { ok: true, values: inputs, passthrough: true };

  try {
    const ast = parseJq(trimmed);
    const values = [];
    for (const input of inputs) values.push(...evalNode(ast, input));
    return { ok: true, values };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function parseJq(text) {
  const p = new JqParser(String(text ?? ""));
  const ast = p.parsePipe();
  p.skip();
  if (!p.eof()) p.fail(`unexpected ${p.preview()}`);
  return ast;
}

class JqParser {
  constructor(text) {
    this.s = text;
    this.n = text.length;
    this.i = 0;
  }

  eof() {
    return this.i >= this.n;
  }

  fail(msg) {
    throw new Error(`jq: ${msg}`);
  }

  preview() {
    this.skip();
    return this.eof() ? "end of filter" : JSON.stringify(this.s.slice(this.i, this.i + 12));
  }

  skip() {
    while (this.i < this.n) {
      const c = this.s[this.i];
      if (c === "#") {
        while (this.i < this.n && this.s[this.i] !== "\n") this.i += 1;
        continue;
      }
      if (c === " " || c === "\t" || c === "\n" || c === "\r") {
        this.i += 1;
        continue;
      }
      break;
    }
  }

  peek() {
    this.skip();
    return this.s[this.i];
  }

  starts(str) {
    this.skip();
    return this.s.startsWith(str, this.i);
  }

  eat(str) {
    this.skip();
    if (!this.s.startsWith(str, this.i)) return false;
    const next = this.s[this.i + str.length];
    if (/^[A-Za-z0-9_]$/.test(str.at(-1)) && /[A-Za-z0-9_]/.test(next ?? "")) return false;
    this.i += str.length;
    return true;
  }

  expect(str) {
    if (!this.eat(str)) this.fail(`expected ${JSON.stringify(str)}, got ${this.preview()}`);
  }

  parsePipe() {
    let node = this.parseComma();
    while (this.eat("|")) node = { type: "pipe", left: node, right: this.parseComma() };
    return node;
  }

  parseComma() {
    let node = this.parseAlt();
    while (!this.starts("]") && !this.starts("}") && !this.starts(")") && this.eat(",")) {
      node = { type: "comma", left: node, right: this.parseAlt() };
    }
    return node;
  }

  parseAlt() {
    let node = this.parseOr();
    while (this.eat("//")) node = { type: "alt", left: node, right: this.parseOr() };
    return node;
  }

  parseOr() {
    let node = this.parseAnd();
    while (this.eat("or")) node = { type: "or", left: node, right: this.parseAnd() };
    return node;
  }

  parseAnd() {
    let node = this.parseCmp();
    while (this.eat("and")) node = { type: "and", left: node, right: this.parseCmp() };
    return node;
  }

  parseCmp() {
    let node = this.parseAdd();
    const op = this.readCmpOp();
    if (!op) return node;
    return { type: "cmp", op, left: node, right: this.parseAdd() };
  }

  readCmpOp() {
    if (this.eat("==")) return "==";
    if (this.eat("!=")) return "!=";
    if (this.eat("<=")) return "<=";
    if (this.eat(">=")) return ">=";
    if (this.eat("<")) return "<";
    if (this.eat(">")) return ">";
    return null;
  }

  parseAdd() {
    let node = this.parseMul();
    while (true) {
      if (this.eat("+")) node = { type: "arith", op: "+", left: node, right: this.parseMul() };
      else if (this.eat("-")) node = { type: "arith", op: "-", left: node, right: this.parseMul() };
      else break;
    }
    return node;
  }

  parseMul() {
    let node = this.parseUnary();
    while (true) {
      if (this.starts("//")) break;
      if (this.eat("*")) node = { type: "arith", op: "*", left: node, right: this.parseUnary() };
      else if (this.eat("/")) node = { type: "arith", op: "/", left: node, right: this.parseUnary() };
      else if (this.eat("%")) node = { type: "arith", op: "%", left: node, right: this.parseUnary() };
      else break;
    }
    return node;
  }

  parseUnary() {
    if (this.eat("-")) return { type: "neg", input: this.parseUnary() };
    return this.parsePostfix();
  }

  parsePostfix() {
    let node = this.parsePrimary();
    while (true) {
      if (this.eat("?")) {
        node = { type: "optional", input: node };
        continue;
      }
      if (this.eat(".")) {
        node = this.parseDotAccess(node);
        continue;
      }
      if (this.peek() === "[") {
        node = this.parseBracket(node);
        continue;
      }
      break;
    }
    return node;
  }

  parsePrimary() {
    if (this.eat("..")) return { type: "recurse" };

    if (this.eat(".")) {
      if (this.peek() === "[" || /[A-Za-z_]/.test(this.peek() ?? "")) return this.parseDotAccess({ type: "identity" });
      return { type: "identity" };
    }

    if (this.eat("(")) {
      const inner = this.parsePipe();
      this.expect(")");
      return inner;
    }

    if (this.eat("[")) {
      if (this.eat("]")) return { type: "collect", expr: null };
      const expr = this.parsePipe();
      this.expect("]");
      return { type: "collect", expr };
    }

    if (this.eat("{")) return this.parseObject();

    if (this.eat("if")) return this.parseIf();

    const str = this.readString();
    if (str !== null) return { type: "literal", value: str };

    const num = this.readNumber();
    if (num !== null) return { type: "literal", value: num };

    if (this.eat("true")) return { type: "literal", value: true };
    if (this.eat("false")) return { type: "literal", value: false };
    if (this.eat("null")) return { type: "literal", value: null };

    const name = this.readIdent();
    if (name) {
      if (this.eat("(")) {
        const args = this.parseArgs();
        return { type: "call", name, args };
      }
      return { type: "call", name, args: [] };
    }

    this.fail(`unexpected ${this.preview()}`);
  }

  parseDotAccess(input) {
    if (this.peek() === "[") return this.parseBracket(input);
    const name = this.readIdent();
    if (!name) this.fail(`expected field name, got ${this.preview()}`);
    return { type: "field", input, name };
  }

  parseBracket(input) {
    this.expect("[");
    if (this.eat("]")) return { type: "iterate", input };

    let start = null;
    let end = null;
    let isSlice = false;

    if (this.eat(":")) {
      isSlice = true;
      if (this.peek() !== "]") end = this.parsePipe();
    } else {
      start = this.parsePipe();
      if (this.eat(":")) {
        isSlice = true;
        if (this.peek() !== "]") end = this.parsePipe();
      }
    }

    this.expect("]");
    if (isSlice) return { type: "slice", input, start, end };
    return { type: "index", input, index: start };
  }

  parseObject() {
    const entries = [];
    if (this.eat("}")) return { type: "object", entries };

    while (true) {
      let key;
      let value;
      if (this.eat("(")) {
        key = this.parsePipe();
        this.expect(")");
        this.expect(":");
        value = this.parseAlt();
      } else {
        const str = this.readString();
        const ident = str === null ? this.readIdent() : null;
        if (str === null && !ident) this.fail(`expected object key, got ${this.preview()}`);
        if (this.eat(":")) {
          key = { type: "literal", value: str ?? ident };
          value = this.parseAlt();
        } else {
          const name = str ?? ident;
          key = { type: "literal", value: name };
          value = { type: "field", input: { type: "identity" }, name };
        }
      }
      entries.push({ key, value });
      if (this.eat("}")) break;
      this.expect(",");
      if (this.eat("}")) break;
    }

    return { type: "object", entries };
  }

  parseIf() {
    const cond = this.parsePipe();
    this.expect("then");
    const then = this.parsePipe();
    const elifs = [];
    while (this.eat("elif")) {
      const c = this.parsePipe();
      this.expect("then");
      elifs.push({ cond: c, then: this.parsePipe() });
    }
    let els = null;
    if (this.eat("else")) els = this.parsePipe();
    this.expect("end");
    return { type: "if", cond, then, elifs, els };
  }

  parseArgs() {
    if (this.eat(")")) return [];
    const args = [this.parsePipe()];
    while (this.eat(";")) args.push(this.parsePipe());
    this.expect(")");
    return args;
  }

  readIdent() {
    this.skip();
    const start = this.i;
    if (!/[A-Za-z_]/.test(this.s[this.i] ?? "")) return null;
    this.i += 1;
    while (/[A-Za-z0-9_]/.test(this.s[this.i] ?? "")) this.i += 1;
    return this.s.slice(start, this.i);
  }

  readNumber() {
    this.skip();
    const start = this.i;
    if (this.s[this.i] === "-") {
      const next = this.s[this.i + 1];
      if (!(next >= "0" && next <= "9")) return null;
      this.i += 1;
    }
    if (!/[0-9]/.test(this.s[this.i] ?? "")) {
      this.i = start;
      return null;
    }
    while (/[0-9]/.test(this.s[this.i] ?? "")) this.i += 1;
    if (this.s[this.i] === ".") {
      this.i += 1;
      while (/[0-9]/.test(this.s[this.i] ?? "")) this.i += 1;
    }
    if (this.s[this.i] === "e" || this.s[this.i] === "E") {
      this.i += 1;
      if (this.s[this.i] === "+" || this.s[this.i] === "-") this.i += 1;
      while (/[0-9]/.test(this.s[this.i] ?? "")) this.i += 1;
    }
    return Number(this.s.slice(start, this.i));
  }

  readString() {
    this.skip();
    if (this.s[this.i] !== '"') return null;
    this.i += 1;
    let out = "";
    while (this.i < this.n) {
      const c = this.s[this.i];
      if (c === '"') {
        this.i += 1;
        return out;
      }
      if (c === "\\") {
        this.i += 1;
        const e = this.s[this.i];
        this.i += 1;
        const table = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
        out += table[e] ?? e;
        continue;
      }
      out += c;
      this.i += 1;
    }
    this.fail("unterminated string");
  }
}

function evalNode(node, input) {
  switch (node.type) {
    case "pipe": {
      const left = evalNode(node.left, input);
      const out = [];
      for (const v of left) out.push(...evalNode(node.right, v));
      return out;
    }
    case "comma":
      return [...evalNode(node.left, input), ...evalNode(node.right, input)];
    case "alt": {
      const left = evalNode(node.left, input).filter((v) => v !== false && v !== null);
      return left.length ? left : evalNode(node.right, input);
    }
    case "or": {
      const left = first(evalNode(node.left, input));
      return truthy(left) ? [left] : evalNode(node.right, input);
    }
    case "and": {
      const left = first(evalNode(node.left, input));
      return truthy(left) ? evalNode(node.right, input) : [left];
    }
    case "cmp":
      return [compare(node.op, first(evalNode(node.left, input)), first(evalNode(node.right, input)))];
    case "arith":
      return [arith(node.op, first(evalNode(node.left, input)), first(evalNode(node.right, input)))];
    case "neg": {
      const v = first(evalNode(node.input, input));
      if (typeof v !== "number") fail(`cannot negate ${typeName(v)}`);
      return [-v];
    }
    case "identity":
      return [input];
    case "literal":
      return [node.value];
    case "field":
      return evalField(node, input);
    case "index":
      return evalIndex(node, input);
    case "iterate":
      return evalIterate(node, input);
    case "slice":
      return evalSlice(node, input);
    case "optional":
      try {
        return evalNode(node.input, input);
      } catch {
        return [];
      }
    case "recurse":
      return recurse(input);
    case "collect":
      return [node.expr ? evalNode(node.expr, input) : []];
    case "object":
      return evalObject(node, input);
    case "if":
      return evalIf(node, input);
    case "call":
      return evalCall(node, input);
    default:
      fail(`internal: unknown node ${node.type}`);
  }
}

function evalField(node, input) {
  const bases = evalNode(node.input, input);
  const out = [];
  for (const base of bases) {
    if (base === null || base === undefined) {
      out.push(null);
      continue;
    }
    if (Array.isArray(base) && /^\d+$/.test(node.name)) {
      out.push(indexArray(base, Number(node.name)));
      continue;
    }
    if (!isObject(base)) fail(`cannot index ${typeName(base)} with string "${node.name}"`);
    out.push(Object.prototype.hasOwnProperty.call(base, node.name) ? base[node.name] : null);
  }
  return out;
}

function evalIndex(node, input) {
  const bases = evalNode(node.input, input);
  const out = [];
  for (const base of bases) {
    const keys = evalNode(node.index, input);
    for (const key of keys) {
      if (Array.isArray(base) || typeof base === "string") {
        if (typeof key !== "number") fail(`cannot index ${typeName(base)} with ${typeName(key)}`);
        out.push(indexArray(base, key));
      } else if (isObject(base)) {
        const k = String(key);
        out.push(Object.prototype.hasOwnProperty.call(base, k) ? base[k] : null);
      } else if (base === null) {
        out.push(null);
      } else {
        fail(`cannot index ${typeName(base)}`);
      }
    }
  }
  return out;
}

function evalIterate(node, input) {
  const bases = evalNode(node.input, input);
  const out = [];
  for (const base of bases) {
    if (Array.isArray(base)) out.push(...base);
    else if (isObject(base)) out.push(...Object.values(base));
    else if (base === null) fail("cannot iterate over null");
    else fail(`cannot iterate over ${typeName(base)}`);
  }
  return out;
}

function evalSlice(node, input) {
  const bases = evalNode(node.input, input);
  const out = [];
  for (const base of bases) {
    if (!Array.isArray(base) && typeof base !== "string") fail(`cannot slice ${typeName(base)}`);
    const n = base.length;
    const start = node.start ? Number(first(evalNode(node.start, input))) : 0;
    const end = node.end ? Number(first(evalNode(node.end, input))) : n;
    const a = start < 0 ? Math.max(0, n + start) : Math.min(n, start);
    const b = end < 0 ? Math.max(0, n + end) : Math.min(n, end);
    out.push(base.slice(a, Math.max(a, b)));
  }
  return out;
}

function evalObject(node, input) {
  const obj = {};
  for (const entry of node.entries) {
    const keys = evalNode(entry.key, input);
    const values = evalNode(entry.value, input);
    const key = keys.length ? keys[0] : null;
    obj[String(key)] = values.length ? values[0] : null;
  }
  return [obj];
}

function evalIf(node, input) {
  if (truthy(first(evalNode(node.cond, input)))) return evalNode(node.then, input);
  for (const branch of node.elifs) {
    if (truthy(first(evalNode(branch.cond, input)))) return evalNode(branch.then, input);
  }
  return node.els ? evalNode(node.els, input) : [];
}

function evalCall(node, input) {
  const fn = FUNS[node.name];
  if (!fn) fail(`unknown filter ${node.name}`);
  return fn(input, node.args);
}

const FUNS = {
  length(input) {
    if (input === null) return [0];
    if (typeof input === "string" || Array.isArray(input)) return [input.length];
    if (isObject(input)) return [Object.keys(input).length];
    fail(`length cannot be applied to ${typeName(input)}`);
  },
  keys(input) {
    if (Array.isArray(input)) return [input.map((_, i) => i)];
    if (isObject(input)) return [Object.keys(input).sort()];
    fail(`keys cannot be applied to ${typeName(input)}`);
  },
  keys_unsorted(input) {
    if (Array.isArray(input)) return [input.map((_, i) => i)];
    if (isObject(input)) return [Object.keys(input)];
    fail(`keys_unsorted cannot be applied to ${typeName(input)}`);
  },
  type(input) {
    return [typeName(input)];
  },
  empty() {
    return [];
  },
  not(input) {
    return [!truthy(input)];
  },
  first(input, args) {
    if (args[0]) {
      const vals = evalNode(args[0], input);
      return vals.length ? [vals[0]] : [];
    }
    if (Array.isArray(input)) return input.length ? [input[0]] : [];
    return [input];
  },
  last(input) {
    if (Array.isArray(input)) return input.length ? [input[input.length - 1]] : [];
    return [input];
  },
  reverse(input) {
    if (typeof input === "string") return [[...input].reverse().join("")];
    if (!Array.isArray(input)) fail(`reverse cannot be applied to ${typeName(input)}`);
    return [[...input].reverse()];
  },
  sort(input) {
    if (!Array.isArray(input)) fail(`sort cannot be applied to ${typeName(input)}`);
    return [[...input].sort(cmpValues)];
  },
  sort_by(input, args) {
    if (!Array.isArray(input)) fail(`sort_by cannot be applied to ${typeName(input)}`);
    if (!args[0]) fail("sort_by needs a filter");
    return [
      [...input].sort((a, b) => cmpValues(first(evalNode(args[0], a)), first(evalNode(args[0], b)))),
    ];
  },
  unique(input) {
    if (!Array.isArray(input)) fail(`unique cannot be applied to ${typeName(input)}`);
    const seen = [];
    for (const v of [...input].sort(cmpValues)) {
      if (!seen.length || !jsonEq(seen[seen.length - 1], v)) seen.push(v);
    }
    return [seen];
  },
  unique_by(input, args) {
    if (!Array.isArray(input)) fail(`unique_by cannot be applied to ${typeName(input)}`);
    if (!args[0]) fail("unique_by needs a filter");
    const seen = [];
    const keys = [];
    for (const v of input) {
      const k = first(evalNode(args[0], v));
      if (!keys.some((x) => jsonEq(x, k))) {
        keys.push(k);
        seen.push(v);
      }
    }
    return [seen];
  },
  add(input) {
    if (typeof input === "string") return [input];
    if (!Array.isArray(input)) fail(`add cannot be applied to ${typeName(input)}`);
    if (!input.length) return [null];
    let acc = input[0];
    for (let i = 1; i < input.length; i += 1) acc = arith("+", acc, input[i]);
    return [acc];
  },
  flatten(input, args) {
    const depth = args[0] ? Number(first(evalNode(args[0], input))) : 1;
    return [flattenTo(input, depth)];
  },
  min(input) {
    if (!Array.isArray(input) || !input.length) return [];
    return [[...input].sort(cmpValues)[0]];
  },
  max(input) {
    if (!Array.isArray(input) || !input.length) return [];
    return [[...input].sort(cmpValues).at(-1)];
  },
  min_by(input, args) {
    if (!Array.isArray(input) || !input.length) return [];
    if (!args[0]) fail("min_by needs a filter");
    return [
      [...input].sort((a, b) => cmpValues(first(evalNode(args[0], a)), first(evalNode(args[0], b))))[0],
    ];
  },
  max_by(input, args) {
    if (!Array.isArray(input) || !input.length) return [];
    if (!args[0]) fail("max_by needs a filter");
    return [
      [...input].sort((a, b) => cmpValues(first(evalNode(args[0], a)), first(evalNode(args[0], b)))).at(
        -1,
      ),
    ];
  },
  select(input, args) {
    if (!args[0]) fail("select needs a filter");
    const vals = evalNode(args[0], input);
    return vals.some(truthy) ? [input] : [];
  },
  map(input, args) {
    if (!args[0]) fail("map needs a filter");
    const items = iterate(input, "map");
    const out = [];
    for (const item of items) out.push(...evalNode(args[0], item));
    return [out];
  },
  map_values(input, args) {
    if (!args[0]) fail("map_values needs a filter");
    if (Array.isArray(input)) {
      return [input.map((item) => first(evalNode(args[0], item)))];
    }
    if (!isObject(input)) fail(`map_values cannot be applied to ${typeName(input)}`);
    const out = {};
    for (const [k, v] of Object.entries(input)) out[k] = first(evalNode(args[0], v));
    return [out];
  },
  has(input, args) {
    if (!args[0]) fail("has needs a key");
    const key = first(evalNode(args[0], input));
    if (Array.isArray(input)) return [typeof key === "number" && key >= 0 && key < input.length];
    if (isObject(input)) return [Object.prototype.hasOwnProperty.call(input, String(key))];
    return [false];
  },
  contains(input, args) {
    if (!args[0]) fail("contains needs an argument");
    const needle = first(evalNode(args[0], input));
    if (typeof input === "string") return [input.includes(String(needle))];
    if (Array.isArray(input)) return [input.some((v) => jsonEq(v, needle))];
    if (isObject(input) && isObject(needle)) {
      return [Object.keys(needle).every((k) => jsonEq(input[k], needle[k]))];
    }
    return [jsonEq(input, needle)];
  },
  startswith(input, args) {
    if (typeof input !== "string") fail("startswith requires a string");
    return [input.startsWith(String(first(evalNode(args[0], input))))];
  },
  endswith(input, args) {
    if (typeof input !== "string") fail("endswith requires a string");
    return [input.endsWith(String(first(evalNode(args[0], input))))];
  },
  split(input, args) {
    if (typeof input !== "string") fail("split requires a string");
    const sep = args[0] ? String(first(evalNode(args[0], input))) : "";
    return [sep === "" ? [...input] : input.split(sep)];
  },
  join(input, args) {
    if (!Array.isArray(input)) fail("join requires an array");
    const sep = args[0] ? String(first(evalNode(args[0], input))) : "";
    return [input.map((v) => (v == null ? "" : String(v))).join(sep)];
  },
  tostring(input) {
    if (typeof input === "string") return [input];
    return [JSON.stringify(input)];
  },
  tonumber(input) {
    if (typeof input === "number") return [input];
    const n = Number(input);
    if (Number.isNaN(n)) fail(`cannot convert ${JSON.stringify(input)} to number`);
    return [n];
  },
  tojson(input) {
    return [JSON.stringify(input)];
  },
  fromjson(input) {
    if (typeof input !== "string") fail("fromjson requires a string");
    try {
      return [JSON.parse(input)];
    } catch (err) {
      fail(err.message);
    }
  },
  to_entries(input) {
    if (Array.isArray(input)) return [input.map((value, key) => ({ key, value }))];
    if (isObject(input)) return [Object.entries(input).map(([key, value]) => ({ key, value }))];
    fail(`to_entries cannot be applied to ${typeName(input)}`);
  },
  from_entries(input) {
    if (!Array.isArray(input)) fail("from_entries requires an array");
    const out = {};
    for (const item of input) {
      if (!isObject(item)) continue;
      out[String(item.key)] = item.value;
    }
    return [out];
  },
  with_entries(input, args) {
    if (!args[0]) fail("with_entries needs a filter");
    const entries = FUNS.to_entries(input, [])[0];
    const mapped = [];
    for (const e of entries) mapped.push(...evalNode(args[0], e));
    return FUNS.from_entries(mapped, []);
  },
  any(input, args) {
    const items = args[0] ? evalNode(args[0], input) : iterate(input, "any");
    return [items.some(truthy)];
  },
  all(input, args) {
    const items = args[0] ? evalNode(args[0], input) : iterate(input, "all");
    return [items.every(truthy)];
  },
  paths(input) {
    const out = [];
    walkPaths(input, [], out);
    return out;
  },
};

function iterate(input, name) {
  if (Array.isArray(input)) return input;
  if (isObject(input)) return Object.values(input);
  fail(`${name} cannot be applied to ${typeName(input)}`);
}

function flattenTo(value, depth) {
  if (depth === 0 || !Array.isArray(value)) return value;
  const out = [];
  for (const item of value) {
    if (Array.isArray(item) && depth !== 0) out.push(...flattenTo(item, depth - 1));
    else out.push(item);
  }
  return out;
}

function walkPaths(value, path, out) {
  if (Array.isArray(value)) {
    value.forEach((item, i) => {
      const next = [...path, i];
      out.push(next);
      walkPaths(item, next, out);
    });
  } else if (isObject(value)) {
    for (const [k, v] of Object.entries(value)) {
      const next = [...path, k];
      out.push(next);
      walkPaths(v, next, out);
    }
  }
}

function recurse(value) {
  const out = [value];
  if (Array.isArray(value)) {
    for (const item of value) out.push(...recurse(item));
  } else if (isObject(value)) {
    for (const item of Object.values(value)) out.push(...recurse(item));
  }
  return out;
}

function indexArray(base, key) {
  const i = key < 0 ? base.length + key : key;
  if (i < 0 || i >= base.length) return null;
  return base[i];
}

function first(stream) {
  return stream.length ? stream[0] : null;
}

function truthy(v) {
  return v !== false && v !== null && v !== undefined;
}

function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function typeName(v) {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function fail(msg) {
  throw new Error(`jq: ${msg}`);
}

function jsonEq(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => jsonEq(v, b[i]));
  }
  if (isObject(a) && isObject(b)) {
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    return ak.every((k) => Object.prototype.hasOwnProperty.call(b, k) && jsonEq(a[k], b[k]));
  }
  return false;
}

function cmpValues(a, b) {
  if (jsonEq(a, b)) return 0;
  const ta = typeName(a);
  const tb = typeName(b);
  if (ta !== tb) return ta < tb ? -1 : 1;
  if (typeof a === "number" || typeof a === "string" || typeof a === "boolean") {
    return a < b ? -1 : a > b ? 1 : 0;
  }
  return JSON.stringify(a) < JSON.stringify(b) ? -1 : 1;
}

function compare(op, a, b) {
  switch (op) {
    case "==":
      return jsonEq(a, b);
    case "!=":
      return !jsonEq(a, b);
    case "<":
      return cmpValues(a, b) < 0;
    case "<=":
      return cmpValues(a, b) <= 0;
    case ">":
      return cmpValues(a, b) > 0;
    case ">=":
      return cmpValues(a, b) >= 0;
    default:
      return false;
  }
}

function arith(op, a, b) {
  if (op === "+" && typeof a === "string" && typeof b === "string") return a + b;
  if (op === "+" && Array.isArray(a) && Array.isArray(b)) return [...a, ...b];
  if (op === "+" && isObject(a) && isObject(b)) return { ...a, ...b };
  if (op === "-" && Array.isArray(a) && Array.isArray(b)) {
    return a.filter((v) => !b.some((x) => jsonEq(x, v)));
  }
  if (typeof a !== "number" || typeof b !== "number") {
    fail(`cannot ${op} ${typeName(a)} and ${typeName(b)}`);
  }
  switch (op) {
    case "+":
      return a + b;
    case "-":
      return a - b;
    case "*":
      return a * b;
    case "/":
      return a / b;
    case "%":
      return a % b;
    default:
      fail(`unknown operator ${op}`);
  }
}
