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
  // These ranges refer to the current text (not just the last compared text).
  // Editing transforms the ranges so untouched text keeps its annotations.
  const overlayTexts = ["", ""];
  const overlayRanges = [[], []];
  const pendingFrames = [null, null];

  // The textareas remain editable at all times. Highlights are drawn in a
  // separate, non-interactive layer behind them and never replace the editors.
  function cancelJob() {
    ++currentJob;
    clearTimeout(stopTimer);
    stopTimer = null;
    if (worker) { worker.terminate(); worker = null; }
  }

  // Update offsets after one contiguous edit. Ranges outside the edited
  // span are preserved even when text is inserted/deleted before them.
  // The affected characters lose their old annotation until the next Compare.
  function transformRanges(ranges, before, after) {
    let prefix = 0;
    const limit = Math.min(before.length, after.length);
    while (prefix < limit && before.charCodeAt(prefix) === after.charCodeAt(prefix)) prefix++;

    let oldEnd = before.length, newEnd = after.length;
    while (oldEnd > prefix && newEnd > prefix &&
           before.charCodeAt(oldEnd - 1) === after.charCodeAt(newEnd - 1)) {
      oldEnd--;
      newEnd--;
    }
    const shift = newEnd - oldEnd;
    const transformed = [];
    for (const [start, end] of ranges) {
      // The unchanged prefix retains its original position.
      const beforeEditEnd = Math.min(end, prefix);
      if (start < beforeEditEnd) transformed.push([start, beforeEditEnd]);
      // The unchanged suffix keeps its marks at their new positions.
      const afterEditStart = Math.max(start, oldEnd);
      if (afterEditStart < end) transformed.push([afterEditStart + shift, end + shift]);
    }
    return transformed;
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

  function positionOverlay(index) {
    const textarea = textareas[index];
    // Account for the textarea's scrollbar so wrapping stays aligned.
    const scrollbarWidth = textarea.offsetWidth - textarea.clientWidth;
    outputs[index].style.setProperty("--scrollbar-width", `${scrollbarWidth}px`);
    contents[index].style.transform = `translateY(${-textarea.scrollTop}px)`;
  }

  function renderText(element, value, ranges) {
    // Only changed spans become elements. Unchanged spans are plain text nodes.
    if (ranges.length > 9000) {
      const merged = [];
      for (const [start, end] of ranges) {
        const previous = merged[merged.length - 1];
        if (previous && start - previous[1] < 120) previous[1] = end;
        else merged.push([start, end]);
      }
      ranges = merged;
    }
    const fragment = document.createDocumentFragment();
    let previous = 0;
    for (const [start, end] of ranges) {
      if (start < previous || end > value.length || start >= end) continue;
      if (start > previous) fragment.appendChild(document.createTextNode(value.slice(previous, start)));
      const mark = document.createElement("mark");
      mark.textContent = value.slice(start, end);
      fragment.appendChild(mark);
      previous = end;
    }
    if (previous < value.length) fragment.appendChild(document.createTextNode(value.slice(previous)));
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
    // Clicking Compare again simply replaces the previous comparison.
    // An in-flight comparison is canceled, not queued.
    cancelJob();
    const job = currentJob;
    const values = textareas.map(element => element.value);
    status.textContent = "Comparing texts.";
    try {
      const newWorker = new Worker("diff-worker.js");
      worker = newWorker;
      newWorker.onmessage = event => {
        if (job !== currentJob) return;
        clearTimeout(stopTimer);
        stopTimer = null;
        newWorker.terminate();
        worker = null;
        if (event.data.error) {
          status.textContent = event.data.error;
          window.alert(event.data.error);
          return;
        }
        // The editors stay in place, preserving focus, selection and scroll.
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
      // Cancel a pending comparison, but never clear unrelated highlights.
      cancelJob();
      if (highlighted) {
        const nextText = textareas[i].value;
        if (nextText !== overlayTexts[i]) {
          overlayRanges[i] = transformRanges(overlayRanges[i], overlayTexts[i], nextText);
          overlayTexts[i] = nextText;
          scheduleOverlayRender(i);
        }
      }
      // Changes have not been re-compared: Compare refreshes both sides.
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
