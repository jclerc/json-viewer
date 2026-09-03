import { parse, countValues, isEmptyAst, astToValues } from "./parser.js";
import { applyJq } from "./jq.js";

const LS_TEXT = "json-viewer.text";
const LS_THEME = "json-viewer.theme";
const LS_NEST = "json-viewer.nest";
const LS_WRAP = "json-viewer.wrap";
const LS_REGEX = "json-viewer.regex";
const LS_JQ = "json-viewer.jq";
const THEMES = ["light", "default", "dark"];

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
const fullscreenBtn = document.querySelector("#fullscreen-btn");
const searchInput = document.querySelector("#search-input");
const searchCount = document.querySelector("#search-count");
const jqInput = document.querySelector("#jq-input");
const jqMeta = document.querySelector("#jq-meta");
const nestToggle = document.querySelector("#nest-toggle");
const wrapToggle = document.querySelector("#wrap-toggle");
const regexToggle = document.querySelector("#regex-toggle");
const themeBtns = [...document.querySelectorAll(".theme-row [data-theme]")];

const ctx = { line: 0 };
let lineSel = null;
let lastClicked = null;
let pendingSel = null;
let lastTipSpec = null;
let searchHits = [];
let searchIndex = 0;

init();

async function init() {
  applyTheme(readTheme());
  nestToggle.checked = localStorage.getItem(LS_NEST) !== "0";
  wrapToggle.checked = localStorage.getItem(LS_WRAP) !== "0";
  regexToggle.checked = localStorage.getItem(LS_REGEX) !== "0";
  applyWrap(wrapToggle.checked);

  const fromHash = await readHash(location.hash);
  if (fromHash?.text) {
    source.value = fromHash.text;
    localStorage.setItem(LS_TEXT, fromHash.text);
    if (fromHash.nest != null) applyNest(fromHash.nest);
    pendingSel = fromHash.sel;
    setJq(fromHash.jq ?? "");
  } else {
    const saved = localStorage.getItem(LS_TEXT);
    if (saved) source.value = saved;
    const savedJq = localStorage.getItem(LS_JQ);
    if (savedJq) setJq(savedJq);
  }

  render();

  source.addEventListener("input", onSourceInput);
  document.querySelector("#example-link").addEventListener("click", onExample);
  document.querySelector("#upload-btn").addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", onFile);
  document.querySelector("#clear-btn").addEventListener("click", clearAll);
  expandBtn.addEventListener("click", () => setAllCollapsed(false));
  collapseBtn.addEventListener("click", () => setAllCollapsed(true));
  fullscreenBtn.addEventListener("click", toggleFullscreen);
  document.addEventListener("fullscreenchange", syncFullscreenBtn);
  document.addEventListener("webkitfullscreenchange", syncFullscreenBtn);
  shareBtn.addEventListener("click", () => openShare(currentLineSpec()));
  searchInput.addEventListener("input", () => applySearch({ reset: true }));
  searchInput.addEventListener("keydown", onSearchKey);
  regexToggle.addEventListener("change", onRegexToggle);
  jqInput.addEventListener("input", onJqInput);
  document.querySelector("#sel-share-btn").addEventListener("click", () => {
    hideTip();
    openShare(lastTipSpec);
  });
  copyBtn.addEventListener("click", copyShare);
  shareDialog.addEventListener("click", (e) => {
    const r = shareDialog.getBoundingClientRect();
    if (
      e.clientX < r.left ||
      e.clientX > r.right ||
      e.clientY < r.top ||
      e.clientY > r.bottom
    ) {
      shareDialog.close();
    }
  });
  nestToggle.addEventListener("change", onNestToggle);
  wrapToggle.addEventListener("change", onWrapToggle);
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
  applyNest(nestToggle.checked);
  lineSel = null;
  lastClicked = null;
  pendingSel = null;
  render();
}

function applyNest(on) {
  nestToggle.checked = on;
  localStorage.setItem(LS_NEST, on ? "1" : "0");
}

function onWrapToggle() {
  localStorage.setItem(LS_WRAP, wrapToggle.checked ? "1" : "0");
  applyWrap(wrapToggle.checked);
}

function onRegexToggle() {
  localStorage.setItem(LS_REGEX, regexToggle.checked ? "1" : "0");
  applySearch({ reset: true });
}

function applyWrap(on) {
  viewer.classList.toggle("no-wrap", !on);
}

function setJq(text) {
  jqInput.value = text;
  localStorage.setItem(LS_JQ, text);
}

function onJqInput() {
  localStorage.setItem(LS_JQ, jqInput.value);
  lineSel = null;
  lastClicked = null;
  pendingSel = null;
  render();
}

