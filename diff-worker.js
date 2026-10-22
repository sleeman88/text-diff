"use strict";

// Independent, dependency-free hierarchical diff.
// Word tokens anchor large texts; gaps (including whitespace) are compared character by character.
const WORD = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*|[^\s]/gu;
const MAX_CHARS = 8_000_000;
const CHAR_MAX_LENGTH = 6000;
const CHAR_MAX_D = 400;
const MAX_WORK_MS = 18_000;
const MYERS_MAX_LENGTH = 1800;
const MYERS_MAX_D = 190;

function tokenize(input) {
  const items = [];
  WORD.lastIndex = 0;
  for (const match of input.matchAll(WORD)) {
    items.push({value: match[0], from: match.index, to: match.index + match[0].length});
  }
  return items;
}

// Merge adjacent edits, never unrelated text separated by unchanged spaces.
function appendRange(ranges, start, end) {
  if (end <= start) return;
  const last = ranges[ranges.length - 1];
  if (last && start <= last[1]) last[1] = Math.max(last[1], end);
  else ranges.push([start, end]);
}

function addAnchors(A, B, a0, a1, b0, b1, width) {
  if (a1 - a0 < width || b1 - b0 < width) return [];
  function windows(tokens, start, end) {
    const positions = new Map();
    for (let i = start; i <= end - width; i++) {
      let h = 2166136261;
      for (let j = 0; j < width; j++) {
        // Hash complete tokens, not just their lengths.
        const s = tokens[i+j].value;
        for (let k = 0; k < s.length; k++) h = Math.imul(h ^ s.charCodeAt(k), 16777619);
        h = Math.imul(h ^ 0x9f, 16777619);
      }
      h >>>= 0;
      if (!positions.has(h)) positions.set(h, i);
      else positions.set(h, -1);
    }
    return positions;
  }
  const aMap = windows(A, a0, a1);
  const bMap = windows(B, b0, b1);
  const candidates = [];
  for (const [hash, a] of aMap) {
    if (a < 0) continue;
    const b = bMap.get(hash);
    if (b == null || b < 0) continue;
    let same = true;
    for (let j = 0; j < width; j++) {
      if (A[a + j].value !== B[b + j].value) { same = false; break; }
    }
    if (same) candidates.push([a, b]);
  }
  candidates.sort((x, y) => x[0] - y[0]);
  // Longest increasing subsequence on right-hand positions.
  const tails = [], tailsPos = [], previous = new Int32Array(candidates.length).fill(-1);
  for (let i = 0; i < candidates.length; i++) {
    const b = candidates[i][1];
    let lo = 0, hi = tails.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (tails[mid] < b) lo = mid + 1; else hi = mid; }
    if (lo > 0) previous[i] = tailsPos[lo - 1];
    tails[lo] = b; tailsPos[lo] = i;
  }
  const path = [];
  let at = tailsPos[tails.length - 1];
  while (at !== undefined && at >= 0) { path.push(candidates[at]); at = previous[at]; }
  path.reverse();
  // Windows can overlap. A valid chain must be non-overlapping in both texts.
  const anchors = [];
  let lastA = a0 - width, lastB = b0 - width;
  for (const [a, b] of path) {
    if (a >= lastA + width && b >= lastB + width) {
      anchors.push([a, b, width]); lastA = a; lastB = b;
    }
  }
  return anchors;
}

