/**
 * Browser-side script injected via page.addInitScript() for scenario recording.
 *
 * Three responsibilities:
 * A. Floating toolbar for phase control (Setup → Map → Done)
 * B. Interaction capture (click, change, submit)
 * C. Step type resolution — prefer labels over selectors
 *
 * Communication: sends structured events to Node via console.log + __flowRecorder protocol.
 */
(function () {
  // Guard against double-injection
  if (window.__flowRecorderInjected) return;
  window.__flowRecorderInjected = true;

  // Persist phase and step count across page navigations via sessionStorage
  let phase = sessionStorage.getItem("__fr_phase") || "setup";
  let stepCount = parseInt(sessionStorage.getItem("__fr_stepCount") || "0", 10);

  // ─── Communication ──────────────────────────────────────────────────

  function send(event, data) {
    console.log(
      JSON.stringify({ __flowRecorder: true, event, ...data })
    );
  }

  function sendStep(step) {
    stepCount++;
    sessionStorage.setItem("__fr_stepCount", String(stepCount));
    send("step", { step });
  }

  // ─── Label resolution helpers ───────────────────────────────────────

  /**
   * Strip trailing parenthetical counters from link/button text.
   * e.g. "Upcoming (4)" → "Upcoming", "All (50)" → "All",
   *      "Start session (25 cases)" → "Start session"
   * These are dynamic counts that change between sessions.
   * Does NOT strip non-count parentheticals like "(Morning)" or
   * "(at least 6 months ago)".
   * Pattern: matches (N) or (N word) where N is a number at the start.
   */
  function stripDynamicCounts(text) {
    return text.replace(/\s+\(\d+(?:\s+\w+)?\)\s*$/, "").trim();
  }

  /**
   * Get the accessible name for a link or button.
   * Priority: aria-label → aria-labelledby → visible text content.
   * Strips trailing dynamic counts like " (4)" to avoid brittle matches.
   */
  function getAccessibleName(el) {
    if (!el) return "";

    let name = "";

    const ariaLabel = el.getAttribute("aria-label");
    if (ariaLabel) {
      name = ariaLabel.trim().substring(0, 60);
    } else {
      const labelledBy = el.getAttribute("aria-labelledby");
      if (labelledBy) {
        const labelEl = document.getElementById(labelledBy);
        if (labelEl) {
          name = labelEl.textContent.trim().substring(0, 60);
        }
      }
    }

    if (!name) {
      // For inputs with value (submit buttons)
      if (el.tagName === "INPUT" && el.value) {
        name = el.value.trim().substring(0, 60);
      } else {
        const text = el.textContent || "";
        // Collapse whitespace and trim
        name = text.replace(/\s+/g, " ").trim().substring(0, 60);
      }
    }

    return stripDynamicCounts(name);
  }

  /**
   * Get the associated label text for a form input.
   * Priority: input.labels[0] → aria-label → walk up for label patterns.
   */
  function getAssociatedLabel(input) {
    if (!input) return "";

    // HTML label association
    if (input.labels && input.labels.length > 0) {
      return input.labels[0].textContent.replace(/\s+/g, " ").trim().substring(0, 60);
    }

    // aria-label
    const ariaLabel = input.getAttribute("aria-label");
    if (ariaLabel) return ariaLabel.trim().substring(0, 60);

    // aria-labelledby
    const labelledBy = input.getAttribute("aria-labelledby");
    if (labelledBy) {
      const labelEl = document.getElementById(labelledBy);
      if (labelEl) return labelEl.textContent.replace(/\s+/g, " ").trim().substring(0, 60);
    }

    // Walk up for NHS prototype patterns
    const id = input.getAttribute("id");
    if (id) {
      const labelFor = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      if (labelFor) return labelFor.textContent.replace(/\s+/g, " ").trim().substring(0, 60);
    }

    // Look for nearby .nhsuk-label or .nhsuk-fieldset__legend within form group
    const group = input.closest(
      ".nhsuk-form-group, .govuk-form-group, .nhsuk-radios__item, .nhsuk-checkboxes__item, .govuk-radios__item, .govuk-checkboxes__item"
    );
    if (group) {
      const label = group.querySelector(
        ".nhsuk-label, .govuk-label, .nhsuk-fieldset__legend, .govuk-fieldset__legend, label"
      );
      if (label) return label.textContent.replace(/\s+/g, " ").trim().substring(0, 60);
    }

    return "";
  }

  /**
   * Build a CSS selector for an element.
   * Priority: #id → [name="..."] → class-based → nth-child path.
   */
  function buildSelector(el) {
    if (!el || el === document.body || el === document.documentElement) {
      return "body";
    }

    // ID
    if (el.id) {
      return `#${CSS.escape(el.id)}`;
    }

    // name attribute (common for form elements)
    const name = el.getAttribute("name");
    if (name) {
      const tag = el.tagName.toLowerCase();
      const selector = `${tag}[name="${CSS.escape(name)}"]`;
      if (document.querySelectorAll(selector).length === 1) {
        return selector;
      }
    }

    // Class-based (pick the most specific-looking class)
    const classes = Array.from(el.classList).filter(
      (c) => !c.startsWith("js-") && !c.startsWith("nhsuk-") && !c.startsWith("govuk-")
    );
    if (classes.length > 0) {
      const tag = el.tagName.toLowerCase();
      const selector = `${tag}.${CSS.escape(classes[0])}`;
      if (document.querySelectorAll(selector).length === 1) {
        return selector;
      }
    }

    // Fallback: nth-child path (last 3 levels)
    const parts = [];
    let current = el;
    for (let i = 0; i < 3 && current && current !== document.body; i++) {
      const tag = current.tagName.toLowerCase();
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(
          (c) => c.tagName === current.tagName
        );
        if (siblings.length > 1) {
          const index = siblings.indexOf(current) + 1;
          parts.unshift(`${tag}:nth-of-type(${index})`);
        } else {
          parts.unshift(tag);
        }
      } else {
        parts.unshift(tag);
      }
      current = parent;
    }

    return parts.join(" > ");
  }

  // ─── Toolbar ────────────────────────────────────────────────────────

  function createToolbar() {
    const bar = document.createElement("div");
    bar.className = "flow-recorder-toolbar";
    bar.style.cssText = [
      "position: fixed",
      "top: 0",
      "left: 0",
      "right: 0",
      "height: 40px",
      "z-index: 999999",
      "display: flex",
      "align-items: center",
      "padding: 0 12px",
      "gap: 10px",
      "font-family: -apple-system, BlinkMacSystemFont, sans-serif",
      "font-size: 13px",
      "color: #fff",
      "box-shadow: 0 2px 8px rgba(0,0,0,0.2)",
    ].join(";");

    updateToolbarColor(bar);

    // Phase indicator
    const phaseLabel = document.createElement("span");
    phaseLabel.id = "__fr-phase";
    phaseLabel.style.cssText = "font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px;";
    phaseLabel.textContent = phase;
    bar.appendChild(phaseLabel);

    // Step counter
    const counter = document.createElement("span");
    counter.id = "__fr-counter";
    counter.style.cssText = "opacity: 0.8; margin-left: 4px;";
    counter.textContent = `(${stepCount} steps)`;
    bar.appendChild(counter);

    // Spacer
    const spacer = document.createElement("span");
    spacer.style.flex = "1";
    bar.appendChild(spacer);

    // Begin mapping button (only in setup phase)
    const beginBtn = document.createElement("button");
    beginBtn.id = "__fr-begin";
    beginBtn.textContent = "Begin mapping";
    beginBtn.style.cssText = buttonStyle("#fff", "#2e7d32");
    beginBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      phase = "map";
      sessionStorage.setItem("__fr_phase", "map");
      send("phase", { phase: "map" });
      updateUI();
    });
    bar.appendChild(beginBtn);

    // Capture page button
    const captureBtn = document.createElement("button");
    captureBtn.id = "__fr-capture";
    captureBtn.textContent = "Capture page";
    captureBtn.style.cssText = buttonStyle("#fff", "#1565c0");
    captureBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      send("capture");
      flashCapture();
    });
    bar.appendChild(captureBtn);

    // Finish button
    const finishBtn = document.createElement("button");
    finishBtn.textContent = "Finish";
    finishBtn.style.cssText = buttonStyle("#fff", "#c62828");
    finishBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      send("done");
    });
    bar.appendChild(finishBtn);

    document.body.appendChild(bar);

    // Push page content down so toolbar doesn't overlay it
    document.body.style.marginTop = "40px";
  }

  function buttonStyle(color, bg) {
    return [
      `background: ${bg}`,
      `color: ${color}`,
      "border: none",
      "border-radius: 4px",
      "padding: 4px 10px",
      "font-size: 12px",
      "font-weight: 600",
      "cursor: pointer",
      "line-height: 1.4",
    ].join(";");
  }

  function updateToolbarColor(bar) {
    bar = bar || document.querySelector(".flow-recorder-toolbar");
    if (!bar) return;
    bar.style.background = phase === "setup"
      ? "linear-gradient(135deg, #e65100, #f57c00)"
      : "linear-gradient(135deg, #2e7d32, #43a047)";
  }

  function updateUI() {
    const phaseLabel = document.getElementById("__fr-phase");
    if (phaseLabel) phaseLabel.textContent = phase;

    const counter = document.getElementById("__fr-counter");
    if (counter) counter.textContent = `(${stepCount} steps)`;

    const beginBtn = document.getElementById("__fr-begin");
    if (beginBtn) beginBtn.style.display = phase === "map" ? "none" : "";

    updateToolbarColor();
  }

  function flashCapture() {
    const btn = document.getElementById("__fr-capture");
    if (!btn) return;
    const original = btn.textContent;
    btn.textContent = "Captured!";
    btn.style.background = "#4caf50";
    setTimeout(() => {
      btn.textContent = original;
      btn.style.background = "#1565c0";
    }, 800);
  }

  // ─── Interaction capture ────────────────────────────────────────────

  /**
   * Click handler (capture phase).
   * Resolves clicked element to a step type.
   */
  function handleClick(event) {
    const target = event.target;

    // Ignore toolbar clicks
    if (target.closest(".flow-recorder-toolbar")) return;

    // 1. Link (<a href="...">)
    const link = target.closest("a[href]");
    if (link) {
      const name = getAccessibleName(link);
      if (name) {
        sendStep({ type: "clickLink", text: name });
      } else {
        sendStep({ type: "click", selector: buildSelector(link) });
      }
      updateUI();
      return;
    }

    // 2. Button / submit
    const button = target.closest('button, input[type="submit"], input[type="button"]');
    if (button) {
      const name = getAccessibleName(button);
      if (name) {
        sendStep({ type: "clickButton", text: name });
      } else {
        sendStep({ type: "click", selector: buildSelector(button) });
      }
      updateUI();
      return;
    }

    // 3. Radio button
    const radio = target.closest('input[type="radio"]');
    if (radio) {
      const label = getAssociatedLabel(radio);
      if (label) {
        sendStep({ type: "choose", label });
      } else {
        sendStep({ type: "click", selector: buildSelector(radio) });
      }
      updateUI();
      return;
    }

    // 4. Checkbox
    const checkbox = target.closest('input[type="checkbox"]');
    if (checkbox) {
      const label = getAssociatedLabel(checkbox);
      if (label) {
        sendStep({ type: "checkByLabel", label });
      } else {
        sendStep({ type: "check", selector: buildSelector(checkbox) });
      }
      updateUI();
      return;
    }

    // 5. Details/summary
    const summary = target.closest("summary");
    if (summary) {
      sendStep({ type: "click", selector: buildSelector(summary) });
      updateUI();
      return;
    }

    // 6. Fallback — only capture if element looks interactive
    const interactive = target.closest(
      '[role="button"], [role="link"], [role="tab"], [onclick], [tabindex]'
    );
    if (interactive) {
      sendStep({ type: "click", selector: buildSelector(interactive) });
      updateUI();
    }
    // Non-interactive clicks (e.g. clicking text) are ignored
  }

  /**
   * Change handler — captures form field values.
   */
  function handleChange(event) {
    const target = event.target;

    // Ignore toolbar
    if (target.closest(".flow-recorder-toolbar")) return;

    // Ignore radio/checkbox — handled by click
    if (target.type === "radio" || target.type === "checkbox") return;

    // Select element
    if (target.tagName === "SELECT") {
      const selectedOption = target.options[target.selectedIndex];
      const optionText = selectedOption ? selectedOption.textContent.trim() : target.value;
      const label = getAssociatedLabel(target);
      if (label) {
        sendStep({ type: "selectFrom", label, value: optionText });
      } else {
        sendStep({ type: "select", selector: buildSelector(target), value: target.value });
      }
      updateUI();
      return;
    }

    // Text input / textarea
    if (
      target.tagName === "TEXTAREA" ||
      (target.tagName === "INPUT" && !["submit", "button", "hidden", "file"].includes(target.type))
    ) {
      const value = target.value;
      if (!value) return; // Ignore empty values

      const label = getAssociatedLabel(target);
      if (label) {
        sendStep({ type: "fillIn", label, value });
      } else {
        sendStep({ type: "fill", selector: buildSelector(target), value });
      }
      updateUI();
      return;
    }
  }

  // ─── SPA routing monkey-patch ───────────────────────────────────────

  function patchHistoryMethod(method) {
    const original = history[method];
    history[method] = function () {
      const result = original.apply(this, arguments);
      send("navigation", { url: location.pathname });
      return result;
    };
  }

  patchHistoryMethod("pushState");
  patchHistoryMethod("replaceState");

  window.addEventListener("popstate", () => {
    send("navigation", { url: location.pathname });
  });

  // ─── Initialize ─────────────────────────────────────────────────────

  // Use capture phase for click to intercept before default behavior
  document.addEventListener("click", handleClick, true);
  document.addEventListener("change", handleChange, true);

  // Toolbar — wait for DOM if needed
  if (document.body) {
    createToolbar();
  } else {
    document.addEventListener("DOMContentLoaded", createToolbar);
  }
})();
