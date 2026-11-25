# PashuRakshak — Livestock Disease Early Detection Screener

- **Project ID:** `P48` (Allocation `K3P25VC`)
- **Problem Statement:** `SIH26128` — *Efficient systems for early detection, prevention, and management of livestock diseases and animal health issues*
- **Organisation:** Government of Maharashtra (Smart India Hackathon 2026)
- **Team `VC-3QLG`:** Aditya Ranjan (`12517187`) · Aman Kumar (`12511069`) · Tanishk (`12519648`)

> **Disclaimer:** *Screening & Triage Aid Only — Not a Veterinary Diagnosis.* Always consult a registered veterinarian for confirmatory testing and treatment.

---

## Objectives & Delivered Artifacts

1. **Multi-Class Screener with Referral Flags (`ml/models.py`, `server.py`, `web/`)**
   - Maps **species**, **age group**, **5 basic vitals/context inputs**, and **24 farmer-observable symptoms** across **12 livestock conditions** (`FMD`, `HS`, `LSD`, `PPR`, `ANTHRAX`, `BLACKLEG`, `BLOAT`, `MASTITIS`, `BRD`, `METABOLIC`, `PARASITISM`, `FOOT_ROT`).
   - Outputs Top-3 / Top-5 ranked likely conditions, calibrated probabilities, immediate field biosecurity steps, and a safety-net veterinary referral flag (`URGENT_REFERRAL`, `VET_CONSULT`, `MONITOR_ROUTINE`).

2. **Held-Out Predictions on 2,500 Records (`artifacts/held_out_predictions.csv` & `.json`)**
   - Exceeds the minimum 2,000-record requirement (`8,000` training + `2,500` held-out validation records).
   - Searchable and downloadable directly from the web UI (**Held-Out Records (2,500)** tab).

3. **Benchmark Comparison vs. Mandatory Decision-Tree Baseline (`artifacts/evaluation_report.json`)**

| Metric (Held-Out `n = 2,500`) | Mandatory Decision-Tree Baseline (`max_depth=5`) | Primary Screener (Random Forest + Softmax Ensemble) |
|---|---:|---:|
| **Top-1 Accuracy** | 59.76% | **96.80%** |
| **Top-3 Accuracy** | 82.84% | **99.76%** |
| **Macro F1** | 0.5012 | **0.9677** |
| **Referral-Flag Recall (Top-1)** | 98.66% | **99.71%** |
| **Referral-Flag Recall (Top-3 Safety-Net)** | 98.66% | **99.86%** |

---

## Quick Start (Zero External Dependencies)

Requires only **Python 3.10+**.

```bash
# 1. (Optional) Re-run data generation, training & evaluation pipeline
python ml/run_pipeline.py

# 2. Start the live web server + REST API
python server.py
```

Open `http://localhost:8080` in your browser.

### REST API Endpoints (`server.py`)
- `GET /api/health` — Server status & model readiness
- `GET /api/schema` — Formal `symptom_schema.json`
- `GET /api/metrics` — Full `evaluation_report.json`
- `GET /api/heldout?species=&condition=&search=&offset=0&limit=50` — Paginated 2,500 held-out predictions
- `POST /api/screen` — Live multi-class screening inference

---

## Ready-to-Deploy Options

Because `web/js/screener_engine.js` implements exact parity with the Python model using `web/data/model_bundle.json`, you can deploy either as a **static site** or as a **Python web service**:

- **Netlify:** Push repo; `netlify.toml` publishes `web/` automatically.
- **Vercel:** Push repo; `vercel.json` serves `web/` automatically.
- **GitHub Pages:** Deploy the `web/` directory directly.
- **Docker / Render / Railway:** Build from `Dockerfile` (`python server.py`, reads `PORT` env var).
<!-- deploy trigger -->
