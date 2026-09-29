(() => {
  // Fields that must never be auto-filled — always routed to the user.
  const JUDGMENT_PATTERNS = [
    /sponsor/i, /authoriz.*work/i, /relocat/i, /expected salary/i, /salary expectation/i,
    /why (do you want|are you interested)/i, /why should we hire/i, /cover letter/i,
    /tell us about yourself/i, /disability/i, /veteran/i, /race|ethnicity|gender identity/i,
  ];

  let profile = {};
  let learned = {}; // { "lowercased label text": { field, examples: [...] } }
  let detected = []; // [{ el, ctx, field, confidence, status }]
  let panelView = "fields"; // "fields" | "storage" | "bulk-review"
  let bulkReviewFilter = null;
  let flowState = "stage0";

  // ---------- Storage migration ----------
  function migrateProfile(raw) {
    if (!raw || typeof raw !== "object") return {};
    const migrated = {};
    for (const [key, val] of Object.entries(raw)) {
      if (val && typeof val === "object" && !Array.isArray(val)) {
        // Nested section object (e.g. { personal: { first_name: "Gagan" } })
        for (const [subKey, subVal] of Object.entries(val)) {
          if (Array.isArray(subVal)) {
            migrated[subKey] = subVal;
          } else if (subVal !== null && subVal !== undefined && subVal !== "") {
            migrated[subKey] = migrated[subKey] || [];
            if (!migrated[subKey].includes(String(subVal))) {
              migrated[subKey].push(String(subVal));
            }
          }
        }
      } else if (Array.isArray(val)) {
        migrated[key] = val;
      } else if (val !== null && val !== undefined && val !== "" && key !== "unknown") {
        migrated[key] = migrated[key] || [];
        if (!migrated[key].includes(String(val))) {
          migrated[key].push(String(val));
        }
      }
    }
    return migrated;
  }

  function valueFor(field) {
    const vals = profile[field];
    if (!vals || !Array.isArray(vals) || vals.length === 0) return null;
    if (vals.length === 1) return vals[0];
    return null; // multiple values — needs user review
  }

  function valuesFor(field) {
    const vals = profile[field];
    if (!vals || !Array.isArray(vals)) return [];
    return vals;
  }

  // ---------- Init ----------
  async function init() {
    const store = await chrome.storage.local.get({ profile: {}, learned_fields: {}, enabled: true });
    if (!store.enabled) return;

    // In iframes, only activate if this frame actually has form inputs
    if (window !== window.top) {
      const sel = 'input[type="text"], input[type="email"], input[type="tel"], input[type="number"], input:not([type]), textarea, select';
      const hasInputs = document.querySelectorAll(sel).length > 0;
      if (!hasInputs) return;
    }

    // Migrate profile from old format (single values) to new format (arrays)
    const rawProfile = store.profile;
    const needsMigration = Object.values(rawProfile).some(v => v !== null && v !== undefined && !Array.isArray(v));
    if (needsMigration) {
      profile = migrateProfile(rawProfile);
      await chrome.storage.local.set({ profile });
    } else {
      profile = rawProfile;
    }

    learned = store.learned_fields;
    buildOrb();
    
    try {
      const cfgResp = await chrome.runtime.sendMessage({ type: "JOBAGENT_GET_CONFIG" });
      if (cfgResp && cfgResp.cfg) {
        renderPanel(cfgResp.cfg);
      }
    } catch (e) {
      console.error("JobAgent init config error:", e);
    }
  }

  // ---------- Field extraction ----------
  function getLabelFor(input) {
    if (input.labels && input.labels.length) return input.labels[0].innerText.trim();
    // No fuzzy matching fallback, rely on html_bubble instead.
    return null;
  }

  function extractContext(input) {
    const label = getLabelFor(input);
    const ctx = {
      tag: input.tagName.toLowerCase(),
      type: input.type || "text",
      label: label,
      placeholder: input.placeholder || null,
      name: input.name || null,
      id: input.id || null,
      aria_label: input.getAttribute("aria-label"),
    };

    if (!label && input.parentElement) {
      let container = input.parentElement;
      
      const fieldset = input.closest('fieldset');
      if (fieldset) {
        container = fieldset;
      } else {
        while (container && container.parentElement && 
               !['FORM', 'BODY', 'MAIN', 'ARTICLE'].includes(container.tagName)) {
          
          // Stop if the next parent contains too many inputs (meaning it's a page-level or form-level wrapper)
          const parentInputs = container.parentElement.querySelectorAll('input, select, textarea').length;
          if (parentInputs > 5) {
            break;
          }
          
          container = container.parentElement;
        }
      }
      
      // 1. Mark the target
      input.setAttribute('data-jobagent-target', 'true');
      const clone = container.cloneNode(true);
      input.removeAttribute('data-jobagent-target');
      
      // 2. The Sniper Cut: Remove all OTHER inputs to prevent AI distraction
      clone.querySelectorAll("input, select, textarea").forEach(el => {
        if (!el.hasAttribute('data-jobagent-target')) {
          el.remove();
        }
      });
      
      // 3. Clean up remaining noise (SVG, scripts, massive <option> lists)
      clone.querySelectorAll("script, style, svg, path, button").forEach(e => e.remove());
      clone.querySelectorAll("select").forEach(sel => {
        sel.innerHTML = ''; 
      });
      
      // 4. Minify
      let bubble = clone.outerHTML.replace(/\s+/g, ' ').replace(/>\s+</g, '><').trim();
      
      // 5. Inject a native hints comment for the AI
      let hints = [];
      if (ctx.id) hints.push(`id="${ctx.id}"`);
      if (ctx.name) hints.push(`name="${ctx.name}"`);
      if (ctx.aria_label) hints.push(`aria-label="${ctx.aria_label}"`);
      if (ctx.placeholder) hints.push(`placeholder="${ctx.placeholder}"`);
      
      if (hints.length > 0) {
        bubble = `<!-- Target Field Hints: ${hints.join(", ")} -->\n${bubble}`;
      }
      
      ctx.html_bubble = bubble.length < 1500 ? bubble : bubble.substring(0, 1500) + "...";
    }
    return ctx;
  }

  function fieldableInputs() {
    const sel = 'input[type="text"], input[type="email"], input[type="tel"], input[type="number"], input[type="checkbox"], input[type="radio"], input:not([type]), textarea, select, [role="combobox"]';
    return Array.from(document.querySelectorAll(sel)).filter((el) => {
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0 || el.disabled || el.type === "hidden") return false;
      const style = window.getComputedStyle(el);
      if (style.visibility === "hidden" || style.opacity === "0" || style.clip === "rect(0px, 0px, 0px, 0px)") return false;
      if (el.className && typeof el.className === 'string' && el.className.includes("select2-focusser")) return false;
      return true;
    });
  }

  function isJudgmentField(ctx) {
    const text = [ctx.label, ctx.placeholder, ctx.aria_label, ctx.nearby_text].filter(Boolean).join(" ");
    return JUDGMENT_PATTERNS.some((re) => re.test(text));
  }

  // ---------- Matching ----------
  function localMatch(ctx) {
    const text = (ctx.label || ctx.aria_label || ctx.placeholder || ctx.name || "").toLowerCase().trim();
    if (!text) return null;
    if (learned[text]) return { field: learned[text].field, confidence: 0.99, source: "learned" };
    for (const key of Object.keys(learned)) {
      if (text.includes(key) || key.includes(text)) {
        return { field: learned[key].field, confidence: 0.85, source: "learned-fuzzy" };
      }
    }
    return null;
  }

  async function aiMatch(ctx) {
    const resp = await chrome.runtime.sendMessage({
      type: "JOBAGENT_CLASSIFY",
      fieldContext: ctx,
      profileFields: CANONICAL_FIELDS.filter((f) => f !== "unknown"),
    });
    if (!resp?.ok) throw new Error(resp?.error || "classification failed");
    return resp.result;
  }

  // ---------- Fill ----------
  function fillInput(input, value) {
    if (value === undefined || value === null || value === "") return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    const taSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
    if (input.type === "checkbox" || input.type === "radio") {
      const v = String(value).toLowerCase();
      input.checked = (v === "true" || v === "yes" || v === "1" || v === input.value.toLowerCase());
    } else if (input.tagName === "SELECT") {
      const opt = Array.from(input.options).find(
        (o) => o.value.toLowerCase() === String(value).toLowerCase() || o.text.toLowerCase() === String(value).toLowerCase()
      );
      if (!opt) return false;
      input.value = opt.value;
    } else if (input.tagName === "TEXTAREA" && taSetter) {
      taSetter.call(input, value);
    } else if (input.tagName === "INPUT" && setter) {
      setter.call(input, value);
    } else {
      input.value = value;
    }
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.classList.add("jobagent-filled");
    return true;
  }





  async function captureAndLearn() {
    const inputs = fieldableInputs();
    const captured = [];
    const bubbles = [];
    const bubbleIndices = [];
    
    for (const el of inputs) {
      let val = "";
      if (el.type === "checkbox" || el.type === "radio") val = el.checked ? "true" : "false";
      else val = el.value?.trim();
      
      if (!val || val === "false") continue;
      if (el.type === "password" || el.type === "file") continue;
      
      const ctx = extractContext(el);
      const extractedName = ctx.label || null;
      captured.push({ ctx, value: val, extractedName });
      
      if (!extractedName && ctx.html_bubble) {
        bubbles.push(ctx.html_bubble);
        bubbleIndices.push(captured.length - 1);
      }
    }
    
    if (captured.length === 0) return { ok: true, count: 0 };
    console.log(`[JobAgent] Captured ${captured.length} filled fields on submit.`);

    if (bubbles.length > 0) {
      const matchResp = await chrome.runtime.sendMessage({ type: "JOBAGENT_MATCH_BUBBLES", bubbles });
      if (matchResp?.ok) {
        for (let i = 0; i < matchResp.field_names.length; i++) {
          let aiName = matchResp.field_names[i];
          if (aiName && !aiName.trim().endsWith(':')) {
            aiName = aiName.trim() + ' :';
          }
          captured[bubbleIndices[i]].extractedName = aiName;
        }
      }
    }

    const finalNames = [];
    const finalValues = [];
    for (const c of captured) {
      const name = c.extractedName || c.ctx.placeholder || c.ctx.name || c.ctx.aria_label || "unknown field";
      finalNames.push(name);
      finalValues.push(c.value);
    }

    const resp = await chrome.runtime.sendMessage({
      type: "JOBAGENT_LEARN_SUBMISSION",
      fieldNames: finalNames,
      values: finalValues,
      currentProfile: profile,
    });
    
    return { ok: resp?.ok, count: captured.length, error: resp?.error };
  }

  // ---------- Scan / classify pipeline ----------
  let previousAIResults = new Map();
  let scanning = false;
  let errorCooldownUntil = 0; // timestamp — don't retry AI calls until this time

  async function scan() {
    if (scanning) return;
    scanning = true;
    try {
      let cfgResp;
      try {
        cfgResp = await chrome.runtime.sendMessage({ type: "JOBAGENT_GET_CONFIG" });
      } catch (err) {
        return; 
      }
      if (!cfgResp || !cfgResp.cfg) return;
      const cfg = cfgResp.cfg;
      const inputs = fieldableInputs();

      for (const r of detected) {
        if (r.status !== "pending" && r.status !== "error" && r.status !== "judgment") {
          const text = (r.ctx.label || r.ctx.aria_label || r.ctx.placeholder || r.ctx.name || "").trim();
          if (text) previousAIResults.set(text, { field: r.field, confidence: r.confidence, status: r.status });
        }
      }

      detected = [];
      const pendingRows = [];
      const bubbles = [];
      const bubbleRowIndices = [];

      // Step 1: Matching (Cheap Match)
      for (const el of inputs) {
        const ctx = extractContext(el);
        if (isJudgmentField(ctx)) {
          detected.push({ el, ctx, field: "unknown", confidence: 0, status: "judgment", extractedName: "unknown" });
          continue;
        }

        const row = { el, ctx, field: null, confidence: null, status: "pending", extractedName: ctx.label || null };
        detected.push(row);
        
        if (!row.extractedName && ctx.html_bubble) {
          bubbles.push(ctx.html_bubble);
          bubbleRowIndices.push(detected.length - 1);
        }
        pendingRows.push(row);
      }

      if (detected.length > 0 && window !== window.top) {
        document.getElementById("jobagent-root").style.display = "block";
      }
      renderPanel(cfg);

      if (pendingRows.length === 0) return;

      if (Date.now() < errorCooldownUntil) {
        for (const row of pendingRows) row.status = "error";
        renderPanel(cfg);
        return;
      }

      try {
        // Step 1.5: AI Matching (for missing labels)
        if (bubbles.length > 0) {
          const matchResp = await chrome.runtime.sendMessage({ type: "JOBAGENT_MATCH_BUBBLES", bubbles });
          if (!matchResp?.ok) throw new Error(matchResp?.error);
          for (let i = 0; i < matchResp.field_names.length; i++) {
            const rowIndex = bubbleRowIndices[i];
            let aiName = matchResp.field_names[i];
            if (aiName && !aiName.trim().endsWith(':')) {
              aiName = aiName.trim() + ' :';
            }
            detected[rowIndex].extractedName = aiName;
          }
        }

        // Fill in missing labels with placeholders as absolute fallback
        for (const row of pendingRows) {
          if (!row.extractedName) {
            row.extractedName = row.ctx.placeholder || row.ctx.name || row.ctx.aria_label || "unknown field";
          }
        }

        // Check local cache to save tokens
        const fieldsToPair = [];
        const pairRowIndices = [];
        for (let i = 0; i < detected.length; i++) {
          const row = detected[i];
          if (row.status !== "pending") continue;
          
          const prev = previousAIResults.get(row.extractedName);
          if (prev) {
            row.field = prev.field;
            row.confidence = prev.confidence;
            row.status = prev.status;
          } else {
            fieldsToPair.push(row.extractedName);
            pairRowIndices.push(i);
          }
        }

        // Step 2: Semantic Pairing
        if (fieldsToPair.length > 0) {
          const pairResp = await chrome.runtime.sendMessage({
            type: "JOBAGENT_PAIR_FIELDS",
            fieldNames: fieldsToPair,
            profileKeys: Object.keys(profile),
          });
          if (!pairResp?.ok) throw new Error(pairResp?.error);
          
          for (let i = 0; i < pairResp.mappings.length; i++) {
            const mapping = pairResp.mappings[i];
            const rowIndex = pairRowIndices[i];
            const row = detected[rowIndex];
            
            if (mapping.key === "unknown" || mapping.confidence < (cfg.thAuto / 100)) {
              row.field = "unknown";
              row.confidence = 0;
              row.status = "unmapped";
            } else {
              row.field = mapping.key;
              row.confidence = mapping.confidence;
              row.status = "mapped";
            }
            
            previousAIResults.set(row.extractedName, { field: row.field, confidence: row.confidence, status: row.status });
          }
        }

      } catch (e) {
        console.error("Pipeline error:", e);
        for (const row of pendingRows) if (row.status === "pending") row.status = "error";
        errorCooldownUntil = Date.now() + 30000;
      }
      
      flowState = "stage1";
      renderPanel(cfg);
    } finally {
      scanning = false;
    }
  }

  // ---------- Auto Fill (redesigned) ----------
  function clearAllFilled() {
    for (const row of detected) {
      if (row.status === "filled") {
        if (row.el.type === "checkbox" || row.el.type === "radio") {
          row.el.checked = false;
        } else if (row.el.tagName === "SELECT") {
          row.el.value = "";
        } else {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
          const taSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
          if (row.el.tagName === "TEXTAREA" && taSetter) taSetter.call(row.el, "");
          else if (row.el.tagName === "INPUT" && setter) setter.call(row.el, "");
          else row.el.value = "";
        }
        row.el.dispatchEvent(new Event("input", { bubbles: true }));
        row.el.dispatchEvent(new Event("change", { bubbles: true }));
        row.el.classList.remove("jobagent-filled");
        row.status = "mapped";
      }
    }
  }

  function autoFill() {
    for (const row of detected) {
      if (row.status === "judgment" || row.status === "filled" || row.status === "skipped") continue;
      
      if (row.field === "unknown" || !row.field) {
        row.status = "unmapped";
        continue;
      }

      const vals = valuesFor(row.field);
      if (vals.length === 0) {
        row.status = "no-data";
      } else if (vals.length === 1) {
        if (fillInput(row.el, vals[0])) {
          row.status = "filled";
        }
      } else {
        row.status = "review";
      }
    }
    
    flowState = "stage3";
    renderPanelCached();
  }

  // ---------- UI ----------
  let panelEl, orbEl, cachedCfg;

  function buildOrb() {
    const root = document.createElement("div");
    root.id = "jobagent-root";
    if (window !== window.top) {
      root.style.display = "none";
    }
    root.innerHTML = `
      <div id="jobagent-panel" style="text-align: left;"></div>
      <div id="jobagent-orb">\u2726</div>
    `;
    document.body.appendChild(root);
    orbEl = root.querySelector("#jobagent-orb");
    panelEl = root.querySelector("#jobagent-panel");
    orbEl.addEventListener("click", () => panelEl.classList.toggle("open"));
  }

  function renderPanelCached() {
    if (cachedCfg) renderPanel(cachedCfg);
  }

  function renderPanel(cfg) {
    cachedCfg = cfg;
    if (panelView === "storage") {
      renderStorageView();
      return;
    }
    if (panelView === "bulk-review") {
      renderBulkReviewView();
      return;
    }

    const total = detected.length;
    const pending = detected.filter((r) => r.status === "pending").length;
    const unmappedCount = detected.filter(r => r.status === "unmapped" || r.field === "unknown" || !r.field).length;
    const reviewCount = detected.filter(r => r.status === "review").length;
    const canFillCount = detected.filter(r => r.status === "mapped").length;
    const filledCount = detected.filter(r => r.status === "filled").length;
    
    orbEl.classList.toggle("busy", pending > 0);

    // State transitions
    if (flowState === "stage1" && unmappedCount === 0) {
      flowState = "stage2";
    }

    let labelCounts = {};
    const rows = detected
      .map((r, i) => {
        let label = r.extractedName || r.ctx.label || r.ctx.aria_label || r.ctx.placeholder || r.ctx.name || "(unlabeled field)";
        const baseLabel = label.toLowerCase().trim();
        labelCounts[baseLabel] = (labelCounts[baseLabel] || 0) + 1;
        if (labelCounts[baseLabel] > 1) {
          label = `${label} ${labelCounts[baseLabel]}`;
        }

        let statusBadge = "";
        let cls = "";
        
        if (r.status === "filled") {
          statusBadge = `<span style="color: #27ae60; font-weight: bold;">filled</span>`; cls = "jobagent-badge-auto";
        } else if (r.status === "review" || r.status === "pending-review") {
          statusBadge = `<span style="color: #f39c12; font-weight: bold;">review</span>`; cls = "jobagent-badge-pending";
        } else if (r.status === "unmapped" || r.status === "ask") {
          statusBadge = `<span style="color: #e74c3c; font-weight: bold;">unmapped</span>`; cls = "jobagent-badge-ask";
        } else if (r.status === "mapped") {
          statusBadge = flowState === "stage3" ? "mapped" : `${Math.round(r.confidence * 100)}%`;
          cls = "jobagent-badge-auto";
        } else if (r.status === "no-data") {
          statusBadge = "no data"; cls = "jobagent-badge-nodata";
        } else if (r.status === "judgment") {
          statusBadge = "judgment"; cls = "jobagent-badge-suggest";
        } else if (r.status === "error") {
          statusBadge = "error"; cls = "jobagent-badge-ask";
        } else if (r.status === "skipped") {
          statusBadge = "skipped"; cls = "jobagent-badge-nodata";
        } else {
          statusBadge = escapeHtml(r.status);
          cls = "jobagent-badge-nodata";
        }

        return `<div class="jobagent-field-row" style="cursor: default;">
          <span class="jobagent-field-label" title="${escapeHtml(label)}">${escapeHtml(label)}</span>
          <span class="${cls}" style="flex-shrink: 0; margin-left: 12px; text-align: right; white-space: nowrap;">${statusBadge}</span>
        </div>`;
      })
      .join("");

    let stageHtml = "";
    if (pending > 0) {
      stageHtml = `
        <div style="text-align: center; padding: 12px; color: #666; font-size: 13px;">
          Scanning page...
        </div>
      `;
    } else if (flowState === "stage0") {
      stageHtml = `
        <div style="margin-bottom: 12px; padding: 12px; border: 1px solid #ccc; border-radius: 6px; background: #f9f9f9; text-align: center;">
          <div style="margin-bottom: 12px; font-weight: 500; font-size: 13px;">Ready to scan forms on this page?</div>
          <button class="jobagent-btn" id="jobagent-start-scan-btn" style="width: 100%; margin: 0; background: #27ae60; border-color: #2ecc71;">Scan Page</button>
        </div>
      `;
    } else if (flowState === "stage1") {
      stageHtml = `
        <div style="margin-bottom: 12px; padding: 12px; border: 1px solid #ccc; border-radius: 6px; background: #f9f9f9;">
          <div style="margin-bottom: 12px; font-weight: 500; font-size: 13px; text-align: center;">Continue mapping unresolved fields?</div>
          <div style="display: flex; gap: 8px;">
            <button class="jobagent-btn" id="jobagent-map-stage1-btn" style="flex: 1; margin: 0; background: #3498db; border-color: #2980b9;">Map fields</button>
            <button class="jobagent-btn secondary" id="jobagent-skip-map-btn" style="flex: 1; margin: 0;">Don't Map</button>
          </div>
        </div>
      `;
    } else if (flowState === "stage2") {
      stageHtml = `
        <div style="font-size: 11px; margin-bottom: 8px; color: #555; text-align: center;">
          <b>${canFillCount}</b> fields can be autofilled &middot; <b>${unmappedCount}</b> fields need mapping
        </div>
        <div class="jobagent-btn-row">
          <button class="jobagent-btn" id="jobagent-fill-btn" style="flex: 1; margin-bottom: 0;">Auto Fill</button>
        </div>
        ${unmappedCount > 0 ? `<div style="text-align: right; margin-top: 6px;"><a href="#" id="jobagent-map-link" style="color: #3498db; font-size: 12px; text-decoration: underline; cursor: pointer;">Map ${unmappedCount} fields?</a></div>` : ""}
      `;
    } else if (flowState === "stage3") {
      stageHtml = `
        <div style="font-size: 11px; margin-bottom: 8px; color: #555; text-align: center;">
          <b>${filledCount}</b> fields autofilled &middot; <b>${reviewCount}</b> conflicts need review
        </div>
        ${reviewCount > 0 ? `
          <div class="jobagent-btn-row">
            <button class="jobagent-btn" id="jobagent-resolve-btn" style="width: 100%; margin-bottom: 0; background: #e67e22; border-color: #d35400;">Resolve conflicts</button>
          </div>
        ` : ""}
        ${unmappedCount > 0 ? `<div style="text-align: right; margin-top: 6px;"><a href="#" id="jobagent-map-link" style="color: #3498db; font-size: 12px; text-decoration: underline; cursor: pointer;">Map ${unmappedCount} fields?</a></div>` : ""}
        <div class="jobagent-btn-row" style="margin-top: 12px; gap: 8px;">
          <button class="jobagent-btn secondary" id="jobagent-exit-btn" style="flex: 1; margin: 0;">Exit</button>
          <button class="jobagent-btn" id="jobagent-clear-all-btn" style="flex: 1; margin: 0; background: #e74c3c; border-color: #c0392b;">Clear All</button>
        </div>
      `;
    }

    panelEl.innerHTML = `
      <h3 style="color: #6366f1; justify-content: flex-start; gap: 8px;">
        JobAgent
        ${pending > 0 ? `<div class="jobagent-spinner dark"></div>` : ""}
      </h3>
      ${stageHtml}
      
      <div class="jobagent-btn-row" style="margin-top: 12px;">
        <button class="jobagent-btn secondary half" id="jobagent-learn-page-btn" style="flex: 1;">Learn Fields</button>
        <button class="jobagent-btn secondary half" id="jobagent-storage-btn" style="flex: 1;">View Storage</button>
        <button class="jobagent-btn secondary half" id="jobagent-options-btn" style="flex: 0.5;">\u2699</button>
        <button class="jobagent-btn secondary half" id="jobagent-rescan-btn" style="flex: 0.5;">\u21BB</button>
      </div>
      <div class="jobagent-field-list" style="margin-top: 12px;">${rows}</div>
    `;

    // Event Listeners
    if (flowState === "stage0") {
      panelEl.querySelector("#jobagent-start-scan-btn")?.addEventListener("click", () => {
        scan();
      });
    }

    if (flowState === "stage1") {
      panelEl.querySelector("#jobagent-map-stage1-btn")?.addEventListener("click", () => {
        bulkReviewFilter = "unmapped";
        panelView = "bulk-review";
        renderPanelCached();
      });
      panelEl.querySelector("#jobagent-skip-map-btn")?.addEventListener("click", () => {
        flowState = "stage2";
        renderPanelCached();
      });
    }

    if (flowState === "stage2") {
      panelEl.querySelector("#jobagent-fill-btn")?.addEventListener("click", autoFill);
    }

    if (flowState === "stage3") {
      if (reviewCount > 0) {
        panelEl.querySelector("#jobagent-resolve-btn")?.addEventListener("click", () => {
          bulkReviewFilter = "review";
          panelView = "bulk-review";
          renderPanelCached();
        });
      }
      panelEl.querySelector("#jobagent-exit-btn")?.addEventListener("click", () => {
        detected = [];
        flowState = "stage0";
        panelEl.classList.remove("open");
        renderPanelCached();
      });

      panelEl.querySelector("#jobagent-clear-all-btn")?.addEventListener("click", () => {
        clearAllFilled();
        flowState = "stage1";
        renderPanelCached();
      });
    }

    // Secondary Map link
    const mapLink = panelEl.querySelector("#jobagent-map-link");
    if (mapLink) {
      mapLink.addEventListener("click", (e) => {
        e.preventDefault();
        bulkReviewFilter = "unmapped";
        panelView = "bulk-review";
        renderPanelCached();
      });
    }
    
    panelEl.querySelector("#jobagent-rescan-btn").addEventListener("click", () => {
      const btn = panelEl.querySelector("#jobagent-rescan-btn");
      btn.innerHTML = `<div class="jobagent-spinner dark"></div>`;
      errorCooldownUntil = 0;
      scan();
    });
    
    panelEl.querySelector("#jobagent-learn-page-btn").addEventListener("click", async () => {
      const btn = panelEl.querySelector("#jobagent-learn-page-btn");
      btn.innerHTML = `<div class="jobagent-spinner dark"></div>`;
      const res = await captureAndLearn();
      if (!res.ok) alert("Failed to learn fields: " + (res.error || "Unknown error"));
      else alert(`Successfully learned ${res.count} fields from the page!`);
      setTimeout(() => { renderPanelCached(); }, 2000);
    });

    panelEl.querySelector("#jobagent-storage-btn").addEventListener("click", () => {
      panelView = "storage";
      renderPanelCached();
    });
    
    panelEl.querySelector("#jobagent-options-btn").addEventListener("click", () =>
      chrome.runtime.sendMessage({ type: "JOBAGENT_OPEN_OPTIONS" })
    );
  }

  function renderBulkReviewView() {
    let needsReview = detected.map((r, i) => ({ r, i }));
    if (bulkReviewFilter === "review") {
      needsReview = needsReview.filter(({ r }) => r.status === "review" || r.status === "pending-review");
    } else if (bulkReviewFilter === "unmapped") {
      needsReview = needsReview.filter(({ r }) => r.status === "unmapped" || r.field === "unknown" || !r.field);
    }

    if (needsReview.length === 0) {
      bulkReviewFilter = null;
      panelView = "main";
      renderPanelCached();
      return;
    }

    const optionsKeys = Object.keys(profile);
    
    let title = bulkReviewFilter === "review" ? "Resolve Conflicts" : "Map Fields";
    let isMapMode = bulkReviewFilter === "unmapped";
    
    let html = `
      <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px;">
        <h3 style="margin: 0;">${title} (${needsReview.length})</h3>
        <button class="jobagent-btn secondary" id="bulk-back-btn" style="margin: 0; padding: 4px 8px; font-size: 11px;">\u2190 Back</button>
      </div>
      <div style="max-height: 400px; overflow-y: auto; padding-right: 4px;">
    `;
    
    needsReview.forEach(({ r, i }) => {
      let labelStr = r.extractedName || r.ctx.label || r.ctx.aria_label || r.ctx.placeholder || r.ctx.name || "Unknown field";
      html += `<div class="jobagent-bulk-item" style="margin-bottom: 16px; border-bottom: 1px solid #eee; padding-bottom: 8px; line-height: 1.5;">`;
      html += `<div style="font-size: 13px; font-weight: 500; margin-bottom: 4px; color: #333; line-height: 1.4; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${escapeHtml(labelStr)}">${escapeHtml(labelStr)}</div>`;
      
      if (!isMapMode) {
        const vals = valuesFor(r.field);
        html += `<div style="font-size: 11px; color: #666; margin-bottom: 4px; line-height: 1.4;">Multiple values for <b>${escapeHtml(r.field)}</b></div>`;
        html += `<select id="bulk-select-${i}" data-idx="${i}" data-type="review" style="width: 100%; padding: 4px; border-radius: 4px; border: 1px solid #ccc; line-height: 1.4;">
          ${vals.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join("")}
          <option value="__skip">Don't fill</option>
        </select>`;
      } else {
        html += `<div style="font-size: 11px; color: #666; margin-bottom: 4px; line-height: 1.4;">Map to profile key</div>`;
        html += `<select id="bulk-select-${i}" data-idx="${i}" data-type="unmapped" style="width: 100%; padding: 4px; border-radius: 4px; border: 1px solid #ccc; line-height: 1.4;">
          <option value="__undecided" disabled selected>Select mapping...</option>
          ${optionsKeys.map((o) => `<option value="${o}">${o}</option>`).join("")}
          <option value="__new">-- Create new key --</option>
          <option value="__skip">Don't map (skip)</option>
        </select>`;
      }
      html += `</div>`;
    });
    
    html += `
      </div>
      <button class="jobagent-btn" id="bulk-submit-btn" style="width: 100%; margin-top: 12px; background: #e67e22; border-color: #d35400;" ${isMapMode ? "disabled" : ""}>Save</button>
    `;
    
    panelEl.innerHTML = html;
    
    panelEl.querySelector("#bulk-back-btn").addEventListener("click", () => {
      bulkReviewFilter = null;
      panelView = "main";
      renderPanelCached();
    });

    const submitBtn = panelEl.querySelector("#bulk-submit-btn");

    function checkAllDecided() {
      if (!isMapMode) return;
      const selects = panelEl.querySelectorAll("select[data-type='unmapped']");
      let allDecided = true;
      selects.forEach(sel => { if (sel.value === "__undecided") allDecided = false; });
      submitBtn.disabled = !allDecided;
    }

    panelEl.querySelectorAll("select[data-type='unmapped']").forEach(sel => {
      sel.addEventListener("change", (e) => {
        if (e.target.value === "__new") {
          let chosen = prompt("Enter a generic snake_case key name (e.g. visa_status):");
          if (chosen) {
            chosen = chosen.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
            const opt = document.createElement("option");
            opt.value = chosen;
            opt.innerText = chosen;
            e.target.insertBefore(opt, e.target.querySelector("option[value='__new']"));
            e.target.value = chosen;
          } else {
            e.target.value = "__undecided";
          }
        }
        checkAllDecided();
      });
    });
    
    submitBtn.addEventListener("click", () => {
      submitBtn.innerHTML = `<div class="jobagent-spinner"></div> Saving...`;
      submitBtn.disabled = true;
      
      needsReview.forEach(({ r, i }) => {
        const sel = panelEl.querySelector(`#bulk-select-${i}`);
        if (!sel) return;
        const chosen = sel.value;
        
        if (chosen === "__skip") {
          if (!isMapMode) r.status = "skipped";
          return;
        }
        
        if (!isMapMode) {
          fillInput(r.el, chosen);
          r.status = "filled";
        } else {
          r.field = chosen;
          r.status = "mapped";
          r.confidence = 1.0;
        }
      });
      
      bulkReviewFilter = null;
      if (isMapMode) {
        flowState = "stage2";
      }
      panelView = "main";
      renderPanelCached();
    });
  }

  // ---------- View Storage ----------
  async function renderStorageView() {
    const store = await chrome.storage.local.get({ profile: {} });
    profile = store.profile;

    const keys = Object.keys(profile).filter(k => Array.isArray(profile[k]) && profile[k].length > 0);

    let storageHtml = "";
    if (keys.length === 0) {
      storageHtml = `<div class="jobagent-storage-empty">No profile data stored yet.</div>`;
    } else {
      storageHtml = keys.map(key => {
        const vals = profile[key];
        const valItems = vals.map((v, vi) => `
          <div class="jobagent-storage-value">
            <span class="jobagent-value-text" title="${escapeHtml(v)}">${escapeHtml(v)}</span>
            <div class="jobagent-storage-actions">
              <button class="jobagent-storage-edit" data-key="${escapeHtml(key)}" data-vi="${vi}" title="Edit">\u270E</button>
              <button class="jobagent-storage-delete" data-key="${escapeHtml(key)}" data-vi="${vi}" title="Remove">\u2715</button>
            </div>
          </div>
        `).join("");
        return `
          <div class="jobagent-storage-key">
            <div class="jobagent-storage-key-name">${escapeHtml(key)}</div>
            ${valItems}
          </div>
        `;
      }).join("");
    }

    panelEl.innerHTML = `
      <h3>Stored Profile</h3>
      <div class="jobagent-btn-row">
        <button class="jobagent-btn secondary" style="flex: 1;" id="jobagent-back-btn">\u2190 Back</button>
        <button class="jobagent-btn secondary" style="flex: 1;" id="jobagent-add-data-btn">+ Add Data</button>
        <button class="jobagent-btn secondary" style="flex: 1;" id="jobagent-refresh-storage-btn">\u21BB</button>
      </div>
      <div id="jobagent-add-data-container" style="display:none; margin-top: 8px; border: 1px solid #eee; padding: 8px; border-radius: 8px;">
        <input type="text" id="add-data-key" placeholder="Key (e.g. city)" style="width:100%; margin-bottom:6px; padding:4px; font-size:12px; border:1px solid #ccc; border-radius:4px;">
        <input type="text" id="add-data-value" placeholder="Value (e.g. New York)" style="width:100%; margin-bottom:6px; padding:4px; font-size:12px; border:1px solid #ccc; border-radius:4px;">
        <button class="jobagent-btn" id="jobagent-save-data-btn" style="margin-bottom:0; font-size: 12px; padding: 4px;">Save</button>
      </div>
      <div class="jobagent-storage-list">${storageHtml}</div>
    `;

    panelEl.querySelector("#jobagent-add-data-btn").addEventListener("click", () => {
      const container = panelEl.querySelector("#jobagent-add-data-container");
      container.style.display = container.style.display === "none" ? "block" : "none";
    });

    panelEl.querySelector("#jobagent-save-data-btn").addEventListener("click", async () => {
      let key = panelEl.querySelector("#add-data-key").value.trim();
      const val = panelEl.querySelector("#add-data-value").value.trim();
      if (!key || !val) return;
      
      // Formatting logic: Strip whitespace, spaces to underscores, to lowercase snake_case
      key = key.replace(/\s+/g, '_').toLowerCase();
      
      if (!profile[key]) profile[key] = [];
      if (!Array.isArray(profile[key])) profile[key] = [String(profile[key])];
      if (!profile[key].includes(val)) {
        profile[key].push(val);
        await chrome.storage.local.set({ profile });
        renderStorageView();
      }
    });

    panelEl.querySelector("#jobagent-back-btn").addEventListener("click", () => {
      panelView = "fields";
      renderPanelCached();
    });

    panelEl.querySelector("#jobagent-refresh-storage-btn").addEventListener("click", () => {
      renderStorageView();
    });

    panelEl.querySelectorAll(".jobagent-storage-edit").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const key = btn.dataset.key;
        const vi = parseInt(btn.dataset.vi, 10);
        const oldVal = profile[key][vi];
        const newVal = prompt(`Edit value for ${key}:`, oldVal);
        if (newVal !== null && newVal.trim() !== "" && newVal !== oldVal) {
          profile[key][vi] = newVal.trim();
          // Deduplicate if necessary
          profile[key] = [...new Set(profile[key])];
          await chrome.storage.local.set({ profile });
          renderStorageView();
        }
      });
    });

    panelEl.querySelectorAll(".jobagent-storage-delete").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const key = btn.dataset.key;
        const vi = parseInt(btn.dataset.vi, 10);
        if (profile[key] && Array.isArray(profile[key])) {
          profile[key].splice(vi, 1);
          if (profile[key].length === 0) delete profile[key];
          await chrome.storage.local.set({ profile });
          renderStorageView();
        }
      });
    });
  }

  // ---------- Utilities ----------
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function observeForms() {
    let debounce;
    const obs = new MutationObserver((mutations) => {
      let hasRelevantChanges = false;
      
      for (const m of mutations) {
        if (m.target.id === 'jobagent-root' || 
            (m.target.nodeType === 1 && m.target.closest('#jobagent-root')) ||
            (m.target.parentElement && m.target.parentElement.closest('#jobagent-root'))) {
          continue;
        }
        
        if (m.addedNodes.length > 0) {
          for (const node of m.addedNodes) {
            if (node.nodeType !== 1) continue;
            const tag = node.tagName.toLowerCase();
            if (['input', 'textarea', 'select', 'form'].includes(tag) || 
                (node.querySelector && node.querySelector('input, textarea, select, form'))) {
              hasRelevantChanges = true;
              break;
            }
          }
        }
        if (hasRelevantChanges) break;
      }
      
      if (!hasRelevantChanges) return;
      
      clearTimeout(debounce);
      debounce = setTimeout(scan, 1200);
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  // Listen for profile updates from background (after learn-from-submit completes)
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "JOBAGENT_PROFILE_UPDATED") {
      profile = msg.profile;
    }
  });

  init();
})();
