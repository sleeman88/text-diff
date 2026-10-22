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

  // The textareas remain editable at all times. Highlights are drawn in a
  // separate, non-interactive layer behind them and never replace the editors.
  function cancelJob() {
    ++currentJob;
    clearTimeout(stopTimer);
    stopTimer = null;
    if (worker) { worker.terminate(); worker = null; }
  }

  function hideHighlights() {
    if (!highlighted) return;
    highlighted = false;
    for (let i = 0; i < 2; i++) {
      panes[i].classList.remove("has-diff");
      outputs[i].hidden = true;
    }
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
    renderText(contents[0], values[0], data.leftRanges);
    renderText(contents[1], values[1], data.rightRanges);
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
      // Show the actual editable text immediately. Old ranges no longer match
      // after a keystroke, so wait for the next Compare before highlighting.
      cancelJob();
      hideHighlights();
      status.textContent = "";
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