function findMyers(A, B, a0, a1, b0, b1, deadline, maxLength = MYERS_MAX_LENGTH, maxDistance = MYERS_MAX_D) {
  const n = a1 - a0, m = b1 - b0;
  if (n + m > maxLength) return null;
  const maxD = Math.min(n + m, maxDistance);
  const offset = n + m + 1;
  const prev = new Int32Array(2 * offset + 3).fill(-1);
  prev[offset + 1] = 0;
  let v = prev;
  const trace = [];
  let found = false;
  let lastD = -1;
  for (let d = 0; d <= maxD; d++) {
    if ((d & 15) === 0 && Date.now() > deadline) return null;
    const next = v.slice();
    for (let k = -d; k <= d; k += 2) {
      const index = offset + k;
      let x;
      if (k === -d || (k !== d && v[index - 1] < v[index + 1])) x = v[index + 1];
      else x = v[index - 1] + 1;
      let y = x - k;
      while (x < n && y < m && x >= 0 && y >= 0 && A[a0+x].value === B[b0+y].value) { x++; y++; }
      next[index] = x;
      if (x >= n && y >= m) { found = true; lastD = d; break; }
    }
    trace.push(next);
    if (found) break;
    v = next;
  }
  if (!found) return null;
  let x = n, y = m;
  const steps = [];
  for (let d = lastD; d > 0; d--) {
    const previous = trace[d-1];
    const k = x - y;
    const prevK = (k === -d || (k !== d && previous[offset+k-1] < previous[offset+k+1])) ? k+1 : k-1;
    const prevX = previous[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { steps.push(0); x--; y--; }
    if (x === prevX) { steps.push(2); y--; }
    else { steps.push(1); x--; }
  }
  while (x > 0 && y > 0) { steps.push(0); x--; y--; }
  while (x-- > 0) steps.push(1);
  while (y-- > 0) steps.push(2);
  steps.reverse();
  return steps;
}

// Within unaligned word regions, find the smallest character changes.
// Because we operate on the original character offsets, a missing/extra space
// is a one-character difference, not a changed word.
function compareGap(left, right, startA, endA, startB, endB, deadline, leftRanges, rightRanges) {
  while (startA < endA && startB < endB && left[startA] === right[startB]) {
    startA++; startB++;
  }
  while (startA < endA && startB < endB && left[endA - 1] === right[endB - 1]) {
    endA--; endB--;
  }
  if (startA === endA || startB === endB) {
    appendRange(leftRanges, startA, endA);
    appendRange(rightRanges, startB, endB);
    return false;
  }

  const a = left.slice(startA, endA);
  const b = right.slice(startB, endB);
  // Avoid quadratic behavior on large, largely unrelated blocks.
  if (a.length + b.length > CHAR_MAX_LENGTH) {
    appendRange(leftRanges, startA, endA);
    appendRange(rightRanges, startB, endB);
    return true;
  }
  const A = Array.from({length: a.length}, (_, i) => ({value: a[i]}));
  const B = Array.from({length: b.length}, (_, i) => ({value: b[i]}));
  const steps = findMyers(A, B, 0, A.length, 0, B.length, deadline,
                          CHAR_MAX_LENGTH, CHAR_MAX_D);
  if (!steps) {
    appendRange(leftRanges, startA, endA);
    appendRange(rightRanges, startB, endB);
    return true;
  }
  let i = startA, j = startB;
  for (const op of steps) {
    if (op === 0) { i++; j++; }
    else if (op === 1) { appendRange(leftRanges, i, i + 1); i++; }
    else { appendRange(rightRanges, j, j + 1); j++; }
  }
  return false;
}

function compute(left, right) {
  if (left.length > MAX_CHARS || right.length > MAX_CHARS) {
    throw new Error("The document is too large for this browser tool. Please compare smaller sections.");
  }
  const deadline = Date.now() + MAX_WORK_MS;
  const A = tokenize(left), B = tokenize(right);
  // Pairs of equal non-whitespace tokens provide reliable anchors.
  // Whitespace is NOT discarded: every gap between anchors is compared later.
  const matches = [];
  let degraded = false;
  const stack = [[0, A.length, 0, B.length, 0]];

  while (stack.length) {
    let [a0, a1, b0, b1, level] = stack.pop();
    while (a0 < a1 && b0 < b1 && A[a0].value === B[b0].value) {
      matches.push([a0, b0]); a0++; b0++;
    }
    while (a0 < a1 && b0 < b1 && A[a1-1].value === B[b1-1].value) {
      matches.push([a1-1, b1-1]); a1--; b1--;
    }
    if (a0 === a1 || b0 === b1) continue;
    if (Date.now() > deadline || level >= 12) {
      degraded = true;
      continue;
    }
    const width = (a1-a0 + b1-b0 > 600) ? 7 : 3;
    const anchors = addAnchors(A, B, a0, a1, b0, b1, width);
    if (anchors.length) {
      const gaps = [];
      let leftFrom = a0, rightFrom = b0;
      for (const [a,b,len] of anchors) {
        gaps.push([leftFrom, a, rightFrom, b, level+1]);
        for (let j = 0; j < len; j++) matches.push([a+j,b+j]);
        leftFrom = a + len; rightFrom = b + len;
      }
      gaps.push([leftFrom, a1, rightFrom, b1, level+1]);
      for (let i = gaps.length - 1; i >= 0; i--) stack.push(gaps[i]);
      continue;
    }
    const steps = findMyers(A, B, a0, a1, b0, b1, deadline);
    if (steps) {
      let ai=a0, bi=b0;
      for (const op of steps) {
        if (op === 0) { matches.push([ai,bi]); ai++; bi++; }
        else if (op === 1) ai++;
        else bi++;
      }
    } else degraded = true;
  }

  // The token alignment intentionally ignored whitespace to locate matching
  // content across line wraps. The final diff DOES compare spaces and line breaks.
  matches.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const leftRanges = [], rightRanges = [];
  let leftEnd = 0, rightEnd = 0;
  for (const [ai, bi] of matches) {
    const la = A[ai], rb = B[bi];
    if (la.from < leftEnd || rb.from < rightEnd) continue;
    if (compareGap(left, right, leftEnd, la.from, rightEnd, rb.from,
                   deadline, leftRanges, rightRanges)) degraded = true;
    leftEnd = la.to;
    rightEnd = rb.to;
  }
  if (compareGap(left, right, leftEnd, left.length, rightEnd, right.length,
                 deadline, leftRanges, rightRanges)) degraded = true;
  return {leftRanges, rightRanges, degraded};
}

self.onmessage = event => {
  try {
    const result = compute(event.data.left, event.data.right);
    self.postMessage(result);
  } catch (e) {
    self.postMessage({error: (e && e.message) || "Comparison failed."});
  }
};
