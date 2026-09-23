#!/usr/bin/env python3
"""切片审查：按标注框裁剪帧图（外扩边距），供人工快速审查框-图匹配。

流程：前端点「开始切片」→ generate 后台线程批量裁剪 → status 轮询进度
→ list 分页拉取切片清单 → img 提供切片图片（token 认证）。
"""
import os, json, math, threading
from flask import Blueprint, request, jsonify, send_file
from PIL import Image
import db
from db import xlate_path
from auth import require

bp = Blueprint("crops", __name__)
BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MARGIN = 0.15          # 裁剪外扩边距（相对框宽高）
PER_PAGE = 200
_jobs = {}             # tid -> {running, done, total}


def _pool(tid):
    return db.q1("SELECT * FROM datasets WHERE name=?", (f"task{tid}_pool",))


def _crops_dir(tid):
    return os.path.join(BASE, "data", "crops", f"task{tid}")


def _manifest_path(tid):
    return os.path.join(_crops_dir(tid), "crops.json")


@bp.route("/api/anno_tasks/<int:tid>/crops/generate", methods=["POST"])
@require("admin", "lead", "annotator")
def api_crops_generate(tid):
    """开始切片：后台线程批量裁剪，写入 data/crops/task<tid>/。
    body 可选 {margin: 外扩比例}（相对框宽高，0=完全贴框，默认 0.15）。"""
    body = request.get_json(silent=True) or {}
    try:
        margin = float(body.get("margin", MARGIN))
    except (TypeError, ValueError):
        return jsonify({"err": "margin 无效"}), 400
    margin = min(max(margin, 0.0), 1.0)   # 钳位 0~100%
    t = db.q1("SELECT * FROM anno_tasks WHERE id=?", (tid,))
    if not t:
        return jsonify({"err": "task not found"}), 404
    ds = _pool(tid)
    if not ds:
        return jsonify({"err": "任务池尚无帧"}), 400
    j = _jobs.get(tid)
    if j and j.get("running"):
        return jsonify({"ok": True, "running": True,
                        "done": j["done"], "total": j["total"]})
    import api.datasets_api as _dda
    fdir = xlate_path(ds["frame_dir"])
    ldir = xlate_path(ds["label_dir"])
    frames = _dda._frames(ds)
    cdir = _crops_dir(tid)
    os.makedirs(cdir, exist_ok=True)
    for f in os.listdir(cdir):        # 清掉上一次的切片（保留清单与问题清单）
        if f not in ("crops.json", "issues.json"):
            try:
                os.remove(os.path.join(cdir, f))
            except OSError:
                pass

    def work():
        j = _jobs[tid] = {"running": True, "done": 0, "total": len(frames)}
        manifest = []
        try:
            for gi, rel in enumerate(frames):
                src = os.path.join(fdir, *rel.split("/"))
                lp = os.path.join(ldir, *os.path.splitext(rel)[0].split("/")) + ".txt"
                boxes = []
                try:
                    with open(lp, encoding="utf-8") as fh:
                        for bi, line in enumerate(fh):
                            p = line.split()
                            if len(p) >= 5:
                                boxes.append((bi, int(float(p[0])),
                                              float(p[1]), float(p[2]),
                                              float(p[3]), float(p[4])))
                except OSError:
                    pass
                if boxes:
                    try:
                        im = Image.open(src)
                        im.load()
                    except Exception:
                        j["done"] += 1
                        continue
                    W, H = im.size
                    for bi, cls, cx, cy, w, h in boxes:
                        cx *= W; cy *= H; w *= W; h *= H
                        mx, my = w * margin, h * margin
                        x0 = max(0, int(cx - w / 2 - mx))
                        y0 = max(0, int(cy - h / 2 - my))
                        x1 = min(W, int(cx + w / 2 + mx))
                        y1 = min(H, int(cy + h / 2 + my))
                        if x1 - x0 < 4 or y1 - y0 < 4:
                            continue
                        name = f"{gi}_{bi}_c{cls}.jpg"
                        try:
                            im.crop((x0, y0, x1, y1)).save(
                                os.path.join(cdir, name), quality=88)
                        except Exception:
                            continue
                        manifest.append({"gi": gi, "bi": bi, "cls": cls,
                                         "file": rel.split("/")[-1], "img": name})
                j["done"] += 1
        finally:
            with open(_manifest_path(tid), "w", encoding="utf-8") as fh:
                json.dump(manifest, fh, ensure_ascii=False)
            j["running"] = False
    threading.Thread(target=work, daemon=True).start()
    return jsonify({"ok": True, "running": True, "done": 0, "total": len(frames)})


def _issues_path(tid):
    return os.path.join(_crops_dir(tid), "issues.json")


