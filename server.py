"""Zero-dependency HTTP server & inference API for Livestock Disease Early Detection Screener (P48 / SIH26128)."""

from __future__ import annotations

import json
import mimetypes
import os
import sys
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

ROOT_DIR = Path(__file__).resolve().parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from ml.clinical_kb import (
    CLASSES,
    CLASS_META,
    CONDITION_GUIDANCE,
    SPECIES_VITALS,
    SYMPTOM_IDS,
    extract_features,
)

WEB_DIR = ROOT_DIR / "web"
ARTIFACTS_DIR = ROOT_DIR / "artifacts"
SCHEMA_PATH = ROOT_DIR / "schema" / "symptom_schema.json"

with SCHEMA_PATH.open("r", encoding="utf-8") as _f:
    SCHEMA_DATA = json.load(_f)

EVAL_REPORT: dict[str, Any] = {}
if (ARTIFACTS_DIR / "evaluation_report.json").exists():
    with (ARTIFACTS_DIR / "evaluation_report.json").open("r", encoding="utf-8") as _f:
        EVAL_REPORT = json.load(_f)

HELDOUT_DATA: list[dict[str, Any]] = []
if (ARTIFACTS_DIR / "held_out_predictions.json").exists():
    with (ARTIFACTS_DIR / "held_out_predictions.json").open("r", encoding="utf-8") as _f:
        HELDOUT_DATA = json.load(_f)

BASELINE_MODEL: dict[str, Any] = {}
if (ARTIFACTS_DIR / "decision_tree_baseline.json").exists():
    with (ARTIFACTS_DIR / "decision_tree_baseline.json").open("r", encoding="utf-8") as _f:
        BASELINE_MODEL = json.load(_f)

PRIMARY_MODEL: dict[str, Any] = {}
if (ARTIFACTS_DIR / "screener_model.json").exists():
    with (ARTIFACTS_DIR / "screener_model.json").open("r", encoding="utf-8") as _f:
        PRIMARY_MODEL = json.load(_f)


def _eval_tree(node: dict[str, Any], row: list[float]) -> list[float]:
    while not node["leaf"]:
        node = node["l"] if row[node["f"]] <= node["t"] else node["r"]
    return node["probs"]


def _eval_softmax(lr_dict: dict[str, Any], row: list[float]) -> list[float]:
    import math

    bias = lr_dict["bias"]
    weights = lr_dict["weights"]
    logits = [
        bias[c] + sum(weights[c][j] * row[j] for j in range(len(row)))
        for c in range(len(bias))
    ]
    m = max(logits)
    exps = [math.exp(z - m) for z in logits]
    s = sum(exps)
    return [e / s for e in exps]


def predict_screen(payload: dict[str, Any]) -> dict[str, Any]:
    """Run primary hybrid model + baseline decision tree inference on a single animal record."""
    vec = extract_features(payload)

    # Primary hybrid model
    rf_trees = PRIMARY_MODEL["random_forest"]["trees"]
    n_cls = len(CLASSES)
    rf_acc = [0.0] * n_cls
    for tree in rf_trees:
        p = _eval_tree(tree, vec)
        for c in range(n_cls):
            rf_acc[c] += p[c]
    rf_probs = [v / len(rf_trees) for v in rf_acc]
    lr_probs = _eval_softmax(PRIMARY_MODEL["softmax_logistic"], vec)

    w_rf = PRIMARY_MODEL["rf_weight"]
    w_lr = PRIMARY_MODEL["lr_weight"]
    blended = [w_rf * rf_probs[c] + w_lr * lr_probs[c] for c in range(n_cls)]
    total = sum(blended) or 1.0
    probs = [v / total for v in blended]

    # Baseline decision tree
    dt_probs = _eval_tree(BASELINE_MODEL["tree"], vec)
    dt_order = sorted(range(n_cls), key=lambda c: dt_probs[c], reverse=True)
    dt_top1_id = CLASSES[dt_order[0]]

    order = sorted(range(n_cls), key=lambda c: probs[c], reverse=True)
    ranked = []
    for idx in order[:5]:
        cid = CLASSES[idx]
        meta = CLASS_META[cid]
        guidance = CONDITION_GUIDANCE.get(cid, {})
        ranked.append(
            {
                "rank": len(ranked) + 1,
                "condition_id": cid,
                "name": meta["name"],
                "probability": round(probs[idx], 4),
                "referral_tier": meta["referral_tier"],
                "referral_flag": meta["referral_flag"],
                "notifiable": meta["notifiable"],
                "pathogen_type": guidance.get("pathogen_type", ""),
                "key_indicators": guidance.get("key_indicators", []),
                "immediate_actions": guidance.get("immediate_actions", []),
                "do_not": guidance.get("do_not", []),
            }
        )

    top1 = ranked[0]
    safety_net_referral = top1["referral_flag"] or any(
        item["referral_flag"] and item["probability"] >= 0.22 for item in ranked[:3]
    )
    highest_tier = "MONITOR_ROUTINE"
    for item in ranked[:3]:
        if item["probability"] >= 0.22 or item["rank"] == 1:
            if item["referral_tier"] == "URGENT_REFERRAL":
                highest_tier = "URGENT_REFERRAL"
                break
            if item["referral_tier"] == "VET_CONSULT":
                highest_tier = "VET_CONSULT"

    species = str(payload.get("species", "cattle")).lower()
    sv = SPECIES_VITALS.get(species, SPECIES_VITALS["cattle"])
    temp_c = float(payload.get("rectal_temp_c", sv["temp_mid"]))
    hr = float(payload.get("heart_rate_bpm", sv["hr_mid"]))
    rr = float(payload.get("resp_rate_bpm", sv["rr_mid"]))

    return {
        "disclaimer": SCHEMA_DATA["disclaimer"],
        "inference_mode": "python_api",
        "referral_flag": safety_net_referral,
        "referral_tier": highest_tier,
        "referral_info": SCHEMA_DATA["referral_tiers"][highest_tier],
        "ranked_conditions": ranked,
        "baseline_comparison": {
            "condition_id": dt_top1_id,
            "name": CLASS_META[dt_top1_id]["name"],
            "probability": round(dt_probs[dt_order[0]], 4),
        },
        "vitals_assessment": {
            "temp_status": (
                "High Fever"
                if temp_c > sv["temp_range"][1] + 0.8
                else "Mild Fever"
                if temp_c > sv["temp_range"][1]
                else "Subnormal"
                if temp_c < sv["temp_range"][0]
                else "Normal"
            ),
            "hr_status": "Elevated" if hr > sv["hr_range"][1] else "Low" if hr < sv["hr_range"][0] else "Normal",
            "rr_status": "Elevated" if rr > sv["rr_range"][1] else "Low" if rr < sv["rr_range"][0] else "Normal",
            "observed_symptoms_count": sum(1 for s in SYMPTOM_IDS if payload.get(s) or payload.get("symptoms", {}).get(s)),
        },
    }