function toggleFullscreen() {
  if (fullscreenElement() === viewer) {
    const exit = document.exitFullscreen || document.webkitExitFullscreen;
    if (exit) exit.call(document);
    return;
  }
  const enter = viewer.requestFullscreen || viewer.webkitRequestFullscreen;
  if (enter) enter.call(viewer);
}

function fullscreenElement() {
  return document.fullscreenElement || document.webkitFullscreenElement;
}

function syncFullscreenBtn() {
  const on = fullscreenElement() === viewer;
  const label = fullscreenBtn.querySelector("[data-label]");
  const icon = fullscreenBtn.querySelector("use");
  if (label) label.textContent = on ? "Exit fullscreen" : "Fullscreen";
  if (icon) icon.setAttribute("href", on ? "#g-exit-fs" : "#g-fullscreen");
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

async function onExample(e) {
  e.preventDefault();
  const res = await fetch(e.currentTarget.href);
  if (!res.ok) return;
  source.value = await res.text();
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

async function onHashChange() {
  const fromHash = await readHash(location.hash);
  if (!fromHash) return;

  let needRender = false;
  if (fromHash.nest != null && nestToggle.checked !== fromHash.nest) {
    applyNest(fromHash.nest);
    needRender = true;
  }
  const hashJq = fromHash.jq ?? "";
  if (jqInput.value !== hashJq) {
    setJq(hashJq);
    needRender = true;
  }
  if (fromHash.text !== source.value) {
    source.value = fromHash.text;
    localStorage.setItem(LS_TEXT, fromHash.text);
    needRender = true;
  }
  if (needRender) {
    pendingSel = fromHash.sel;
    render();
    return;
  }
  if (fromHash.sel) applySelection(fromHash.sel);
}

function sourceSize(text) {
  const chars = text.length;
  const lines = text.split(/\r\n|\n|\r/).length;
  return `${chars} char${chars === 1 ? "" : "s"} · ${lines} line${lines === 1 ? "" : "s"}`;
}

function render() {
  hideTip();
  ctx.line = 0;
  const text = source.value;
  const parsed = text.trim() ? parse(text, { nest: nestToggle.checked }) : null;
  const sourceHas = parsed && !isEmptyAst(parsed);

  let ast = parsed;
  let jqNote = "";
  jqMeta.textContent = "";
  jqMeta.classList.remove("is-error");

  const jqFilter = jqInput.value.trim();
  if (sourceHas && jqFilter) {
    const result = applyJq(astToValues(parsed), jqFilter);
    if (!result.ok) {
      jqMeta.textContent = result.error;
      jqMeta.classList.add("is-error");
    } else if (!result.passthrough) {
      if (!result.values.length) {
        jqNote = " · jq: no results";
        ast = null;
      } else {
        const outText = result.values.map((v) => JSON.stringify(v, null, 2)).join("\n");
        ast = parse(outText, { nest: nestToggle.checked });
        jqNote = result.values.length === 1 ? " · jq" : ` · jq ×${result.values.length}`;
      }
    }
  }

  const has = ast && !isEmptyAst(ast);

  expandBtn.disabled = !has;
  collapseBtn.disabled = !has;
  shareBtn.disabled = !sourceHas;
  fullscreenBtn.disabled = !has;

  if (!text.trim()) {
    statusEl.hidden = true;
    viewer.replaceChildren(el("p", { class: "empty" }, "Paste JSON on the left to view it here."));
    clearSearchMarks();
    return;
  }

  if (!has) {
    statusEl.hidden = false;
    statusEl.className = "status is-trunc";
    statusEl.textContent = jqNote
      ? `${sourceSize(text)}${jqNote}`
      : `${sourceSize(text)} · Nothing could be parsed.`;
    viewer.replaceChildren(
      el(
        "p",
        { class: "empty" },
        jqNote ? "jq produced no results." : "Nothing could be parsed.",
      ),
    );
    clearSearchMarks();
    return;
  }

  const n = countValues(ast);
  const trunc = Boolean(ast.truncated);
  statusEl.hidden = false;
  statusEl.className = trunc ? "status is-trunc" : "status";
  statusEl.textContent = `${sourceSize(text)} · ${n} value${n === 1 ? "" : "s"}${trunc ? " · incomplete" : ""}${jqNote}`;

  const root = document.createDocumentFragment();
  renderValue(ast, 0, [], root, false);
  viewer.replaceChildren(root);

  if (pendingSel) {
    const sel = pendingSel;
    pendingSel = null;
    requestAnimationFrame(() => {
      applySelection(sel);
      applySearch({ reset: true });
    });
  } else if (lineSel) {
    paintLineSel();
    applySearch({ reset: false });
  } else {
    applySearch({ reset: false });
  }
}

function renderValue(node, depth, prefix, parent, comma) {
  for (const comment of node.leadingComments || []) {
    renderComment(comment, depth, parent);
  }

  if (node.type === "comment") {
    renderComment(node, depth, parent);
    return;
  }

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
    renderAfterComments(node, depth, parent);
    return;
  }

  if (node.type === "object" || node.type === "array") {
    renderCompound(node, depth, prefix, parent, comma);
    renderAfterComments(node, depth, parent);
    return;
  }

  const row = newLine(depth, parent);
  row.content.append(...prefix, ...primitive(node));
  if (comma) row.content.append(tok("p", ","));
  if (node.truncated || node.type === "missing") row.content.append(truncMark());
  renderAfterComments(node, depth, parent);
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
  const ellipsis = el("span", { class: "ellipsis" }, `…${kids.length}`);
  preview.append(ellipsis, tok("p", close + (comma ? "," : "")));
  opener.content.append(preview);

  const children = el("div", { class: "children" });

  kids.forEach((kid, i) => {
    const last = i === kids.length - 1;
    const needComma = !last;
    if (isObj) renderEntry(kid, depth + 1, children, needComma);
    else renderValue(kid, depth + 1, [], children, needComma);
  });

  for (const comment of node.trailingComments || []) {
    renderComment(comment, depth + 1, children);
  }

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
  ellipsis.addEventListener("click", (e) => {
    e.stopPropagation();
    if (block.classList.contains("is-collapsed")) toggleBlock(block);
  });
}

function renderEntry(entry, depth, parent, comma) {
  for (const comment of entry.comments || []) {
    renderComment(comment, depth, parent);
  }

  const nested = Boolean(entry.value?.nested);
  const prefix = keyPrefix(entry.key, nested);

  if (entry.keyTruncated) {
    const row = newLine(depth, parent);
    row.content.append(...prefix, truncMark());
    renderAfterComments(entry, depth, parent);
    return;
  }

  renderValue(entry.value, depth, prefix, parent, comma);
  renderAfterComments(entry, depth, parent);
}

function renderComment(node, depth, parent) {
  const row = newLine(depth, parent);
  const text = node.kind === "block" ? `/* ${node.text} */` : `// ${node.text}`;
  row.content.append(tok("c", text));
}

function renderAfterComments(node, depth, parent) {
  for (const comment of node.afterComments || []) {
    renderComment(comment, depth, parent);
  }
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
    const k = tok("k nested-key", key);
    k.title = "Parsed from a JSON string";
    return [tok("qt", '"'), k, tok("qt", '"'), tok("p", ": ")];
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
  if (depth) content.append("  ".repeat(depth));
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
  setCollapsed(block, !block.classList.contains("is-collapsed"));
}

function setCollapsed(block, collapsed) {
  block.classList.toggle("is-collapsed", collapsed);
  const btn = block.querySelector(":scope > .line .fold");
  if (btn) {
    btn.setAttribute("aria-expanded", String(!collapsed));
    btn.setAttribute("aria-label", collapsed ? "Expand" : "Collapse");
  }
}

function setAllCollapsed(collapsed) {
  viewer.querySelectorAll(".block").forEach((block) => setCollapsed(block, collapsed));
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

function wrapRange(contentEl, start0, end0, className = "col-hl") {
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
      mark.className = className;
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

function onSearchKey(e) {
  if (e.key === "Tab") {
    if (!searchHits.length) return;
    e.preventDefault();
    stepSearch(e.shiftKey ? -1 : 1);
    return;
  }
  if (e.key !== "Enter") return;
  e.preventDefault();
  if (!searchHits.length) return;
  stepSearch(e.shiftKey ? -1 : 1);
}

function applySearch({ reset } = {}) {
  clearSearchMarks();

  const query = searchInput.value;
  if (!query) {
    searchCount.textContent = "";
    searchCount.classList.remove("is-error");
    return;
  }

  let pattern;
  try {
    pattern = regexToggle.checked ? new RegExp(query, "g") : new RegExp(escapeRe(query), "g");
  } catch {
    searchCount.textContent = "Invalid regex";
    searchCount.classList.add("is-error");
    return;
  }

  searchCount.classList.remove("is-error");
  viewer.querySelectorAll(".line .content").forEach((content) => {
    const text = content.textContent;
    const ranges = [];
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text))) {
      if (!match[0].length) {
        pattern.lastIndex += 1;
        if (pattern.lastIndex > text.length) break;
        continue;
      }
      ranges.push([match.index, match.index + match[0].length]);
    }
    for (let i = ranges.length - 1; i >= 0; i -= 1) {
      wrapRange(content, ranges[i][0], ranges[i][1], "search-hl");
    }
  });

  searchHits = [...viewer.querySelectorAll("mark.search-hl")];
  if (!searchHits.length) {
    searchCount.textContent = "0";
    return;
  }
  if (reset || searchIndex >= searchHits.length) searchIndex = 0;
  paintCurrentHit();
}

