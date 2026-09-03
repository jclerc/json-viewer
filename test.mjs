import { readFileSync } from "node:fs";
import { parse, countValues, astToValues } from "./parser.js";
import { applyJq, parseJq } from "./jq.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function eq(a, b, msg) {
  const left = JSON.stringify(a);
  const right = JSON.stringify(b);
  if (left !== right) throw new Error(`${msg}\n  got  ${left}\n  want ${right}`);
}

{
  const n = parse('{"a": [2');
  eq(n.type, "object", "incomplete object type");
  eq(n.truncated, true, "incomplete object truncated");
  eq(n.entries[0].key, "a", "key a");
  eq(n.entries[0].value.type, "array", "value is array");
  eq(n.entries[0].value.items[0].value, 2, "array holds 2");
  eq(n.entries[0].value.truncated, true, "array truncated");
}

{
  const n = parse('{"this-is-json": "{\\"a\\": 3}"}');
  const nested = n.entries[0].value.nested;
  eq(nested?.type, "object", "nested object");
  eq(nested.entries[0].key, "a", "nested key");
  eq(nested.entries[0].value.value, 3, "nested value");
}

{
  const n = parse('{"this-is-json": "{\\"a\\": 3}"}', { nest: false });
  eq(n.entries[0].value.nested, undefined, "nest disabled");
}

{
  const n = parse("// hi\ntrue\n/* c */\nfalse\n");
  eq(n.type, "doc", "jsonl doc");
  eq(n.items[0].type, "comment", "leading comment");
  eq(n.items[0].text, "hi", "comment text");
  const values = n.items.filter((x) => x.type !== "comment");
  eq(values.length, 2, "two values");
  eq(values[0].value, true, "true");
  eq(values[1].value, false, "false");
}

{
  const n = parse('{"a": 1,}');
  eq(n.entries.length, 1, "trailing comma");
  eq(n.truncated, false, "trailing comma not truncated");
}

{
  const n = parse('"text is \\"hello\\""');
  eq(n.value, 'text is "hello"', "unescaped string");
}

{
  const n = parse('{"dd": {"sp');
  eq(n.entries[0].key, "dd", "outer key");
  eq(n.entries[0].value.type, "object", "inner object");
  eq(n.entries[0].value.entries[0].key, "sp", "truncated key");
  eq(n.entries[0].value.entries[0].keyTruncated, true, "key truncated flag");
  eq(n.truncated, true, "outer truncated");
}

{
  const n = parse('{"dd": {"sp\n');
  eq(n.entries[0].value.entries[0].key, "sp", "truncated key ignores newline");
}

{
  const text = readFileSync(new URL("./example.json", import.meta.url), "utf8");
  const n = parse(text);
  eq(n.type, "doc", "example is jsonl");
  eq(countValues(n), 2, "two objects");
  const objs = n.items.filter((x) => x.type === "object");
  eq(objs.length, 2, "two objects");
  eq(n.items[0].type, "comment", "example leading comment");
  eq(n.truncated, false, "example complete");
  eq(objs[0].truncated, false, "first object complete");
  eq(objs[1].truncated, false, "second object complete");

  const nested = objs[0].entries.find((e) => e.key === "nested");
  eq(nested.value.type, "string", "nested is string");
  eq(nested.value.nested?.type, "object", "nested object");
  eq(nested.value.nested.entries[0].key, "ok", "nested key");
}

{
  const values = astToValues(parse('{"a": 1}\n{"a": 2}'));
  eq(values, [{ a: 1 }, { a: 2 }], "jsonl to values");
}

function jq(data, filter) {
  const result = applyJq([data], filter);
  if (!result.ok) throw new Error(`${filter}\n  ${result.error}`);
  return result.values;
}

{
  parseJq(".foo.bar");
  parseJq(".[] | select(.n == 2)");
  parseJq("{k: .a, b}");
  eq(jq({ a: { b: 3 } }, ".a.b"), [3], ".a.b");
  eq(jq({ a: { b: 3 } }, ".a | .b"), [3], "pipe");
  eq(jq({ list: [1, 2, 3] }, ".list[1]"), [2], "index");
  eq(jq({ list: [1, 2, 3] }, ".list[-1]"), [3], "neg index");
  eq(jq({ list: [1, 2, 3] }, ".list[]"), [1, 2, 3], "iterate");
  eq(jq({ list: [1, 2, 3] }, ".list[0:2]"), [[1, 2]], "slice");
  eq(jq([{ n: 1 }, { n: 2 }, { n: 3 }], ".[] | select(.n >= 2)"), [{ n: 2 }, { n: 3 }], "select");
  eq(jq({ a: 1, b: 2 }, "keys"), [["a", "b"]], "keys");
  eq(jq([10, 20], "length"), [2], "length");
  eq(jq({ a: 1, b: 2 }, "map_values(. + 1)"), [{ a: 2, b: 3 }], "map_values");
  eq(jq([{ id: 1 }, { id: 2 }], "map(.id)"), [[1, 2]], "map");
  eq(jq("{\"n\":1}", "fromjson"), [{ n: 1 }], "fromjson");
  eq(jq({ n: 1 }, ".m // 5"), [5], "alt");
  eq(jq({ a: 1, b: 2 }, "{a, c: .b}"), [{ a: 1, c: 2 }], "object ctor");
  eq(jq({ a: 1 }, "if .a == 1 then \"yes\" else \"no\" end"), ["yes"], "if");
  eq(jq([1, 2, 3], "add"), [6], "add");
  eq(jq({ missing: 1 }, ".nope?"), [null], "optional field is null");
  eq(jq(null, ".[]?"), [], "optional iterate");
  eq(jq({ a: "x", b: "y" }, ".a, .b"), ["x", "y"], "comma");
  eq(jq("hello", "startswith(\"he\")"), [true], "startswith");
  const bad = applyJq([{ a: 1 }], ".[");
  eq(bad.ok, false, "bad filter");
}

{
  const values = astToValues(parse(readFileSync(new URL("./example.json", import.meta.url), "utf8")));
  const jsonl = applyJq(values, ".n");
  eq(jsonl.ok, true, "jq jsonl ok");
  eq(jsonl.values[1], 2, "jq over jsonl .n");
}

console.log("ok");