def _load_issues(tid):
    if not os.path.isfile(_issues_path(tid)):
        return []
    try:
        with open(_issues_path(tid), encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return []


def _save_issues(tid, issues):
    os.makedirs(_crops_dir(tid), exist_ok=True)
    with open(_issues_path(tid), "w", encoding="utf-8") as fh:
        json.dump(issues, fh, ensure_ascii=False)


@bp.route("/api/anno_tasks/<int:tid>/crops/issues")
@require()
def api_issues_list(tid):
    """问题清单：分页，cls 过滤，结构与切片列表一致。"""
    issues = _load_issues(tid)
    cls = request.args.get("cls", type=int)
    if cls is not None:
        issues = [m for m in issues if m.get("cls") == cls]
    issues.sort(key=lambda m: (m.get("gi", 0), m.get("bi", 0)))
    total = len(issues)
    pages = max(1, math.ceil(total / PER_PAGE))
    page = min(max(1, request.args.get("page", 1, type=int)), pages)
    return jsonify({"ok": True, "total": total, "pages": pages, "page": page,
                    "items": issues[(page - 1) * PER_PAGE: page * PER_PAGE]})


@bp.route("/api/anno_tasks/<int:tid>/crops/issues", methods=["POST"])
@require("admin", "lead", "annotator")
def api_issues_add(tid):
    """加入问题清单：body {gi,bi,cls,file,img}；重复添加幂等。"""
    b = request.get_json(force=True) or {}
    for k in ("gi", "bi", "cls", "img"):
        if k not in b:
            return jsonify({"err": f"missing {k}"}), 400
    issues = _load_issues(tid)
    key = (b["gi"], b["bi"])
    if any((m.get("gi"), m.get("bi")) == key for m in issues):
        return jsonify({"ok": True, "dup": True})
    issues.append({"gi": b["gi"], "bi": b["bi"], "cls": b.get("cls", 0),
                   "file": b.get("file", ""), "img": b["img"]})
    _save_issues(tid, issues)
    return jsonify({"ok": True})


@bp.route("/api/anno_tasks/<int:tid>/crops/issues", methods=["DELETE"])
@require("admin", "lead", "annotator")
def api_issues_remove(tid):
    """移出问题清单：body {gi,bi} 或 {clear:true}。"""
    b = request.get_json(force=True) or {}
    issues = _load_issues(tid)
    if b.get("clear"):
        _save_issues(tid, [])
        return jsonify({"ok": True, "removed": len(issues)})
    key = (b.get("gi"), b.get("bi"))
    n = len(issues)
    issues = [m for m in issues if (m.get("gi"), m.get("bi")) != key]
    _save_issues(tid, issues)
    return jsonify({"ok": True, "removed": n - len(issues)})


@bp.route("/api/anno_tasks/<int:tid>/crops/status")
@require()
def api_crops_status(tid):
    j = _jobs.get(tid) or {}
    return jsonify({"ok": True, "running": bool(j.get("running")),
                    "done": j.get("done", 0), "total": j.get("total", 0),
                    "ready": os.path.isfile(_manifest_path(tid))})


@bp.route("/api/anno_tasks/<int:tid>/crops")
@require()
def api_crops_list(tid):
    """分页返回切片清单；cls 参数按类别过滤。"""
    if not os.path.isfile(_manifest_path(tid)):
        return jsonify({"ok": True, "items": [], "total": 0, "pages": 0, "page": 1})
    with open(_manifest_path(tid), encoding="utf-8") as fh:
        man = json.load(fh)
    cls = request.args.get("cls", type=int)
    if cls is not None:
        man = [m for m in man if m["cls"] == cls]
    total = len(man)
    pages = max(1, math.ceil(total / PER_PAGE))
    page = min(max(1, request.args.get("page", 1, type=int)), pages)
    return jsonify({"ok": True, "total": total, "pages": pages, "page": page,
                    "items": man[(page - 1) * PER_PAGE: page * PER_PAGE]})


@bp.route("/api/anno_tasks/<int:tid>/crops/img/<path:name>")
def api_crops_img(tid, name):
    """切片图片：<img> 标签无法带 Authorization 头，支持 ?token= 认证。"""
    token = request.args.get("token", "") or \
        request.headers.get("Authorization", "").removeprefix("Bearer ").strip()
    u = db.q1("SELECT u.* FROM tokens t JOIN users u ON u.id=t.user_id "
              "WHERE t.token=? AND u.is_active=1", (token,))
    if not u:
        return jsonify({"err": "unauthorized"}), 401
    name = os.path.basename(name)
    p = os.path.join(_crops_dir(tid), name)
    if not os.path.isfile(p):
        return jsonify({"err": "not found"}), 404
    return send_file(p, mimetype="image/jpeg")
