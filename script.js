"use strict";

(() => {
  const textareas = [document.getElementById("left-text"), document.getElementById("right-text")];
  const outputs = [document.getElementById("left-output"), document.getElementById("right-output")];
  const compare = document.getElementById("compare");
  const status = document.getElementById("status");
  let mode = "edit";
  let worker = null;
  let currentJob = 0;
  let stopTimer = null;

  function showEditor() {
    clearTimeout(stopTimer);
    if (worker) { worker.terminate(); worker = null; }
    currentJob++;
    mode = "edit";
    for (let i = 0; i < 2; i++) {
      textareas[i].hidden = false;
      outputs[i].hidden = true;
      outputs[i].replaceChildren();
    }
    compare.textContent = "Compare";
    compare.disabled = false;
    status.textContent = "";
    textareas[0].focus();
  }

  function renderText(el, value, ranges) {
    // Only changed spans become elements; unchanged text remains simple text nodes.
    // If edits are unusually fragmented, collapse markings into larger ranges.
    if (ranges.length > 9000) {
      const merged = [];
      for (const [start, end] of ranges) {
        const prev = merged[merged.length - 1];
        if (prev && start - prev[1] < 120) prev[1] = end;
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
    el.replaceChildren(fragment);
  }

  function showResults(data) {
    const values = textareas.map(el => el.value);
    renderText(outputs[0], values[0], data.leftRanges);
    renderText(outputs[1], values[1], data.rightRanges);
    for (let i = 0; i < 2; i++) {
      textareas[i].hidden = true;
      outputs[i].hidden = false;
      outputs[i].scrollTop = 0;
    }
    mode = "result";
    compare.disabled = false;
    compare.textContent = "Edit";
    status.textContent = "Comparison complete.";
  }

  function runComparison() {
    if (mode === "result") { showEditor(); return; }
    if (mode === "working") return;

    const left = textareas[0].value;
    const right = textareas[1].value;
    const job = ++currentJob;
    mode = "working";
    compare.disabled = true;
    compare.textContent = "Comparing…";
    status.textContent = "Comparing texts.";

    try {
      worker = new Worker("diff-worker.js");
      worker.onmessage = event => {
        if (job !== currentJob) return;
        clearTimeout(stopTimer);
        worker.terminate(); worker = null;
        if (event.data.error) {
          mode = "edit";
          compare.disabled = false;
          compare.textContent = "Compare";
          status.textContent = event.data.error;
          window.alert(event.data.error);
          return;
        }
        // Allow the browser to paint the enabled button before building the view.
        requestAnimationFrame(() => showResults(event.data));
      };
      worker.onerror = () => {
        if (job !== currentJob) return;
        clearTimeout(stopTimer);
        worker?.terminate(); worker = null;
        mode = "edit";
        compare.disabled = false;
        compare.textContent = "Compare";
        window.alert("The comparison could not be completed in this browser.");
      };
      stopTimer = setTimeout(() => {
        if (job !== currentJob || mode !== "working") return;
        worker?.terminate(); worker = null;
        mode = "edit";
        compare.disabled = false;
        compare.textContent = "Compare";
        window.alert("This comparison exceeded the processing time limit. Try comparing smaller sections.");
      }, 30000);
      worker.postMessage({left, right});
    } catch (err) {
      mode = "edit";
      compare.disabled = false;
      compare.textContent = "Compare";
      window.alert("Your browser could not start the comparison worker.");
    }
  }

  compare.addEventListener("click", runComparison);

  // Keep corresponding positions in view while browsing the results.
  let syncing = false;
  for (let i = 0; i < 2; i++) {
    outputs[i].addEventListener("scroll", () => {
      if (syncing || mode !== "result") return;
      syncing = true;
      const other = outputs[1 - i];
      const thisRange = outputs[i].scrollHeight - outputs[i].clientHeight;
      const otherRange = other.scrollHeight - other.clientHeight;
      other.scrollTop = thisRange > 0 ? (outputs[i].scrollTop / thisRange) * otherRange : 0;
      requestAnimationFrame(() => { syncing = false; });
    }, {passive: true});
  }
})();