class ScreenerHandler(BaseHTTPRequestHandler):
    """Serves static web files and JSON screening API endpoints."""

    def log_message(self, format: str, *args: Any) -> None:
        # Clean concise logging
        sys.stdout.write(f"[http] {self.address_string()} - {format % args}\n")

    def _send_json(self, data: Any, status: int = HTTPStatus.OK) -> None:
        body = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/api/health":
            self._send_json(
                {
                    "status": "ok",
                    "project_id": "P48",
                    "problem_statement_id": "SIH26128",
                    "heldout_records": len(HELDOUT_DATA),
                    "model_loaded": bool(PRIMARY_MODEL),
                }
            )
            return

        if path == "/api/schema":
            self._send_json(SCHEMA_DATA)
            return

        if path == "/api/metrics":
            self._send_json(EVAL_REPORT)
            return

        if path == "/api/heldout":
            qs = parse_qs(parsed.query)
            species = qs.get("species", [""])[0].strip().lower()
            cond = qs.get("condition", [""])[0].strip().upper()
            search = qs.get("search", [""])[0].strip().lower()
            offset = max(0, int(qs.get("offset", ["0"])[0]))
            limit = min(200, max(1, int(qs.get("limit", ["50"])[0])))

            filtered = HELDOUT_DATA
            if species:
                filtered = [r for r in filtered if r["species"] == species]
            if cond:
                filtered = [r for r in filtered if r["true_condition"] == cond or r["pred_top1"] == cond]
            if search:
                filtered = [
                    r
                    for r in filtered
                    if search in r["record_id"].lower()
                    or search in r["true_condition"].lower()
                    or search in r["pred_top1"].lower()
                ]

            self._send_json(
                {
                    "total": len(filtered),
                    "offset": offset,
                    "limit": limit,
                    "records": filtered[offset : offset + limit],
                }
            )
            return

        # Serve static frontend from web/
        rel_path = "index.html" if path in ("", "/") else path.lstrip("/")
        target = (WEB_DIR / rel_path).resolve()
        if not str(target).startswith(str(WEB_DIR.resolve())) or not target.is_file():
            self.send_error(HTTPStatus.NOT_FOUND, "Resource not found")
            return

        mime, _ = mimetypes.guess_type(str(target))
        content = target.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", mime or "application/octet-stream")
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path != "/api/screen":
            self.send_error(HTTPStatus.NOT_FOUND, "Unknown endpoint")
            return

        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length)
        try:
            payload = json.loads(raw.decode("utf-8"))
        except Exception as exc:
            self._send_json({"error": f"Invalid JSON payload: {exc}"}, status=HTTPStatus.BAD_REQUEST)
            return

        result = predict_screen(payload)
        self._send_json(result)


def main() -> None:
    port = int(os.environ.get("PORT", "8080"))
    host = os.environ.get("HOST", "0.0.0.0")
    server = ThreadingHTTPServer((host, port), ScreenerHandler)
    print(f"Livestock Disease Screener (P48 / SIH26128) serving at http://{host}:{port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down server.")
        server.server_close()


if __name__ == "__main__":
    main()
