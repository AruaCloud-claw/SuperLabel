#!/usr/bin/env python3
"""统计 API。"""
import os
from flask import Blueprint, request, jsonify
import db
from auth import require

bp = Blueprint("stats", __name__)


@bp.route("/api/stats")
@require()
def api_stats():
    u = request.user
    out = {"datasets": []}
    rows = db.q("SELECT * FROM datasets ORDER BY id")
    for ds in rows:
        total = labeled = 0
        if os.path.isdir(ds["frame_dir"]):
            for f in os.listdir(ds["frame_dir"]):
                if not f.lower().endswith(".jpg"):
                    continue
                total += 1
                p = os.path.join(ds["label_dir"], os.path.splitext(f)[0] + ".txt")
                if os.path.exists(p) and os.path.getsize(p) > 0:
                    labeled += 1
        versions = db.q1("SELECT COUNT(*) c FROM label_versions WHERE dataset_id=?",
                         (ds["id"],))["c"]
        out["datasets"].append({"name": ds["name"], "total": total, "labeled": labeled,
                                "coverage": round(labeled / total, 3) if total else 0,
                                "status": ds["status"], "versions": versions})
    if u["role"] in ("admin", "lead"):
        out["by_user"] = db.q(
            "SELECT u.username, COUNT(*) saves FROM label_versions lv "
            "JOIN users u ON u.id=lv.user_id GROUP BY u.username")
    return jsonify(out)
