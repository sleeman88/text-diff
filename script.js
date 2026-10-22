"use strict";

(() => {
  const textareas = [document.getElementById("left-text"), document.getElementById("right-text")];
  const outputs = [document.getElementById("left-output"), document.getElementById("right-output")];
  const contents = outputs.map(element => element.querySelector(".diff-text"));
  const panes = textareas.map(element => element.closest(".pane"));
  const compare = document.getElementById("compare");
  const status = document.getElementById("status");
  let worker = null;
  let currentJob = 0;
  let stopTimer = null;
  let highlighted = false;
  let syncing = false;
  const overlayTexts = ["", ""];
  const overlayRanges = [[], []];
  const pendingFrames = [null, null];

  function cancelJob() {
    ++currentJob;
    clearTimeout(stopTimer);
    stopTimer = null;
    if (worker) { worker.terminate(); worker = null; }
  }

  function transformRanges(ranges, before, after) {
    let prefix = 0;
    const limit = Math.min(before.length, after.length);
    while (prefix < limit && before.charCodeAt(prefix) === after.charCodeAt(prefix)) prefix++;
    let oldEnd = before.length, newEnd = after.length;
    while (oldEnd > prefix && newEnd > prefix &&
           before.charCodeAt(oldEnd - 1) === after.charCodeAt(newEnd - 1)) {
      oldEnd--; newEnd--;
    }
    const shift = newEnd - oldEnd;
    const transformed = [];
    for (const [start, end] of ranges) {
      const beforeEditEnd = Math.min(end, prefix);
      if (start < beforeEditEnd) transformed.push([start, beforeEditEnd]);
      const afterEditStart = Math.max(start, oldEnd);
      if (afterEditStart < end) transformed.push([afterEditStart + shift, end + shift]);
    }
    return transformed;
  }

  function positionOverlay(index) {
    const textarea = textareas[index];
    const scrollbarWidth = textarea.offsetWidth - textarea.clientWidth;
    outputs[index].style.setProperty("--scrollbar-width", `${scrollbarWidth}px`);
    contents[index].style.transform = `translateY(${-textarea.scrollTop}px)`;
    contents[index].style.translate = `${-textarea.scrollLeft}px 0`;
  }

  function scheduleOverlayRender(index) {
    if (pendingFrames[index] !== null) return;
    pendingFrames[index] = requestAnimationFrame(() => {
      pendingFrames[index] = null;
      if (!highlighted) return;
      renderText(contents[index], overlayTexts[index], overlayRanges[index]);
      positionOverlay(index);
    });
  }

  // Rebuild the text as explicit line elements. A changed newline becomes a
  // line-level annotation. It does not depend on getBoundingClientRect() of a
  // zero-width newline, and empty rows have their own visible background.
  function renderText(element, text, ranges) {
    const fragment = document.createDocumentFragment();
    let lineStart = 0;
    let searchFrom = 0;
    let rangeAt = 0;

    for (;;) {
      const next = text.indexOf("\n", searchFrom);
      const lineEnd = next === -1 ? text.length : next;
      const line = document.createElement("div");
      line.className = "diff-line";
      if (lineStart === lineEnd) line.classList.add("empty");

      // Move the range cursor to the first range intersecting this line.
      while (rangeAt < ranges.length && ranges[rangeAt][1] <= lineStart) rangeAt++;
      let at = lineStart;
      let i = rangeAt;
      while (i < ranges.length && ranges[i][0] < lineEnd) {
        const [rawStart, rawEnd] = ranges[i];
        const start = Math.max(lineStart, rawStart);
        const end = Math.min(lineEnd, rawEnd);
        if (start > at) line.appendChild(document.createTextNode(text.slice(at, start)));
        if (end > start) {
          const mark = document.createElement("mark");
          mark.textContent = text.slice(start, end);
          line.appendChild(mark);
          at = end;
        }
        i++;
      }
      if (at < lineEnd) line.appendChild(document.createTextNode(text.slice(at, lineEnd)));

      if (next !== -1) {
        // A difference of the newline *character* annotates its source line.
        // For a blank line this shades the whole blank row.
        while (rangeAt < ranges.length && ranges[rangeAt][1] <= next) rangeAt++;
        if (rangeAt < ranges.length &&
            ranges[rangeAt][0] <= next && ranges[rangeAt][1] > next) {
          line.classList.add("break-changed");
        }
      }
      fragment.appendChild(line);
      if (next === -1) break;
      searchFrom = next + 1;
      lineStart = searchFrom;
    }
    element.replaceChildren(fragment);
  }

  function showResults(data, values) {
    for (let i = 0; i < 2; i++) {
      if (pendingFrames[i] !== null) {
        cancelAnimationFrame(pendingFrames[i]);
        pendingFrames[i] = null;
      }
      overlayTexts[i] = values[i];
      overlayRanges[i] = (i === 0 ? data.leftRanges : data.rightRanges);
      renderText(contents[i], overlayTexts[i], overlayRanges[i]);
    }
    for (let i = 0; i < 2; i++) {
      outputs[i].hidden = false;
      panes[i].classList.add("has-diff");
      positionOverlay(i);
    }
    highlighted = true;
    status.textContent = "Comparison complete.";
  }

  function runComparison() {
    cancelJob();
    const job = currentJob;
    const values = textareas.map(element => element.value);
    status.textContent = "Comparing texts.";
    try {
      const newWorker = new Worker("diff-worker.js?v=line-renderer-20261022-1");
      worker = newWorker;
      newWorker.onmessage = event => {
        if (job !== currentJob) return;
        clearTimeout(stopTimer); stopTimer = null;
        newWorker.terminate(); worker = null;
        if (event.data.error) {
          status.textContent = event.data.error;
          window.alert(event.data.error);
          return;
        }
        requestAnimationFrame(() => {
          if (job === currentJob) showResults(event.data, values);
        });
      };
      newWorker.onerror = () => {
        if (job !== currentJob) return;
        cancelJob();
        status.textContent = "Comparison failed.";
        window.alert("The comparison could not be completed in this browser.");
      };
      stopTimer = setTimeout(() => {
        if (job !== currentJob) return;
        cancelJob();
        status.textContent = "Comparison timed out.";
        window.alert("This comparison exceeded the processing time limit. Try comparing smaller sections.");
      }, 30000);
      newWorker.postMessage({left: values[0], right: values[1]});
    } catch (_) {
      cancelJob();
      status.textContent = "Comparison failed.";
      window.alert("Your browser could not start the comparison worker.");
    }
  }

  compare.addEventListener("click", runComparison);
  for (let i = 0; i < 2; i++) {
    textareas[i].addEventListener("input", () => {
      cancelJob();
      if (highlighted) {
        const nextText = textareas[i].value;
        if (nextText !== overlayTexts[i]) {
          overlayRanges[i] = transformRanges(overlayRanges[i], overlayTexts[i], nextText);
          overlayTexts[i] = nextText;
          scheduleOverlayRender(i);
        }
      }
      status.textContent = "Text edited. Press Compare to refresh the differences.";
    });
    textareas[i].addEventListener("scroll", () => {
      if (!highlighted) return;
      positionOverlay(i);
      if (syncing) return;
      syncing = true;
      const otherIndex = 1 - i;
      const source = textareas[i];
      const target = textareas[otherIndex];
      const scrollRange = source.scrollHeight - source.clientHeight;
      const targetRange = target.scrollHeight - target.clientHeight;
      target.scrollTop = scrollRange > 0 ? (source.scrollTop / scrollRange) * targetRange : 0;
      positionOverlay(otherIndex);
      requestAnimationFrame(() => { syncing = false; });
    }, {passive: true});
  }
  window.addEventListener("resize", () => {
    if (highlighted) for (let i = 0; i < 2; i++) positionOverlay(i);
  });
})();
