import { parse, countValues, isEmptyAst } from "./parser.js";

const LS_TEXT = "json-viewer.text";
const LS_THEME = "json-viewer.theme";
const LS_NEST = "json-viewer.nest";
const THEMES = ["light", "blue", "dark"];

const source = document.querySelector("#source");
const viewer = document.querySelector("#viewer");
const statusEl = document.querySelector("#status");
const fileInput = document.querySelector("#file");
const shareDialog = document.querySelector("#share-dialog");
const shareUrl = document.querySelector("#share-url");
const shareWarn = document.querySelector("#share-warn");
const copyBtn = document.querySelector("#copy-btn");
const selTip = document.querySelector("#sel-tip");
const expandBtn = document.querySelector("#expand-btn");
const collapseBtn = document.querySelector("#collapse-btn");
const shareBtn = document.querySelector("#share-btn");
const nestToggle = document.querySelector("#nest-toggle");
const themeBtns = [...document.querySelectorAll(".theme-row [data-theme]")];

const ctx = { line: 0 };
let lineSel = null;
let lastClicked = null;
let pendingSel = null;
let lastTipSpec = null;

init();

function init() {
  applyTheme(readTheme());
  nestToggle.checked = localStorage.getItem(LS_NEST) !== "0";

  const fromHash = readHash(location.hash);
  if (fromHash?.text) {
    source.value = fromHash.text;
    localStorage.setItem(LS_TEXT, fromHash.text);
    pendingSel = fromHash.sel;
  } else {
    const saved = localStorage.getItem(LS_TEXT);
    if (saved) source.value = saved;
  }

  render();

  source.addEventListener("input", onSourceInput);
  document.querySelector("#upload-btn").addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", onFile);
  document.querySelector("#clear-btn").addEventListener("click", clearAll);
  expandBtn.addEventListener("click", () => setAllCollapsed(false));
  collapseBtn.addEventListener("click", () => setAllCollapsed(true));
  shareBtn.addEventListener("click", () => openShare(currentLineSpec()));
  document.querySelector("#sel-share-btn").addEventListener("click", () => {
    hideTip();
    openShare(lastTipSpec);
  });
  copyBtn.addEventListener("click", copyShare);
  nestToggle.addEventListener("change", onNestToggle);
  themeBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      localStorage.setItem(LS_THEME, btn.dataset.theme);
      applyTheme(btn.dataset.theme);
    });
  });
  viewer.addEventListener("mousedown", onViewerMouseDown);
  viewer.addEventListener("click", onViewerClick);
  viewer.addEventListener("scroll", hideTip);
  document.addEventListener("selectionchange", onSelChange);
  window.addEventListener("hashchange", onHashChange);
  shareUrl.addEventListener("focus", () => shareUrl.select());
}

function onNestToggle() {
  localStorage.setItem(LS_NEST, nestToggle.checked ? "1" : "0");
  lineSel = null;
  lastClicked = null;
  pendingSel = null;
  render();
}

function onSourceInput() {
  localStorage.setItem(LS_TEXT, source.value);
  lineSel = null;
  lastClicked = null;
  pendingSel = null;
  render();
}

async function onFile() {
  const file = fileInput.files?.[0];
  fileInput.value = "";
  if (!file) return;
  source.value = await file.text();
  onSourceInput();
}

function clearAll() {
  source.value = "";
  localStorage.removeItem(LS_TEXT);
  lineSel = null;
  lastClicked = null;
  pendingSel = null;
  history.replaceState(null, "", location.pathname + location.search);
  render();
}

function onHashChange() {
  const fromHash = readHash(location.hash);
  if (!fromHash) return;
  if (fromHash.text !== source.value) {
    source.value = fromHash.text;
    localStorage.setItem(LS_TEXT, fromHash.text);
    pendingSel = fromHash.sel;
    render();
    return;
  }
  if (fromHash.sel) applySelection(fromHash.sel);
}

