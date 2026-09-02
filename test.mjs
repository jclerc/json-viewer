import { readFileSync } from "node:fs";
import { parse, countValues } from "./parser.js";

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
  eq(n.items.length, 2, "two values");
  eq(n.items[0].value, true, "true");
  eq(n.items[1].value, false, "false");
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
  eq(n.truncated, true, "example truncated");
  eq(n.items[0].truncated, false, "first object complete");
  eq(n.items[1].truncated, true, "second object incomplete");

  const details = n.items[0].entries.find((e) => e.key === "details");
  eq(details.value.type, "string", "details is string");
  eq(details.value.nested?.type, "array", "details nested array");
  eq(details.value.nested.items[0].type, "object", "nested error object");
}

console.log("ok");
