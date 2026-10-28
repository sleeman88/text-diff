"use strict";

(() => {
  const textareas = [document.getElementById("left-text"), document.getElementById("right-text")];
  const editors = [document.getElementById("left-output"), document.getElementById("right-output")];
  const button = document.getElementById("compare");
  const status = document.getElementById("status");
  let worker = null, jobId = 0, timeout = null;
  let aligned = false, syncing = false, heightFrame = null;
  let rowPairs = [];

  function cancelJob() {
    jobId++;
    clearTimeout(timeout); timeout = null;
    if (worker) { worker.terminate(); worker = null; }
  }

  function getLineText(element) {
    // Plain content in the editable line. Ignore visual-only line-break markers.
    if (!element.textContent && element.querySelector("br")) return "";
    let result = "";
    function visit(node) {
      if (node.nodeType === Node.TEXT_NODE) { result += node.nodeValue; return; }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      if (node.classList && node.classList.contains("break-indicator")) return;
      if (node.tagName === "BR") {
        // A lone BR stands for an empty line, not an additional line.
        if (node.parentElement !== element || element.textContent.trim() !== "") result += "\n";
        return;
      }
      const isLine = node !== element && /^(DIV|P)$/.test(node.tagName);
      if (isLine && result && !result.endsWith("\n")) result += "\n";
      for (const child of node.childNodes) visit(child);
    }
    for (const child of element.childNodes) visit(child);
    return result;
  }

  function readEditor(side) {
    if (!aligned) return textareas[side].value;
    const lines = [];
    for (const node of editors[side].childNodes) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const value = getLineText(node);
        if (value !== null) lines.push(value);
      } else if (node.nodeType === Node.TEXT_NODE && node.textContent) {
        if (lines.length) lines[lines.length - 1] += node.textContent;
        else lines.push(node.textContent);
      }
    }
    return lines.join("\n");
  }

  function renderSourceLine(text, absoluteStart, ranges, changedNewlines, hasNewline) {
    const line = document.createElement("div");
    line.className = "aligned-line";
    line.setAttribute("data-source", "true");
    const absoluteEnd = absoluteStart + text.length;
    let cursor = absoluteStart;
    for (const [start, end] of ranges) {
      if (end <= absoluteStart) continue;
      if (start >= absoluteEnd) break;
      const lo = Math.max(start, absoluteStart), hi = Math.min(end, absoluteEnd);
      if (lo > cursor) line.appendChild(document.createTextNode(text.slice(cursor - absoluteStart, lo - absoluteStart)));
      if (hi > lo) {
        const mark = document.createElement("mark");
        mark.textContent = text.slice(lo - absoluteStart, hi - absoluteStart);
        line.appendChild(mark);
        cursor = hi;
      }
    }
    if (cursor < absoluteEnd) line.appendChild(document.createTextNode(text.slice(cursor-absoluteStart)));
    if (!text) {
      line.classList.add("empty");
      line.appendChild(document.createElement("br"));
    }
    if (hasNewline && changedNewlines.has(absoluteEnd)) {
      line.classList.add("break-changed");
      if (!text) line.classList.add("blank-difference");
      else {
        const flag = document.createElement("span");
        flag.className = "break-indicator";
        flag.contentEditable = "false";
        flag.setAttribute("aria-hidden", "true");
        line.appendChild(flag);
      }
    }
    return line;
  }

  function buildSourceLines(value, ranges, breaks) {
    const lines = value.split("\n");
    const positions = new Set(breaks || []);
    const nodes = [];
    let absolute = 0;
    for (let i=0; i<lines.length; i++) {
      nodes.push(renderSourceLine(lines[i], absolute, ranges, positions, i < lines.length-1));
      absolute += lines[i].length + 1;
    }
    return nodes;
  }

  function synchronizeHeights() {
    heightFrame = null;
    if (!aligned) return;
    // Align using visual spacing between actual source lines. No placeholder
    // DOM rows are inserted, so selecting/copying never includes fake lines.
    for (const pair of rowPairs) for (const node of pair) if(node) {
      node.style.minHeight = "";
      node.style.marginTop = "";
    }
    for(const e of editors) e.style.paddingBottom = "17px";
    const naturalHeights = rowPairs.map(([left,right]) =>
      Math.max(left?.offsetHeight || 0, right?.offsetHeight || 0));
    const cursor=[0,0];
    let targetY=0;
    rowPairs.forEach((pair,k) => {
      const height = Math.ceil(naturalHeights[k]);
      for(let side=0;side<2;side++) {
        const node=pair[side];
        if (!node) continue;
        const gap=Math.max(0,Math.round(targetY-cursor[side]));
        if(gap) node.style.marginTop = `${gap}px`;
        node.style.minHeight = `${height}px`;
        cursor[side]=targetY+height;
      }
      targetY+=height;
    });
    for(let side=0;side<2;side++) {
      const endGap=Math.max(0,Math.round(targetY-cursor[side]));
      editors[side].style.paddingBottom = `${17+endGap}px`;
    }
  }

  function scheduleHeights() {
    if (heightFrame != null) return;
    heightFrame = requestAnimationFrame(synchronizeHeights);
  }

  function renderResults(result, values) {
    const source = [
      buildSourceLines(values[0], result.leftRanges, result.leftBreaks),
      buildSourceLines(values[1], result.rightRanges, result.rightBreaks)
    ];
    const fragments = [document.createDocumentFragment(),document.createDocumentFragment()];
    const pairs=[];
    // A limited fallback is still usable when the comparison engine does not
    // provide structural anchors (for example an older worker is cached).
    const alignment = result.alignment || Array.from({length:Math.max(source[0].length,source[1].length)},(_,i)=>[
      i<source[0].length?i:-1, i<source[1].length?i:-1
    ]);
    for (const [a,b] of alignment) {
      const ln = a < 0 ? null : source[0][a];
      const rn = b < 0 ? null : source[1][b];
      if (ln) fragments[0].appendChild(ln);
      if (rn) fragments[1].appendChild(rn);
      pairs.push([ln,rn]);
    }
    for (let i=0;i<2;i++) {
      editors[i].replaceChildren(fragments[i]);
      editors[i].hidden=false;
      textareas[i].hidden=true;
    }
    rowPairs = pairs;
    aligned = true;
    synchronizeHeights();
    editors[0].scrollTop = editors[1].scrollTop = 0;
    status.textContent = "Comparison complete. Both sides remain editable.";
  }

  function runCompare() {
    cancelJob();
    const thisJob=jobId;
    const values=[readEditor(0),readEditor(1)];
    status.textContent = "Comparing texts.";
    try {
      const running = new Worker("diff-worker.js?v=aligned-20261028-1");
      worker=running;
      running.onmessage = evt => {
        if (thisJob!==jobId) return;
        clearTimeout(timeout);timeout=null;
        running.terminate();worker=null;
        if (evt.data.error) {status.textContent=evt.data.error; window.alert(evt.data.error);return;}
        requestAnimationFrame(()=>{if(thisJob===jobId) renderResults(evt.data,values);});
      };
      running.onerror = () => {
        if(thisJob!==jobId)return;
        cancelJob();status.textContent="Comparison failed.";
        window.alert("This comparison could not be completed in the browser.");
      };
      timeout=setTimeout(()=>{
        if(thisJob!==jobId)return;
        cancelJob();status.textContent="Comparison timed out.";
        window.alert("This comparison exceeded the processing time limit. Try comparing smaller sections.");
      },30000);
      running.postMessage({left:values[0],right:values[1]});
    } catch (_) {
      cancelJob();status.textContent="Comparison failed.";
      window.alert("Your browser could not start the comparison worker.");
    }
  }

  button.addEventListener("click",runCompare);
  for(let i=0;i<2;i++) {
    textareas[i].addEventListener("input",cancelJob);
    editors[i].addEventListener("input", e => {
      cancelJob();
      // Keep untouched highlights on other lines, remove stale ones only
      // from the source line being edited.
      const selection=window.getSelection();
      const node=selection && selection.anchorNode;
      const row=node && (node.nodeType===Node.ELEMENT_NODE?node:node.parentElement)?.closest?.(".aligned-line");
      if (row && editors[i].contains(row)) {
        for(const mark of Array.from(row.querySelectorAll("mark"))) mark.replaceWith(...Array.from(mark.childNodes));
        row.querySelectorAll(".break-indicator").forEach(x=>x.remove());
        row.classList.remove("break-changed","blank-difference");
      }
      scheduleHeights();
      status.textContent="Text edited. Press Compare to refresh differences.";
    });
    editors[i].addEventListener("paste", e => {
      const plaintext=e.clipboardData?.getData("text/plain");
      if(plaintext===undefined)return;
      e.preventDefault();
      // Paste text, never HTML from Word/Excel. Plain text preserves newlines.
      document.execCommand("insertText",false,plaintext);
    });
    const scrollTarget = aligned => aligned ? editors[i] : textareas[i];
    const onScroll = event => {
      if(syncing)return;
      syncing=true;
      const source=event.currentTarget;
      const target=aligned?editors[1-i]:textareas[1-i];
      if (aligned) target.scrollTop=source.scrollTop;
      else {
        const s=Math.max(0,source.scrollHeight-source.clientHeight);
        const t=Math.max(0,target.scrollHeight-target.clientHeight);
        target.scrollTop=s?source.scrollTop/s*t:0;
      }
      requestAnimationFrame(()=>{syncing=false;});
    };
    textareas[i].addEventListener("scroll",onScroll,{passive:true});
    editors[i].addEventListener("scroll",onScroll,{passive:true});
  }
  window.addEventListener("resize",scheduleHeights);
})();
