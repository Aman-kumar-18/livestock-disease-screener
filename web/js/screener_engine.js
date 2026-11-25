/**
 * Client-side inference engine for Livestock Disease Early Detection Screener.
 * Produces exact mathematical parity with ml/models.py and server.py so the app works
 * both as a static deployment (Netlify/Vercel/GitHub Pages) and with the Python API.
 */
(function (global) {
  "use strict";

  const SPECIES_LIST = ["cattle", "buffalo", "goat", "sheep"];
  const AGE_GROUPS = ["young", "adult", "senior"];

  function evalTree(node, row) {
    let curr = node;
    while (!curr.leaf) {
      curr = row[curr.f] <= curr.t ? curr.l : curr.r;
    }
    return curr.probs;
  }

  function evalSoftmax(lrModel, row) {
    const { bias, weights } = lrModel;
    const nCls = bias.length;
    const logits = new Array(nCls);
    let maxLogit = -Infinity;
    for (let c = 0; c < nCls; c++) {
      let z = bias[c];
      const wRow = weights[c];
      for (let j = 0; j < row.length; j++) {
        if (row[j] !== 0) z += wRow[j] * row[j];
      }
      logits[c] = z;
      if (z > maxLogit) maxLogit = z;
    }
    const exps = new Array(nCls);
    let sumExp = 0;
    for (let c = 0; c < nCls; c++) {
      const e = Math.exp(logits[c] - maxLogit);
      exps[c] = e;
      sumExp += e;
    }
    return exps.map((e) => e / sumExp);
  }

  function extractFeatures(payload, bundle) {
    const species = String(payload.species || "cattle").toLowerCase();
    const ageGroup = String(payload.age_group || "adult").toLowerCase();
    const sv = bundle.species_vitals[species] || bundle.species_vitals.cattle;

    const tempC = Number(payload.rectal_temp_c ?? sv.temp_mid);
    const hr = Number(payload.heart_rate_bpm ?? sv.hr_mid);
    const rr = Number(payload.resp_rate_bpm ?? sv.rr_mid);
    const herdPct = Math.max(0, Math.min(100, Number(payload.herd_affected_pct ?? 5)));
    const daysOnset = Math.max(0, Math.min(30, Number(payload.days_since_onset ?? 1)));

    const vec = [];
    for (const s of SPECIES_LIST) vec.push(species === s ? 1.0 : 0.0);
    for (const a of AGE_GROUPS) vec.push(ageGroup === a ? 1.0 : 0.0);

    vec.push(Number((tempC - sv.temp_mid).toFixed(4)));
    vec.push(Number(((hr - sv.hr_mid) / 20.0).toFixed(4)));
    vec.push(Number(((rr - sv.rr_mid) / 10.0).toFixed(4)));
    vec.push(Number((herdPct / 100.0).toFixed(4)));
    vec.push(Number((daysOnset / 14.0).toFixed(4)));

    const symIds = [];
    for (const grp of bundle.schema.symptom_groups) {
      for (const sym of grp.symptoms) symIds.push(sym.id);
    }
    const symInput = payload.symptoms || payload;
    for (const sid of symIds) {
      vec.push(symInput[sid] ? 1.0 : 0.0);
    }
    return { vec, symIds, sv, tempC, hr, rr };
  }

  function runLocalInference(payload, bundle) {
    const { vec, symIds, sv, tempC, hr, rr } = extractFeatures(payload, bundle);
    const classes = bundle.classes;
    const nCls = classes.length;
    const primary = bundle.primary_model;
    const rfTrees = primary.random_forest.trees;

    const rfAcc = new Array(nCls).fill(0);
    for (const tree of rfTrees) {
      const p = evalTree(tree, vec);
      for (let c = 0; c < nCls; c++) rfAcc[c] += p[c];
    }
    const rfProbs = rfAcc.map((v) => v / rfTrees.length);
    const lrProbs = evalSoftmax(primary.softmax_logistic, vec);

    const wRf = primary.rf_weight;
    const wLr = primary.lr_weight;
    const blended = new Array(nCls);
    let total = 0;
    for (let c = 0; c < nCls; c++) {
      blended[c] = wRf * rfProbs[c] + wLr * lrProbs[c];
      total += blended[c];
    }
    const probs = blended.map((v) => v / (total || 1));

    // Baseline Decision Tree
    const dtProbs = evalTree(bundle.baseline_model.tree, vec);
    const dtOrder = Array.from({ length: nCls }, (_, i) => i).sort((a, b) => dtProbs[b] - dtProbs[a]);
    const dtTop1Id = classes[dtOrder[0]];

    const condMap = {};
    for (const c of bundle.schema.target_conditions) condMap[c.id] = c;

    const order = Array.from({ length: nCls }, (_, i) => i).sort((a, b) => probs[b] - probs[a]);
    const ranked = order.slice(0, 5).map((idx, rankIdx) => {
      const cid = classes[idx];
      const meta = condMap[cid];
      const guidance = bundle.condition_guidance[cid] || {};
      return {
        rank: rankIdx + 1,
        condition_id: cid,
        name: meta.name,
        probability: Number(probs[idx].toFixed(4)),
        referral_tier: meta.referral_tier,
        referral_flag: meta.referral_flag,
        notifiable: meta.notifiable,
        pathogen_type: guidance.pathogen_type || "",
        key_indicators: guidance.key_indicators || [],
        immediate_actions: guidance.immediate_actions || [],
        do_not: guidance.do_not || []
      };
    });

    const top1 = ranked[0];
    const safetyNetReferral =
      top1.referral_flag ||
      ranked.slice(0, 3).some((item) => item.referral_flag && item.probability >= 0.22);

    let highestTier = "MONITOR_ROUTINE";
    for (const item of ranked.slice(0, 3)) {
      if (item.probability >= 0.22 || item.rank === 1) {
        if (item.referral_tier === "URGENT_REFERRAL") {
          highestTier = "URGENT_REFERRAL";
          break;
        }
        if (item.referral_tier === "VET_CONSULT") {
          highestTier = "VET_CONSULT";
        }
      }
    }

    const symInput = payload.symptoms || payload;
    const observedCount = symIds.reduce((acc, sid) => acc + (symInput[sid] ? 1 : 0), 0);

    return {
      disclaimer: bundle.schema.disclaimer,
      inference_mode: "client_model",
      referral_flag: safetyNetReferral,
      referral_tier: highestTier,
      referral_info: bundle.schema.referral_tiers[highestTier],
      ranked_conditions: ranked,
      baseline_comparison: {
        condition_id: dtTop1Id,
        name: condMap[dtTop1Id].name,
        probability: Number(dtProbs[dtOrder[0]].toFixed(4))
      },
      vitals_assessment: {
        temp_status:
          tempC > sv.temp_range[1] + 0.8
            ? "High Fever"
            : tempC > sv.temp_range[1]
            ? "Mild Fever"
            : tempC < sv.temp_range[0]
            ? "Subnormal"
            : "Normal",
        hr_status: hr > sv.hr_range[1] ? "Elevated" : hr < sv.hr_range[0] ? "Low" : "Normal",
        rr_status: rr > sv.rr_range[1] ? "Elevated" : rr < sv.rr_range[0] ? "Low" : "Normal",
        observed_symptoms_count: observedCount
      }
    };
  }

  global.ScreenerEngine = {
    runLocalInference
  };
})(window);