function render() {
  hideTip();
  ctx.line = 0;
  const text = source.value;
  const ast = text.trim() ? parse(text, { nest: nestToggle.checked }) : null;
  const has = ast && !isEmptyAst(ast);

  expandBtn.disabled = !has;
  collapseBtn.disabled = !has;
  shareBtn.disabled = !has;

  if (!text.trim()) {
    statusEl.hidden = true;
    viewer.replaceChildren(el("p", { class: "empty" }, "Paste JSON on the left to view it here."));
    return;
  }

  if (!has) {
    statusEl.hidden = false;
    statusEl.className = "status is-trunc";
    statusEl.textContent = "Nothing could be parsed.";
    viewer.replaceChildren(el("p", { class: "empty" }, "Nothing could be parsed."));
    return;
  }

  const n = countValues(ast);
  const trunc = Boolean(ast.truncated);
  statusEl.hidden = false;
  statusEl.className = trunc ? "status is-trunc" : "status";
  statusEl.textContent = `${n} value${n === 1 ? "" : "s"}${trunc ? " · incomplete" : ""}`;

  const root = document.createDocumentFragment();
  renderValue(ast, 0, [], root, false);
  viewer.replaceChildren(root);

  if (pendingSel) {
    const sel = pendingSel;
    pendingSel = null;
    requestAnimationFrame(() => applySelection(sel));
  } else if (lineSel) {
    paintLineSel();
  }
}

function renderValue(node, depth, prefix, parent, comma) {
  if (node.type === "doc") {
    for (const item of node.items) {
      renderValue(item, depth, [], parent, false);
    }
    if (node.truncated && !node.items.some((n) => n.truncated)) {
      appendTruncOnLast(parent);
    }
    return;
  }

  if (node.type === "string" && node.nested) {
    renderValue(node.nested, depth, prefix, parent, comma);
    return;
  }

  if (node.type === "object" || node.type === "array") {
    renderCompound(node, depth, prefix, parent, comma);
    return;
  }

  const row = newLine(depth, parent);
  row.content.append(...prefix, ...primitive(node));
  if (comma) row.content.append(tok("p", ","));
  if (node.truncated || node.type === "missing") row.content.append(truncMark());
}

function renderCompound(node, depth, prefix, parent, comma) {
  const isObj = node.type === "object";
  const kids = isObj ? node.entries : node.items;
  const open = isObj ? "{" : "[";
  const close = isObj ? "}" : "]";

  if (kids.length === 0 && !node.truncated) {
    const row = newLine(depth, parent);
    row.content.append(...prefix, tok("p", open + close));
    if (comma) row.content.append(tok("p", ","));
    return;
  }

  const block = el("div", { class: "block" });
  const opener = newLine(depth, block);
  const fold = foldButton();
  opener.foldSlot.append(fold);
  opener.content.append(...prefix, tok("p", open));
  const preview = el("span", { class: "preview" });
  preview.append(el("span", { class: "ellipsis" }, `…${kids.length}`), tok("p", close + (comma ? "," : "")));
  opener.content.append(preview);

  const children = el("div", { class: "children" });

  kids.forEach((kid, i) => {
    const last = i === kids.length - 1;
    const needComma = !last;
    if (isObj) renderEntry(kid, depth + 1, children, needComma);
    else renderValue(kid, depth + 1, [], children, needComma);
  });

  if (node.truncated && !children.querySelector(".trunc") && !opener.content.querySelector(".trunc")) {
    const target =
      kids.length === 0
        ? opener.content
        : [...children.querySelectorAll(".line .content")].at(-1) || opener.content;
    if (target) target.append(truncMark());
  }

  const closer = newLine(depth, children);
  closer.content.append(tok("p", close));
  if (comma) closer.content.append(tok("p", ","));

  block.append(children);
  parent.append(block);

  fold.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleBlock(block);
  });
}

function renderEntry(entry, depth, parent, comma) {
  const nested = Boolean(entry.value?.nested);
  const prefix = keyPrefix(entry.key, nested);

  if (entry.keyTruncated) {
    const row = newLine(depth, parent);
    row.content.append(...prefix, truncMark());
    return;
  }

  renderValue(entry.value, depth, prefix, parent, comma);
}