function stepSearch(delta) {
  if (!searchHits.length) return;
  searchIndex = (searchIndex + delta + searchHits.length) % searchHits.length;
  paintCurrentHit();
}

function paintCurrentHit() {
  searchHits.forEach((mark) => mark.classList.remove("is-current"));
  const mark = searchHits[searchIndex];
  if (!mark) return;
  mark.classList.add("is-current");
  expandAncestors(mark);
  mark.scrollIntoView({ block: "center" });
  searchCount.textContent = `${searchIndex + 1}/${searchHits.length}`;
}

function expandAncestors(node) {
  let el = node.parentElement;
  while (el && el !== viewer) {
    if (el.classList.contains("block") && el.classList.contains("is-collapsed")) {
      setCollapsed(el, false);
    }
    el = el.parentElement;
  }
}

function clearSearchMarks() {
  viewer.querySelectorAll("mark.search-hl").forEach((mark) => {
    mark.replaceWith(...mark.childNodes);
  });
  viewer.normalize();
  searchHits = [];
  searchCount.textContent = "";
  searchCount.classList.remove("is-error");
}

function escapeRe(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function openShare(spec) {
  const hash = await buildHash(source.value, spec);
  const url = `${location.origin}${location.pathname}${location.search}#${hash}`;
  shareUrl.value = url;
  document.querySelector("#share-label-text").textContent =
    `Link (${url.length} character${url.length === 1 ? "" : "s"})`;

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

  setCopyLabel("Copy");
  shareDialog.showModal();
  shareUrl.focus();
  shareUrl.select();
}

async function buildHash(text, spec) {
  let body;
  if (text.length > 1000) {
    body = `gz|${bytesToB64(await gzipBytes(new TextEncoder().encode(text)))}`;
  } else {
    body = bytesToB64(new TextEncoder().encode(text));
  }
  const extras = [nestToggle.checked ? "n1" : "n0"];
  if (spec) extras.push(formatSpec(spec));
  const jq = jqInput.value.trim();
  if (jq) extras.push(`j${bytesToB64(new TextEncoder().encode(jq))}`);
  return `${body}|${extras.join("|")}`;
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

async function readHash(hash) {
  let raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!raw) return null;

  const gzipped = raw.startsWith("gz|");
  if (gzipped) raw = raw.slice(3);

  const bar = raw.indexOf("|");
  const b64 = bar === -1 ? raw : raw.slice(0, bar);
  const rest = bar === -1 ? "" : raw.slice(bar + 1);

  try {
    const bytes = b64ToBytes(b64);
    const text = gzipped ? await gunzipBytes(bytes) : new TextDecoder().decode(bytes);
    let nest = null;
    let selRaw = "";
    let jq = null;
    for (const part of rest ? rest.split("|") : []) {
      if (part === "n0" || part === "n1") nest = part === "n1";
      else if (part.startsWith("j") && part.length > 1) {
        jq = new TextDecoder().decode(b64ToBytes(part.slice(1)));
      } else if (part) selRaw = part;
    }
    return { text, sel: parseSpec(selRaw), nest, jq };
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

function bytesToB64(bytes) {
  let bin = "";
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function b64ToBytes(b64) {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(b64.replaceAll("-", "+").replaceAll("_", "/") + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function gzipBytes(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzipBytes(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new TextDecoder().decode(await new Response(stream).arrayBuffer());
}

async function copyShare() {
  const text = shareUrl.value;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    shareUrl.select();
    document.execCommand("copy");
  }
  setCopyLabel("Copied");
  setTimeout(() => {
    setCopyLabel("Copy");
  }, 1400);
}

function setCopyLabel(text) {
  const label = copyBtn.querySelector("[data-label]");
  if (label) label.textContent = text;
}

function readTheme() {
  const stored = localStorage.getItem(LS_THEME);
  if (stored === "blue") {
    localStorage.setItem(LS_THEME, "default");
    return "default";
  }
  if (THEMES.includes(stored)) return stored;
  return "default";
}

function applyTheme(theme) {
  const next = THEMES.includes(theme) ? theme : "default";
  document.documentElement.dataset.theme = next;
  themeBtns.forEach((btn) => {
    btn.classList.toggle("is-on", btn.dataset.theme === next);
    btn.setAttribute("aria-pressed", String(btn.dataset.theme === next));
  });
}
