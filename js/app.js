/**
 * Main controller for PashuRakshak — block-based livestock disease screener (P48 / SIH26128)
 */
(function () {
  "use strict";

  const HISTORY_KEY = "pashurakshak_screen_history_v1";
  const PAGE_SIZE = 50;

  const state = {
    bundle: null,
    heldoutRecords: null,
    filteredHeldout: [],
    heldoutPage: 1,
    apiAvailable: false,
    species: "cattle",
    tempUnit: "C",
    lang: "en",
    activeSymptomCat: "all",
    activeCondTier: "all",
    selectedSymptoms: new Set(),
    lastResult: null,
    lastPayload: null
  };

  function $(id) {
    return document.getElementById(id);
  }

  function pct(v) {
    return (Number(v) * 100).toFixed(1) + "%";
  }

  function esc(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  async function init() {
    bindNavigation();
    bindLanguageSwitcher();

    try {
      const [bundleRes, healthOk] = await Promise.all([
        fetch("data/model_bundle.json"),
        fetch("/api/health").then((r) => r.ok).catch(() => false)
      ]);
      if (!bundleRes.ok) throw new Error("Could not load model_bundle.json");
      state.bundle = await bundleRes.json();
      state.apiAvailable = Boolean(healthOk);

      $("engine-status-text").textContent = state.apiAvailable
        ? "Python API + Client Parity Active"
        : "Browser Model Ready";

      renderSpeciesSelector();
      renderSymptomTiles();
      renderSampleCases();
      renderConditionsDirectory();
      renderValidationBand();
      renderBenchmarks();
      renderSchemaExplorer();
      renderHistory();
      bindFormControls();
      updateVitalHintsAndPills();
      $("loading-overlay").classList.add("hidden");
    } catch (err) {
      $("loading-overlay").innerHTML = `<div class="loading-box" style="color:#991B1B">Error loading screener: ${esc(
        err.message
      )}</div>`;
    }
  }

  function switchView(viewId, scrollTargetId) {
    document.querySelectorAll(".view-panel").forEach((v) => v.classList.toggle("active", v.id === `view-${viewId}`));
    document.querySelectorAll(".header-nav .nav-link").forEach((btn) => {
      const isMatch = btn.dataset.view === viewId && !btn.dataset.scroll;
      btn.classList.toggle("active", isMatch);
    });

    if (viewId === "benchmarks" && state.heldoutRecords === null) {
      loadHeldoutRecords();
    }

    if (scrollTargetId) {
      setTimeout(() => {
        const el = $(scrollTargetId);
        if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 60);
    } else {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }

  function bindNavigation() {
    document.querySelectorAll(".header-nav .nav-link").forEach((btn) => {
      btn.addEventListener("click", () => {
        switchView(btn.dataset.view, btn.dataset.scroll || null);
      });
    });

    document.querySelectorAll(".footer-link").forEach((btn) => {
      btn.addEventListener("click", () => switchView(btn.dataset.jump));
    });

    $("brand-home-link").addEventListener("click", (e) => {
      e.preventDefault();
      switchView("home");
    });

    $("btn-header-start").addEventListener("click", () => switchView("home", "screener-section"));
    $("btn-hero-start").addEventListener("click", () => switchView("home", "screener-section"));
    $("btn-hero-sample").addEventListener("click", () => {
      switchView("home", "screener-section");
      const firstCase = state.bundle?.sample_cases?.[0];
      if (firstCase) {
        loadSampleIntoForm(firstCase.input);
        setStep(2);
        submitScreening();
      }
    });

    $("btn-open-benchmarks").addEventListener("click", () => switchView("benchmarks"));
    $("btn-open-heldout").addEventListener("click", () => switchView("benchmarks", "heldout-explorer-card"));
  }

  function bindLanguageSwitcher() {
    document.querySelectorAll(".lang-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.lang = btn.dataset.lang;
        document.querySelectorAll(".lang-btn").forEach((b) => b.classList.toggle("active", b === btn));
        applyI18n();
      });
    });
  }

  function applyI18n() {
    const d = window.I18N_STRINGS[state.lang] || window.I18N_STRINGS.en;
    const map = {
      "i18n-brand-name": d.brandName,
      "i18n-disclaimer-short": d.disclaimerShort,
      "i18n-disclaimer-sub": d.disclaimerSub,
      "i18n-nav-screener": d.navScreener,
      "i18n-nav-conditions": d.navConditions,
      "i18n-nav-benchmarks": d.navBenchmarks,
      "i18n-nav-project": d.navProject,
      "i18n-hero-title": d.heroTitle,
      "i18n-hero-subtitle": d.heroSubtitle,
      "i18n-hero-cta-primary": d.heroCtaPrimary,
      "i18n-hero-cta-sample": d.heroCtaSample,
      "i18n-step1-title": d.step1Title,
      "i18n-step2-title": d.step2Title,
      "i18n-run-btn": d.runBtn,
      "i18n-reset-btn": d.resetBtn,
      "i18n-copy-btn": d.copyBtn,
      "i18n-print-btn": d.printBtn
    };
    Object.entries(map).forEach(([id, txt]) => {
      const el = $(id);
      if (el && txt) el.textContent = txt;
    });
    if (state.lastResult) updateReferralHeadingLang(state.lastResult.referral_tier);
  }

  function updateReferralHeadingLang(tier) {
    const d = window.I18N_STRINGS[state.lang] || window.I18N_STRINGS.en;
    const el = $("referral-title");
    if (!el) return;
    if (tier === "URGENT_REFERRAL") el.textContent = d.urgentBanner;
    else if (tier === "VET_CONSULT") el.textContent = d.consultBanner;
    else el.textContent = d.monitorBanner;
  }

  function setStep(stepNum) {
    [1, 2].forEach((n) => {
      $(`step-tab-${n}`).classList.toggle("active", n === stepNum);
      $(`step-panel-${n}`).classList.toggle("active", n === stepNum);
    });
  }

  function renderSpeciesSelector() {
    const container = $("species-selector");
    container.innerHTML = state.bundle.schema.species
      .map((sp) => {
        const tr = sp.normal_vitals.rectal_temp_c;
        const selected = sp.id === state.species ? "selected" : "";
        return `
          <button type="button" class="species-card ${selected}" data-species="${sp.id}" role="radio" aria-checked="${
            sp.id === state.species
          }">
            <strong>${esc(sp.label.split(" ")[0])}</strong>
            <span>${tr[0]}–${tr[1]} °C</span>
          </button>
        `;
      })
      .join("");

    container.querySelectorAll(".species-card").forEach((card) => {
      card.addEventListener("click", () => {
        state.species = card.dataset.species;
        const sv = state.bundle.species_vitals[state.species];
        $("heart-rate").value = Math.round(sv.hr_mid);
        $("resp-rate").value = Math.round(sv.rr_mid);
        container.querySelectorAll(".species-card").forEach((c) => {
          const isSel = c === card;
          c.classList.toggle("selected", isSel);
          c.setAttribute("aria-checked", String(isSel));
        });
        updateVitalHintsAndPills();
      });
    });
  }

  function renderSymptomTiles() {
    const grid = $("symptom-tiles-grid");
    const items = [];
    for (const grp of state.bundle.schema.symptom_groups) {
      for (const sym of grp.symptoms) {
        items.push({ ...sym, group: grp.id });
      }
    }

    grid.innerHTML = items
      .map(
        (sym) => `
      <button type="button" class="symptom-tile" data-sym-id="${sym.id}" data-group="${sym.group}" data-search="${esc(
        (sym.label + " " + sym.description).toLowerCase()
      )}">
        <span class="tile-check">✓</span>
        <div>
          <span class="tile-title">${esc(sym.label)}</span>
          <span class="tile-sub">${esc(sym.description)}</span>
        </div>
      </button>
    `
      )
      .join("");

    grid.querySelectorAll(".symptom-tile").forEach((tile) => {
      tile.addEventListener("click", () => {
        const sid = tile.dataset.symId;
        if (state.selectedSymptoms.has(sid)) {
          state.selectedSymptoms.delete(sid);
          tile.classList.remove("checked");
        } else {
          state.selectedSymptoms.add(sid);
          tile.classList.add("checked");
        }
        $("symptom-counter-badge").textContent = String(state.selectedSymptoms.size);
      });
    });
  }

  function filterSymptomTiles() {
    const q = $("symptom-filter").value.trim().toLowerCase();
    const cat = state.activeSymptomCat;
    document.querySelectorAll(".symptom-tile").forEach((tile) => {
      const catOk = cat === "all" || tile.dataset.group === cat;
      const searchOk = !q || tile.dataset.search.includes(q);
      tile.classList.toggle("hidden", !(catOk && searchOk));
    });
  }

  function renderSampleCases() {
    const container = $("sample-cases-list");
    container.innerHTML = state.bundle.sample_cases
      .slice(0, 5)
      .map(
        (c) =>
          `<button type="button" class="sample-chip" data-case-id="${c.id}">${esc(
            c.title.split("—")[0].trim() + " · " + c.subtitle.split(" ")[0]
          )}</button>`
      )
      .join("");

    container.querySelectorAll(".sample-chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        const found = state.bundle.sample_cases.find((c) => c.id === chip.dataset.caseId);
        if (!found) return;
        container.querySelectorAll(".sample-chip").forEach((c) => c.classList.toggle("active", c === chip));
        loadSampleIntoForm(found.input);
        submitScreening();
      });
    });
  }

  function loadSampleIntoForm(inp) {
    state.species = inp.species || "cattle";
    renderSpeciesSelector();

    $("age-group").value = inp.age_group || "adult";
    const tempC = Number(inp.rectal_temp_c ?? 38.6);
    $("rectal-temp").value = state.tempUnit === "C" ? tempC.toFixed(1) : ((tempC * 9) / 5 + 32).toFixed(1);
    $("heart-rate").value = inp.heart_rate_bpm ?? 66;
    $("resp-rate").value = inp.resp_rate_bpm ?? 24;
    $("herd-pct").value = inp.herd_affected_pct ?? 5;
    $("herd-pct-display").textContent = `${$("herd-pct").value}%`;
    $("days-onset").value = inp.days_since_onset ?? 1;

    state.selectedSymptoms.clear();
    document.querySelectorAll(".symptom-tile").forEach((tile) => {
      const on = Boolean(inp[tile.dataset.symId]);
      if (on) state.selectedSymptoms.add(tile.dataset.symId);
      tile.classList.toggle("checked", on);
    });
    $("symptom-counter-badge").textContent = String(state.selectedSymptoms.size);
    updateVitalHintsAndPills();
  }

  function bindFormControls() {
    $("step-tab-1").addEventListener("click", () => setStep(1));
    $("step-tab-2").addEventListener("click", () => setStep(2));
    $("btn-next-step").addEventListener("click", () => setStep(2));
    $("btn-prev-step").addEventListener("click", () => setStep(1));

    $("symptom-category-tabs").querySelectorAll(".cat-pill").forEach((pill) => {
      pill.addEventListener("click", () => {
        state.activeSymptomCat = pill.dataset.cat;
        $("symptom-category-tabs").querySelectorAll(".cat-pill").forEach((p) => p.classList.toggle("active", p === pill));
        filterSymptomTiles();
      });
    });

    $("symptom-filter").addEventListener("input", filterSymptomTiles);

    document.querySelectorAll(".unit-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const newUnit = btn.dataset.unit;
        if (newUnit === state.tempUnit) return;
        const val = parseFloat($("rectal-temp").value);
        state.tempUnit = newUnit;
        document.querySelectorAll(".unit-btn").forEach((b) => b.classList.toggle("active", b === btn));
        if (!Number.isNaN(val)) {
          $("rectal-temp").min = newUnit === "F" ? "95" : "35";
          $("rectal-temp").max = newUnit === "F" ? "110" : "43";
          $("rectal-temp").value = (newUnit === "F" ? (val * 9) / 5 + 32 : ((val - 32) * 5) / 9).toFixed(1);
        }
        updateVitalHintsAndPills();
      });
    });

    ["rectal-temp", "heart-rate", "resp-rate"].forEach((id) => {
      $(id).addEventListener("input", updateVitalHintsAndPills);
    });

    $("herd-pct").addEventListener("input", () => {
      $("herd-pct-display").textContent = `${$("herd-pct").value}%`;
    });

    $("screener-form").addEventListener("submit", (e) => {
      e.preventDefault();
      submitScreening();
    });

    $("btn-reset-form").addEventListener("click", () => {
      document.querySelectorAll(".sample-chip").forEach((c) => c.classList.remove("active"));
      const sv = state.bundle.species_vitals[state.species];
      loadSampleIntoForm({
        species: state.species,
        age_group: "adult",
        rectal_temp_c: sv.temp_mid,
        heart_rate_bpm: Math.round(sv.hr_mid),
        resp_rate_bpm: Math.round(sv.rr_mid),
        herd_affected_pct: 5,
        days_since_onset: 1
      });
      setStep(1);
      $("results-panel").classList.add("hidden");
      $("results-placeholder").classList.remove("hidden");
      state.lastResult = null;
    });

    $("btn-print-sheet").addEventListener("click", () => window.print());
    $("btn-copy-summary").addEventListener("click", copyVetSummary);
    $("btn-clear-history").addEventListener("click", () => {
      localStorage.removeItem(HISTORY_KEY);
      renderHistory();
    });
  }

  function getTempCelsius() {
    const raw = parseFloat($("rectal-temp").value);
    if (Number.isNaN(raw)) return 38.6;
    return state.tempUnit === "F" ? ((raw - 32) * 5) / 9 : raw;
  }

  function updateVitalHintsAndPills() {
    const sv = state.bundle.species_vitals[state.species];
    const tC = getTempCelsius();
    const hr = parseFloat($("heart-rate").value);
    const rr = parseFloat($("resp-rate").value);

    if (state.tempUnit === "C") {
      $("temp-range-hint").textContent = `Normal ${state.species}: ${sv.temp_range[0]} – ${sv.temp_range[1]} °C`;
    } else {
      $("temp-range-hint").textContent = `Normal ${state.species}: ${((sv.temp_range[0] * 9) / 5 + 32).toFixed(1)} – ${(
        (sv.temp_range[1] * 9) / 5 + 32
      ).toFixed(1)} °F`;
    }
    $("hr-range-hint").textContent = `Normal: ${sv.hr_range[0]} – ${sv.hr_range[1]} BPM`;
    $("rr-range-hint").textContent = `Normal: ${sv.rr_range[0]} – ${sv.rr_range[1]} /min`;

    const tPill = $("temp-status-pill");
    if (tC > sv.temp_range[1] + 0.8) {
      tPill.textContent = "High Fever";
      tPill.className = "status-tag alert";
    } else if (tC > sv.temp_range[1]) {
      tPill.textContent = "Mild Fever";
      tPill.className = "status-tag warn";
    } else if (tC < sv.temp_range[0]) {
      tPill.textContent = "Subnormal";
      tPill.className = "status-tag warn";
    } else {
      tPill.textContent = "Normal";
      tPill.className = "status-tag normal";
    }

    const hrPill = $("hr-status-pill");
    hrPill.textContent = hr > sv.hr_range[1] ? "Elevated" : hr < sv.hr_range[0] ? "Low" : "Normal";
    hrPill.className = hr > sv.hr_range[1] || hr < sv.hr_range[0] ? "status-tag warn" : "status-tag normal";

    const rrPill = $("rr-status-pill");
    rrPill.textContent = rr > sv.rr_range[1] ? "Elevated" : rr < sv.rr_range[0] ? "Low" : "Normal";
    rrPill.className = rr > sv.rr_range[1] || rr < sv.rr_range[0] ? "status-tag warn" : "status-tag normal";
  }

  function buildPayload() {
    const payload = {
      species: state.species,
      age_group: $("age-group").value,
      rectal_temp_c: Number(getTempCelsius().toFixed(1)),
      heart_rate_bpm: Number($("heart-rate").value || 66),
      resp_rate_bpm: Number($("resp-rate").value || 24),
      herd_affected_pct: Number($("herd-pct").value || 5),
      days_since_onset: Number($("days-onset").value || 1),
      symptoms: {}
    };
    state.selectedSymptoms.forEach((sid) => {
      payload.symptoms[sid] = 1;
      payload[sid] = 1;
    });
    return payload;
  }

  async function submitScreening() {
    const payload = buildPayload();
    let result = null;
    if (state.apiAvailable) {
      try {
        const res = await fetch("/api/screen", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        if (res.ok) result = await res.json();
      } catch (_) {}
    }
    if (!result) result = window.ScreenerEngine.runLocalInference(payload, state.bundle);

    state.lastPayload = payload;
    state.lastResult = result;
    renderScreeningResult(payload, result);
    saveToHistory(payload, result);
  }

  function renderScreeningResult(payload, result) {
    $("results-placeholder").classList.add("hidden");
    $("results-panel").classList.remove("hidden");

    const banner = $("referral-banner");
    banner.className = `triage-banner tier-${result.referral_tier}`;
    updateReferralHeadingLang(result.referral_tier);
    $("referral-sla").textContent = `SLA: ≤ ${result.referral_info.sla_hours}h`;
    $("referral-summary").textContent = result.referral_info.summary;

    const va = result.vitals_assessment;
    $("vitals-summary-chips").innerHTML = `
      <span class="vital-chip">${esc(payload.species.toUpperCase())} (${esc(payload.age_group)})</span>
      <span class="vital-chip">${payload.rectal_temp_c}°C (${esc(va.temp_status)})</span>
      <span class="vital-chip">Herd: ${payload.herd_affected_pct}%</span>
      <span class="vital-chip">${va.observed_symptoms_count} signs</span>
    `;

    const list = $("ranked-conditions-list");
    list.innerHTML = result.ranked_conditions
      .slice(0, 3)
      .map(
        (item) => `
      <div class="ranked-row rank-${item.rank}">
        <div class="ranked-head">
          <div class="ranked-title-group">
            <span class="rank-tag">#${item.rank}</span>
            <span class="ranked-name">${esc(item.name)}</span>
            ${item.notifiable ? `<span class="notifiable-pill">Notifiable</span>` : ""}
          </div>
          <span class="ranked-prob">${(item.probability * 100).toFixed(1)}%</span>
        </div>
        <div class="prob-track"><div class="prob-fill" data-w="${Math.max(4, Math.min(100, item.probability * 100))}%"></div></div>
        <div class="ranked-sub">${esc(item.pathogen_type)}</div>
      </div>
    `
      )
      .join("");

    requestAnimationFrame(() => {
      list.querySelectorAll(".prob-fill").forEach((b) => {
        b.style.width = b.dataset.w;
      });
    });

    const base = result.baseline_comparison;
    $("baseline-comparison-box").innerHTML = `
      <span><strong>Decision-Tree Baseline #1:</strong> ${esc(base.name)} (${(base.probability * 100).toFixed(1)}%)</span>
      <span class="mono-tag">${
        base.condition_id === result.ranked_conditions[0].condition_id ? "Matches Primary" : "Differs from Primary"
      }</span>
    `;

    const top1 = result.ranked_conditions[0];
    $("guidance-title").textContent = `Field Actions — ${top1.name}`;
    $("guidance-do-list").innerHTML = top1.immediate_actions.map((a) => `<li>${esc(a)}</li>`).join("");
    $("guidance-dont-list").innerHTML = top1.do_not.map((d) => `<li>${esc(d)}</li>`).join("");
  }

  function copyVetSummary() {
    if (!state.lastResult || !state.lastPayload) return;
    const p = state.lastPayload;
    const r = state.lastResult;
    const top3 = r.ranked_conditions
      .slice(0, 3)
      .map((c) => `#${c.rank} ${c.name} (${(c.probability * 100).toFixed(1)}%)`)
      .join(" | ");
    const syms = Array.from(state.selectedSymptoms).join(", ") || "None";
    const text = [
      `[PashuRakshak Screening — NOT A DIAGNOSIS]`,
      `Animal: ${p.species.toUpperCase()} (${p.age_group}) | Temp: ${p.rectal_temp_c}°C | Herd: ${p.herd_affected_pct}%`,
      `Signs: ${syms}`,
      `Status: ${r.referral_info.label}`,
      `Top Suspects: ${top3}`
    ].join("\n");

    navigator.clipboard.writeText(text).then(() => {
      const d = window.I18N_STRINGS[state.lang] || window.I18N_STRINGS.en;
      $("i18n-copy-btn").textContent = d.copiedBtn;
      setTimeout(() => {
        $("i18n-copy-btn").textContent = d.copyBtn;
      }, 1800);
    });
  }

  function saveToHistory(payload, result) {
    try {
      const arr = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
      arr.unshift({
        ts: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        species: payload.species,
        temp: payload.rectal_temp_c,
        top1: result.ranked_conditions[0].name,
        prob: (result.ranked_conditions[0].probability * 100).toFixed(0) + "%",
        tier: result.referral_tier
      });
      localStorage.setItem(HISTORY_KEY, JSON.stringify(arr.slice(0, 4)));
      renderHistory();
    } catch (_) {}
  }

  function renderHistory() {
    const el = $("recent-history-list");
    let items = [];
    try {
      items = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
    } catch (_) {}
    if (!items.length) {
      el.innerHTML = `<span class="hint">No checks saved on this device yet.</span>`;
      return;
    }
    el.innerHTML = items
      .map(
        (it) => `
      <div class="history-item">
        <span><strong>${esc(it.species.toUpperCase())}</strong> · ${it.temp}°C · ${esc(it.top1)} (${it.prob})</span>
        <span class="tier-badge ${it.tier}">${it.tier.replace("_", " ")}</span>
      </div>
    `
      )
      .join("");
  }

  function renderConditionsDirectory() {
    const grid = $("conditions-directory-grid");
    const conds = state.bundle.schema.target_conditions;
    const guidance = state.bundle.condition_guidance;

    const draw = () => {
      const filtered = conds.filter((c) => state.activeCondTier === "all" || c.referral_tier === state.activeCondTier);
      grid.innerHTML = filtered
        .map((c) => {
          const g = guidance[c.id] || {};
          return `
          <article class="cond-card">
            <div class="cond-card-top">
              <h3>${esc(c.name)}</h3>
              <span class="tier-badge ${c.referral_tier}">${c.referral_tier.replace("_", " ")}</span>
            </div>
            <div class="cond-pathogen">${esc(g.pathogen_type || "")}</div>
            <ul class="cond-signs">
              ${(g.key_indicators || []).slice(0, 2).map((k) => `<li>${esc(k)}</li>`).join("")}
            </ul>
          </article>
        `;
        })
        .join("");
    };

    $("condition-tier-filters").querySelectorAll(".cat-pill").forEach((pill) => {
      pill.addEventListener("click", () => {
        state.activeCondTier = pill.dataset.tier;
        $("condition-tier-filters").querySelectorAll(".cat-pill").forEach((p) => p.classList.toggle("active", p === pill));
        draw();
      });
    });
    draw();
  }

  function renderValidationBand() {
    const m = state.bundle.evaluation_report.models.primary_screener.metrics;
    const b = state.bundle.evaluation_report.models.baseline_decision_tree.metrics;
    $("hero-top3-stat").textContent = pct(m.top3_accuracy);

    $("band-stats-grid").innerHTML = [
      { val: pct(m.top1_accuracy), lbl: `Top-1 Accuracy (vs ${pct(b.top1_accuracy)} DT)` },
      { val: pct(m.top3_accuracy), lbl: `Top-3 Accuracy (vs ${pct(b.top3_accuracy)} DT)` },
      { val: m.macro_f1.toFixed(3), lbl: `Macro F1 (vs ${b.macro_f1.toFixed(3)} DT)` },
      { val: pct(m.referral_flag_recall_safetynet), lbl: "Referral-Flag Recall (n=2,500)" }
    ]
      .map((s) => `<div class="band-stat-box"><strong>${s.val}</strong><span>${s.lbl}</span></div>`)
      .join("");
  }

  function renderBenchmarks() {
    const rep = state.bundle.evaluation_report;
    const base = rep.models.baseline_decision_tree.metrics;
    const prim = rep.models.primary_screener.metrics;
    const gain = rep.uplift_vs_baseline;

    $("benchmark-kpis").innerHTML = [
      { l: "Top-1 Accuracy", v: pct(prim.top1_accuracy), b: pct(base.top1_accuracy), g: `+${(gain.top1_accuracy_gain * 100).toFixed(1)} pts` },
      { l: "Top-3 Accuracy", v: pct(prim.top3_accuracy), b: pct(base.top3_accuracy), g: `+${(gain.top3_accuracy_gain * 100).toFixed(1)} pts` },
      { l: "Macro F1 Score", v: prim.macro_f1.toFixed(4), b: base.macro_f1.toFixed(4), g: `+${gain.macro_f1_gain.toFixed(4)}` },
      { l: "Referral-Flag Recall", v: pct(prim.referral_flag_recall_safetynet), b: pct(base.referral_flag_recall_safetynet), g: `+${(gain.referral_recall_safetynet_gain * 100).toFixed(1)} pts` }
    ]
      .map(
        (k) => `
      <div class="kpi-card">
        <div class="kpi-label">${k.l}</div>
        <div class="kpi-val">${k.v}</div>
        <div class="kpi-sub"><span>Baseline: ${k.b}</span><span class="kpi-gain">${k.g}</span></div>
      </div>
    `
      )
      .join("");

    const mRows = [
      { l: "Top-1 Accuracy", p: prim.top1_accuracy, b: base.top1_accuracy },
      { l: "Top-3 Accuracy", p: prim.top3_accuracy, b: base.top3_accuracy },
      { l: "Macro F1", p: prim.macro_f1, b: base.macro_f1 },
      { l: "Referral Recall (Safety-Net)", p: prim.referral_flag_recall_safetynet, b: base.referral_flag_recall_safetynet }
    ];
    $("metric-bars-container").innerHTML = mRows
      .map(
        (m) => `
      <div>
        <div class="bar-head"><strong>${m.l}</strong><span class="mono-tag">${pct(m.p)} vs ${pct(m.b)}</span></div>
        <div class="bar-bg"><div class="bar-fill-p" style="width:${(m.p * 100).toFixed(1)}%"></div></div>
        <div class="bar-bg"><div class="bar-fill-b" style="width:${(m.b * 100).toFixed(1)}%"></div></div>
      </div>
    `
      )
      .join("");

    const maxImp = rep.top_features[0]?.importance || 0.1;
    $("feature-importance-container").innerHTML = rep.top_features
      .slice(0, 8)
      .map(
        (f) => `
      <div>
        <div class="bar-head"><span class="mono-tag">${esc(f.feature)}</span><span class="mono-tag">${pct(f.importance)}</span></div>
        <div class="bar-bg"><div class="bar-fill-p" style="width:${Math.min(100, (f.importance / maxImp) * 100).toFixed(1)}%"></div></div>
      </div>
    `
      )
      .join("");

    document.querySelector("#per-class-table tbody").innerHTML = prim.per_class
      .map(
        (r) => `
      <tr>
        <td><strong>${esc(r.condition_name)}</strong> <span class="mono-tag">(${r.condition_id})</span></td>
        <td><span class="tier-badge ${r.referral_tier}">${r.referral_tier.replace("_", " ")}</span></td>
        <td class="num">${r.support}</td>
        <td class="num">${pct(r.precision)}</td>
        <td class="num">${pct(r.recall)}</td>
        <td class="num">${r.f1.toFixed(3)}</td>
        <td class="num">${pct(r.top3_recall)}</td>
      </tr>
    `
      )
      .join("");
  }

  async function loadHeldoutRecords() {
    $("heldout-count-label").textContent = "Loading 2,500 records…";
    try {
      const res = await fetch("data/held_out_predictions.json");
      state.heldoutRecords = await res.json();

      const condSelect = $("heldout-condition");
      state.bundle.schema.target_conditions.forEach((c) => {
        const opt = document.createElement("option");
        opt.value = c.id;
        opt.textContent = `${c.id} — ${c.name}`;
        condSelect.appendChild(opt);
      });

      ["heldout-search", "heldout-species", "heldout-condition", "heldout-match"].forEach((id) => {
        $(id).addEventListener("input", () => {
          state.heldoutPage = 1;
          applyHeldoutFilters();
        });
      });

      $("btn-prev-page").addEventListener("click", () => {
        if (state.heldoutPage > 1) {
          state.heldoutPage--;
          renderHeldoutTable();
        }
      });
      $("btn-next-page").addEventListener("click", () => {
        const maxPage = Math.max(1, Math.ceil(state.filteredHeldout.length / PAGE_SIZE));
        if (state.heldoutPage < maxPage) {
          state.heldoutPage++;
          renderHeldoutTable();
        }
      });

      applyHeldoutFilters();
    } catch (err) {
      $("heldout-count-label").textContent = `Error: ${err.message}`;
    }
  }

  function applyHeldoutFilters() {
    const q = $("heldout-search").value.trim().toLowerCase();
    const sp = $("heldout-species").value;
    const cond = $("heldout-condition").value;
    const match = $("heldout-match").value;

    state.filteredHeldout = state.heldoutRecords.filter((r) => {
      if (sp && r.species !== sp) return false;
      if (cond && r.true_condition !== cond && r.pred_top1 !== cond) return false;
      if (match === "top1" && !r.top1_match) return false;
      if (match === "top3" && !r.top3_match) return false;
      if (match === "miss" && r.top1_match) return false;
      if (q && !`${r.record_id} ${r.true_condition} ${r.pred_top1} ${r.species}`.toLowerCase().includes(q)) return false;
      return true;
    });
    renderHeldoutTable();
  }

  function renderHeldoutTable() {
    const total = state.filteredHeldout.length;
    const maxPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const start = (state.heldoutPage - 1) * PAGE_SIZE;
    const slice = state.filteredHeldout.slice(start, start + PAGE_SIZE);

    $("heldout-count-label").textContent = `${total.toLocaleString()} records`;
    $("heldout-page-label").textContent = `Page ${state.heldoutPage} / ${maxPage}`;
    $("btn-prev-page").disabled = state.heldoutPage <= 1;
    $("btn-next-page").disabled = state.heldoutPage >= maxPage;

    document.querySelector("#heldout-table tbody").innerHTML = slice
      .map((r) => {
        const badge = r.top1_match
          ? `<span class="outcome-pill exact">Top-1 Exact</span>`
          : r.top3_match
          ? `<span class="outcome-pill top3">In Top-3</span>`
          : `<span class="outcome-pill miss">Missed</span>`;

        return `
          <tr>
            <td class="mono-tag">${esc(r.record_id)}</td>
            <td><strong>${esc(r.species.toUpperCase())}</strong> (${esc(r.age_group)}) · <span class="mono-tag">${r.rectal_temp_c}°C</span></td>
            <td><strong>${esc(r.true_condition)}</strong></td>
            <td class="mono-tag">${esc(r.baseline_top1)} (${(r.baseline_top1_prob * 100).toFixed(0)}%)</td>
            <td class="mono-tag">1. <strong>${esc(r.pred_top1)}</strong> (${(r.pred_top1_prob * 100).toFixed(1)}%) · 2. ${esc(
          r.pred_top2
        )} · 3. ${esc(r.pred_top3)}</td>
            <td>${r.pred_referral_flag ? `<span class="tier-badge URGENT_REFERRAL">Flagged</span>` : `<span class="tier-badge MONITOR_ROUTINE">Routine</span>`}</td>
            <td>${badge}</td>
          </tr>
        `;
      })
      .join("");
  }

  function renderSchemaExplorer() {
    const s = state.bundle.schema;
    const boxes = [
      {
        title: "Species & Normal Vitals",
        items: s.species.map(
          (sp) =>
            `${sp.label}: Temp ${sp.normal_vitals.rectal_temp_c[0]}–${sp.normal_vitals.rectal_temp_c[1]}°C, HR ${sp.normal_vitals.heart_rate_bpm[0]}–${sp.normal_vitals.heart_rate_bpm[1]}`
        )
      },
      {
        title: "12 Target Conditions",
        items: s.target_conditions.map((c) => `${c.id} — ${c.name} [${c.referral_tier}]`)
      },
      ...s.symptom_groups.map((grp) => ({
        title: `${grp.label} (${grp.symptoms.length})`,
        items: grp.symptoms.map((sym) => `${sym.id}: ${sym.label}`)
      }))
    ];
    $("schema-explorer-grid").innerHTML = boxes
      .map(
        (b) => `<div class="schema-box"><h4>${esc(b.title)}</h4><ul>${b.items.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>`
      )
      .join("");
  }

  document.addEventListener("DOMContentLoaded", init);
})();