function primitive(node) {
  switch (node.type) {
    case "string":
      return quoted("s", node.value);
    case "number":
      return [tok("n", node.raw ?? String(node.value))];
    case "boolean":
      return [tok("b", String(node.value))];
    case "null":
      return [tok("u", "null")];
    case "missing":
      return [];
    default:
      return [tok("u", "")];
  }
}

function quoted(kind, text) {
  return [tok("qt", '"'), tok(kind, text), tok("qt", '"')];
}

function keyPrefix(key, nested) {
  if (nested) {
    const wrap = el("span", {
      class: "nested-key",
      title: "Parsed from a JSON string",
    });
    wrap.append(tok("qt", '"'), tok("k", key), tok("qt", '"'));
    return [wrap, tok("p", ": ")];
  }
  return [...quoted("k", key), tok("p", ": ")];
}

function newLine(depth, parent) {
  ctx.line += 1;
  const n = ctx.line;
  const line = el("div", { class: "line", "data-line": String(n) });
  const gutter = el("button", {
    type: "button",
    class: "gutter",
    "data-line": String(n),
    "aria-label": `Select line ${n}`,
  });
  gutter.textContent = String(n);
  const foldSlot = el("span", { class: "fold-slot" });
  const content = el("span", { class: "content" });
  content.style.setProperty("--d", String(depth));
  line.append(gutter, foldSlot, content);
  parent.append(line);
  return { line, foldSlot, content, n };
}

function foldButton() {
  const btn = el("button", {
    type: "button",
    class: "fold",
    "aria-expanded": "true",
    "aria-label": "Collapse",
  });
  return btn;
}

function toggleBlock(block) {
  const collapsed = block.classList.toggle("is-collapsed");
  const btn = block.querySelector(":scope > .line .fold");
  if (btn) {
    btn.setAttribute("aria-expanded", String(!collapsed));
    btn.setAttribute("aria-label", collapsed ? "Expand" : "Collapse");
  }
}

function setAllCollapsed(collapsed) {
  viewer.querySelectorAll(".block").forEach((block) => {
    block.classList.toggle("is-collapsed", collapsed);
    const btn = block.querySelector(":scope > .line .fold");
    if (btn) {
      btn.setAttribute("aria-expanded", String(!collapsed));
      btn.setAttribute("aria-label", collapsed ? "Expand" : "Collapse");
    }
  });
}

function truncMark() {
  return el("span", { class: "trunc", title: "Input ended while parsing" }, "JSON ended here");
}

function appendTruncOnLast(parent) {
  const last = parent.querySelector(".line:last-of-type .content");
  if (last && !last.querySelector(".trunc")) last.append(truncMark());
}

function tok(cls, text) {
  return el("span", { class: cls }, text);
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value;
    else if (value === false || value == null) continue;
    else if (value === true) node.setAttribute(key, "");
    else node.setAttribute(key, String(value));
  }
  for (const child of children) {
    if (child == null || child === false) continue;
    node.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

function onViewerMouseDown(e) {
  if (e.target.closest(".gutter")) e.preventDefault();
}

function onViewerClick(e) {
  const gutter = e.target.closest(".gutter");
  if (!gutter || !viewer.contains(gutter)) return;
  const n = Number(gutter.dataset.line);
  if (e.shiftKey && lastClicked != null) {
    lineSel = { from: Math.min(lastClicked, n), to: Math.max(lastClicked, n) };
  } else {
    lastClicked = n;
    lineSel = { from: n, to: n };
  }
  unwrapMarks();
  paintLineSel();
}

function paintLineSel() {
  viewer.querySelectorAll(".line.is-selected").forEach((n) => n.classList.remove("is-selected"));
  if (!lineSel) return;
  for (let i = lineSel.from; i <= lineSel.to; i += 1) {
    viewer.querySelector(`.line[data-line="${i}"]`)?.classList.add("is-selected");
  }
}

function currentLineSpec() {
  if (!lineSel) return null;
  return { kind: "lines", from: lineSel.from, to: lineSel.to };
}

function onSelChange() {
  const spec = selectionSpec();
  if (!spec) {
    hideTip();
    return;
  }
  lastTipSpec = spec;
  const sel = getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) {
    hideTip();
    return;
  }
  selTip.hidden = false;
  selTip.style.left = `${rect.left + rect.width / 2}px`;
  selTip.style.top = `${rect.top}px`;
}

function hideTip() {
  selTip.hidden = true;
}

function selectionSpec() {
  const sel = getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!viewer.contains(range.commonAncestorContainer)) return null;

  const startLine = closestLine(range.startContainer);
  const endLine = closestLine(range.endContainer);
  if (!startLine || !endLine) return null;

  const fromLine = Number(startLine.dataset.line);
  const toLine = Number(endLine.dataset.line);
  const fromCol = offsetInContent(startLine, range.startContainer, range.startOffset) + 1;
  const toCol = offsetInContent(endLine, range.endContainer, range.endOffset);

  if (fromLine === toLine && fromCol > toCol) return null;
  if (toCol < 1 && fromLine === toLine) return null;

  return { kind: "cols", fromLine, fromCol, toLine, toCol: Math.max(toCol, fromCol) };
}

function closestLine(node) {
  if (node.nodeType === Node.ELEMENT_NODE) return node.closest(".line");
  return node.parentElement?.closest(".line") ?? null;
}

function offsetInContent(lineEl, node, offset) {
  const content = lineEl.querySelector(".content");
  if (!content.contains(node) && node !== content) {
    if (content.contains(node.parentElement)) {
      /* keep going with Range */
    } else {
      return 0;
    }
  }
  const pre = document.createRange();
  pre.selectNodeContents(content);
  try {
    pre.setEnd(node, offset);
  } catch {
    return pre.toString().length;
  }
  return pre.toString().length;
}

function applySelection(sel) {
  unwrapMarks();
  if (sel.kind === "cols") {
    lineSel = {
      from: Math.min(sel.fromLine, sel.toLine),
      to: Math.max(sel.fromLine, sel.toLine),
    };
    lastClicked = sel.fromLine;
    paintLineSel();
    highlightCols(sel);
    viewer.querySelector(`.line[data-line="${sel.fromLine}"]`)?.scrollIntoView({ block: "center" });
    return;
  }
  if (sel.kind === "lines") {
    lineSel = { from: sel.from, to: sel.to };
    lastClicked = sel.from;
    paintLineSel();
    viewer.querySelector(`.line[data-line="${sel.from}"]`)?.scrollIntoView({ block: "center" });
  }
}

function highlightCols(sel) {
  if (sel.fromLine === sel.toLine) {
    const content = viewer.querySelector(`.line[data-line="${sel.fromLine}"] .content`);
    if (content) wrapRange(content, sel.fromCol - 1, sel.toCol);
    return;
  }

  const start = viewer.querySelector(`.line[data-line="${sel.fromLine}"] .content`);
  if (start) wrapRange(start, sel.fromCol - 1, start.textContent.length);

  for (let i = sel.fromLine + 1; i < sel.toLine; i += 1) {
    const mid = viewer.querySelector(`.line[data-line="${i}"] .content`);
    if (mid) wrapRange(mid, 0, mid.textContent.length);
  }

  const end = viewer.querySelector(`.line[data-line="${sel.toLine}"] .content`);
  if (end) wrapRange(end, 0, sel.toCol);
}

function wrapRange(contentEl, start0, end0) {
  if (end0 <= start0) return;
  const texts = [];
  const walker = document.createTreeWalker(contentEl, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) texts.push(walker.currentNode);

  let pos = 0;
  for (const textNode of texts) {
    const len = textNode.textContent.length;
    const a = Math.max(0, start0 - pos);
    const b = Math.min(len, end0 - pos);
    if (a < b) {
      const range = document.createRange();
      range.setStart(textNode, a);
      range.setEnd(textNode, b);
      const mark = document.createElement("mark");
      mark.className = "col-hl";
      range.surroundContents(mark);
    }
    pos += len;
  }
}

function unwrapMarks() {
  viewer.querySelectorAll("mark.col-hl").forEach((mark) => {
    mark.replaceWith(...mark.childNodes);
  });
  viewer.normalize();
}

function openShare(spec) {
  const hash = buildHash(source.value, spec);
  const url = `${location.origin}${location.pathname}${location.search}#${hash}`;
  shareUrl.value = url;

  shareWarn.hidden = true;
  shareWarn.className = "warn";
  if (url.length > 10000) {
    shareWarn.hidden = false;
    shareWarn.className = "warn severe";
    shareWarn.textContent =
      "This link is very large and might not work in some browsers. You can still copy it.";
  } else if (url.length > 2000) {
    shareWarn.hidden = false;
    shareWarn.textContent = "This link is long and may not work in all browsers.";
  }

  copyBtn.textContent = "Copy";
  shareDialog.showModal();
  shareUrl.focus();
  shareUrl.select();
}

function buildHash(text, spec) {
  const body = encodeB64(text);
  if (!spec) return body;
  return `${body}|${formatSpec(spec)}`;
}

function formatSpec(spec) {
  if (spec.kind === "lines") {
    return spec.from === spec.to ? `L${spec.from}` : `L${spec.from}-${spec.to}`;
  }
  if (spec.fromLine === spec.toLine) {
    return `L${spec.fromLine}:${spec.fromCol}-${spec.toCol}`;
  }
  return `L${spec.fromLine}:${spec.fromCol}-${spec.toLine}:${spec.toCol}`;
}

function readHash(hash) {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!raw) return null;
  const bar = raw.indexOf("|");
  const b64 = bar === -1 ? raw : raw.slice(0, bar);
  const spec = bar === -1 ? "" : raw.slice(bar + 1);
  try {
    return { text: decodeB64(b64), sel: parseSpec(spec) };
  } catch {
    return null;
  }
}

function parseSpec(spec) {
  if (!spec) return null;
  let m = /^L(\d+):(\d+)-(\d+):(\d+)$/.exec(spec);
  if (m) {
    return {
      kind: "cols",
      fromLine: Number(m[1]),
      fromCol: Number(m[2]),
      toLine: Number(m[3]),
      toCol: Number(m[4]),
    };
  }
  m = /^L(\d+):(\d+)-(\d+)$/.exec(spec);
  if (m) {
    return {
      kind: "cols",
      fromLine: Number(m[1]),
      fromCol: Number(m[2]),
      toLine: Number(m[1]),
      toCol: Number(m[3]),
    };
  }
  m = /^L(\d+)-(\d+)$/.exec(spec);
  if (m) {
    return { kind: "lines", from: Number(m[1]), to: Number(m[2]) };
  }
  m = /^L(\d+)$/.exec(spec);
  if (m) {
    const n = Number(m[1]);
    return { kind: "lines", from: n, to: n };
  }
  return null;
}

function encodeB64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeB64(b64) {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(b64.replaceAll("-", "+").replaceAll("_", "/") + pad);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function copyShare() {
  const text = shareUrl.value;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    shareUrl.select();
    document.execCommand("copy");
  }
  copyBtn.textContent = "Copied";
  setTimeout(() => {
    copyBtn.textContent = "Copy";
  }, 1400);
}

function readTheme() {
  const stored = localStorage.getItem(LS_THEME);
  if (THEMES.includes(stored)) return stored;
  return "light";
}

function applyTheme(theme) {
  const next = THEMES.includes(theme) ? theme : "light";
  document.documentElement.dataset.theme = next;
  themeBtns.forEach((btn) => {
    btn.classList.toggle("is-on", btn.dataset.theme === next);
    btn.setAttribute("aria-pressed", String(btn.dataset.theme === next));
  });
}
