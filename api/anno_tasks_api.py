#!/usr/bin/env python3
"""标注任务 API：任务广场（创建/列表/详情）。"""
import os, json, time, threading
from flask import Blueprint, request, jsonify
import db
from db import xlate_path
from auth import require

bp = Blueprint("anno_tasks", __name__)
BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


@bp.route("/api/anno_tasks")
@require()
def api_list():
    rows = db.q(
        """SELECT t.*, u.username creator,
                  (SELECT COUNT(*) FROM anno_task_videos tv WHERE tv.task_id=t.id) video_count
           FROM anno_tasks t LEFT JOIN users u ON u.id=t.created_by
           ORDER BY t.id DESC""")
    return jsonify(rows)


@bp.route("/api/anno_tasks", methods=["POST"])
@require("admin", "lead", "annotator")
def api_create():
    d = request.get_json(force=True, silent=True) or {}
    name = (d.get("name") or "").strip()
    video_ids = d.get("video_ids", [])
    if not name:
        return jsonify({"err": "任务名必填"}), 400
    if not video_ids:
        return jsonify({"err": "请至少选择一个数据来源视频"}), 400
    tid = db.ex("INSERT INTO anno_tasks(name,note,created_by) VALUES(?,?,?)",
                (name, d.get("note", ""), request.user["id"]))
    for vid in video_ids:
        if db.q1("SELECT 1 FROM videos WHERE id=?", (vid,)):
            db.ex("INSERT OR IGNORE INTO anno_task_videos(task_id,video_id) VALUES(?,?)",
                  (tid, vid))
    db.audit(request.user["id"], "create_task", name, f"videos={video_ids}")
    return jsonify(db.q1("SELECT * FROM anno_tasks WHERE id=?", (tid,)))


@bp.route("/api/anno_tasks/<int:tid>", methods=["DELETE"])
@require("admin", "lead")
def api_del_task(tid):
    t = db.q1("SELECT * FROM anno_tasks WHERE id=?", (tid,))
    if not t:
        return jsonify({"err": "not found"}), 404
    db.ex("DELETE FROM anno_task_videos WHERE task_id=?", (tid,))
    db.ex("DELETE FROM video_frames WHERE task_id=?", (tid,))
    db.ex("DELETE FROM tasks WHERE dataset_id=?", (tid,))
    db.ex("DELETE FROM anno_tasks WHERE id=?", (tid,))
    db.audit(request.user["id"], "delete_task", t["name"])
    return jsonify({"ok": True})


@bp.route("/api/anno_tasks/<int:tid>/extract", methods=["POST"])
@require("admin", "lead", "annotator")
def api_task_extract(tid):
    """异步抽帧任务：立即返回 task_id，进度经 /api/tasks/<id> 轮询。"""
    d = request.get_json(force=True, silent=True) or {}
    fps = float(d.get("fps", 5.0))
    vids = d.get("video_ids") or ([d.get("video_id")] if d.get("video_id") else [])
    vids = [v for v in vids if v]
    if not vids:
        return jsonify({"err": "请至少选择一个视频"}), 400
    t = db.q1("SELECT * FROM anno_tasks WHERE id=?", (tid,))
    if not t:
        return jsonify({"err": "task not found"}), 404
    if not (0 < fps <= 30):
        return jsonify({"err": "fps 须在 0~30"}), 400
    if db.q1("SELECT 1 FROM tasks WHERE dataset_id=? AND kind='extract' "
             "AND status IN ('queued','running')", (tid,)):
        return jsonify({"err": "该任务已有抽帧正在进行"}), 409
    videos = [db.q1("SELECT * FROM videos WHERE id=?", (v,)) for v in vids]
    videos = [v for v in videos if v]
    if not videos:
        return jsonify({"err": "视频不存在"}), 404
    uid = request.user["id"]   # 线程内不能访问 request，先取出

    def batch():
        for v in videos:
            tid2 = db.ex("INSERT INTO tasks(dataset_id,kind,created_by,video_id) "
                         "VALUES(?,?,?,?)", (tid, "extract", uid, v["id"]))
            _tlog(tid2, "创建抽帧任务")
            _extract_worker(tid2, tid, v, fps)

    threading.Thread(target=batch, daemon=True).start()
    return jsonify({"ok": True, "count": len(videos)})


def _tlog(task_id, msg):
    db.ex("INSERT INTO task_logs(task_id,message) VALUES(?,?)", (task_id, msg))


def _extract_worker(task_id, anno_tid, v, fps):
    try:
        import cv2
        cap = cv2.VideoCapture(xlate_path(v["path"]))
        if not cap.isOpened():
            raise RuntimeError("视频无法打开")
        src_fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
        total_est = int((cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0) / src_fps * fps)
        step = max(1, int(round(src_fps / fps)))
        # 任务级图片池：平铺存储 + video_frames 数据库映射归属视频
        ds_name = f"task{anno_tid}_pool"
        frames_dir = os.path.join(BASE, "data", "frames", ds_name)
        labels_dir = os.path.join(BASE, "data", "labels", ds_name)
        os.makedirs(frames_dir, exist_ok=True)
        os.makedirs(labels_dir, exist_ok=True)
        # 续号：避免覆盖池内已有帧
        offset = len([f for f in os.listdir(frames_dir) if f.endswith(".jpg")])
        db.ex("UPDATE tasks SET status='running',message=? WHERE id=?", (ds_name, task_id))
        _tlog(task_id, f"开始抽帧 {v['orig_name']} @ {fps}fps（图片池已有 {offset} 帧）")
        n, idx = 0, 0
        while True:
            if idx % 50 == 0 and db.q1("SELECT status FROM tasks WHERE id=?",
                                       (task_id,))["status"] == "cancelling":
                cap.release()
                db.ex("UPDATE tasks SET status='cancelled',message=? WHERE id=?",
                      (f"已停止（{n} 帧）", task_id))
                _tlog(task_id, f"抽帧被用户停止，已抽 {n} 帧")
                return
            ok, frame = cap.read()
            if not ok:
                break
            if idx % step == 0:
                n += 1
                ok2, buf = cv2.imencode(".jpg", frame,
                                        [cv2.IMWRITE_JPEG_QUALITY, 90])
                if ok2:
                    with open(os.path.join(frames_dir, f"f_{n + offset:05d}.jpg"), "wb") as fh:
                        fh.write(buf.tobytes())
                else:
                    n -= 1
                if n % 20 == 0:
                    prog = min(0.95, n / total_est) if total_est else 0.5
                    db.ex("UPDATE tasks SET progress=?,message=? WHERE id=?",
                          (prog, f"已抽 {n} 帧", task_id))
            idx += 1
        cap.release()
        exist = db.q1("SELECT id FROM datasets WHERE name=?", (ds_name,))
        if exist:
            did = exist["id"]
        else:
            did = db.ex("INSERT INTO datasets(name,frame_dir,label_dir,classes_json,status,created_by) "
                        "VALUES(?,?,?,?,?,?)",
                        (ds_name, frames_dir, labels_dir, '["excavator"]', 'pending', None))
        # 记录该视频在池中的帧区间（多次抽帧自动延展）
        row = db.q1("SELECT frame_start,frame_end FROM anno_task_videos "
                    "WHERE task_id=? AND video_id=?", (anno_tid, v["id"]))
        if row and row["frame_start"] is not None:
            db.ex("UPDATE anno_task_videos SET frame_end=? WHERE task_id=? AND video_id=?",
                  (row["frame_end"] + n, anno_tid, v["id"]))
        elif row:
            db.ex("UPDATE anno_task_videos SET frame_start=?,frame_end=? "
                  "WHERE task_id=? AND video_id=?",
                  (offset, offset + n - 1, anno_tid, v["id"]))
        # 写入视频→帧映射（按文件名归属视频）
        for k in range(n):
            fn = f"f_{k + offset + 1:05d}.jpg"
            db.ex("INSERT OR IGNORE INTO video_frames(task_id,video_id,frame_file) "
                  "VALUES(?,?,?)", (anno_tid, v["id"], fn))
        db.ex("UPDATE tasks SET status='done',progress=1,message=? WHERE id=?",
              (f"共 {n} 帧", task_id))
        _tlog(task_id, f"抽帧完成，共 {n} 帧（池区间 {offset}~{offset + n - 1}），"
                       f"已生成数据集「{ds_name}」")
    except Exception as e:
        db.ex("UPDATE tasks SET status='failed',message=? WHERE id=?", (str(e)[:300], task_id))
        _tlog(task_id, f"抽帧失败: {e}")


@bp.route("/api/anno_tasks/<int:tid>", methods=["PATCH"])
@require("admin", "lead", "annotator")
def api_patch_task(tid):
    """任务编辑：标签集 / 置信度 / 备注。"""
    d = request.get_json(force=True, silent=True) or {}
    if "name" in d:
        name = str(d["name"]).strip()
        if not name:
            return jsonify({"err": "任务名不能为空"}), 400
        if db.q1("SELECT 1 FROM anno_tasks WHERE name=? AND id<>?", (name, tid)):
            return jsonify({"err": "已存在同名任务"}), 400
        db.ex("UPDATE anno_tasks SET name=? WHERE id=?", (name, tid))
    if "classes" in d:
        def uniq_color(i):
            # 黄金角分布 HSL -> HEX，任意数量颜色不重复
            import colorsys
            h = (i * 137.508) % 360 / 360
            r, g, b = colorsys.hls_to_rgb(h, 0.55, 0.65)
            return "#{:02x}{:02x}{:02x}".format(int(r * 255), int(g * 255), int(b * 255))
        used = set()
        norm = []
        for c in d["classes"]:
            if isinstance(c, dict):
                name = str(c.get("name", "")).strip()
                color = str(c.get("color", "")).strip()
            else:
                name = str(c).strip()
                color = ""
            if not name:
                continue
            if not color or color in used:      # 缺失或重复 -> 分配新唯一色
                i = 0
                color = uniq_color(len(norm))
                while color in used:
                    i += 1
                    color = uniq_color(len(norm) + i * 7)
            used.add(color)
            norm.append({"name": name, "color": color})
        if not norm:
            return jsonify({"err": "标签集不能为空"}), 400
        db.ex("UPDATE anno_tasks SET classes_json=? WHERE id=?",
              (json.dumps(norm, ensure_ascii=False), tid))
    if "conf" in d:
        try:
            conf = float(d["conf"])
        except (TypeError, ValueError):
            return jsonify({"err": "置信度须为数字"}), 400
        if not (0.001 <= conf <= 0.9):
            return jsonify({"err": "置信度须在 0.001~0.9"}), 400
        db.ex("UPDATE anno_tasks SET conf=? WHERE id=?", (conf, tid))
    if "note" in d:
        db.ex("UPDATE anno_tasks SET note=? WHERE id=?", (d.get("note") or "", tid))
    db.audit(request.user["id"], "patch_task", tid, d)
    return jsonify(db.q1("SELECT * FROM anno_tasks WHERE id=?", (tid,)))


@bp.route("/api/anno_tasks/<int:tid>/prelabel", methods=["POST"])
@require("admin", "lead", "annotator")
def api_prelabel(tid):
    """自动标注：YOLO-World 检测 + SAM2 精修，写回任务池标签。"""
    t = db.q1("SELECT * FROM anno_tasks WHERE id=?", (tid,))
    if not t:
        return jsonify({"err": "task not found"}), 404
    ds = db.q1("SELECT * FROM datasets WHERE name=?", (f"task{tid}_pool",))
    if not ds or not os.path.isdir(xlate_path(ds["frame_dir"])):
        return jsonify({"err": "任务池尚无帧，请先抽帧"}), 400
    if db.q1("SELECT 1 FROM tasks WHERE dataset_id=? AND kind='prelabel' "
             "AND status IN ('queued','running')", (tid,)):
        return jsonify({"err": "已有自动标注任务在进行"}), 409
    d = request.get_json(force=True, silent=True) or {}
    limit = int(d.get("limit", 0) or 0)   # 0 = 全部
    tid2 = db.ex("INSERT INTO tasks(dataset_id,kind,created_by) VALUES(?,?,?)",
                 (tid, "prelabel", request.user["id"]))
    _tlog(tid2, "创建自动标注任务" + (f"（测试模式：仅前 {limit} 帧）" if limit else ""))
    _cls_raw = json.loads(t["classes_json"] or '[{"name":"excavator"}]')
    _cls_names = [c["name"] if isinstance(c, dict) else str(c) for c in _cls_raw]
    threading.Thread(target=_prelabel_worker,
                     args=(tid2, tid, ds, _cls_names,
                           float(t["conf"] or 0.05), limit), daemon=True).start()
    return jsonify({"task_id": tid2})


def _prelabel_worker(task_id, anno_tid, ds, classes, conf, limit=0):
    """YOLO-World(开放词汇) 粗检 -> SAM2 精修 -> 写 YOLO 标签（含类别）。"""
    try:
        import sys as _sys
        RELABEL = os.environ.get("RELABEL_DIR", "")
        if not RELABEL:
            for _cand in ("/mnt/hgfs/VMShare/datasets/relabel_gpu",
                          "D:\\VMShare\\datasets\\relabel_gpu"):
                if os.path.isdir(_cand):
                    RELABEL = _cand
                    break
        if not RELABEL:
            raise RuntimeError("未找到自动标注引擎目录 relabel_gpu")
        if RELABEL not in _sys.path:
            _sys.path.insert(0, RELABEL)
        import cv2
        import numpy as np
        from ultralytics import YOLO
        import samlib
        weight = os.path.join(RELABEL, "yolov8s-worldv2.pt")
        model = YOLO(weight)
        model.set_classes(classes)
        import api.datasets_api as _dda
        files = _dda._frames(ds)   # 递归（含视频子目录），相对路径
        fdir = xlate_path(ds["frame_dir"])
        ldir = xlate_path(ds["label_dir"])
        os.makedirs(ldir, exist_ok=True)
        if limit and limit > 0:
            files = files[:limit]
        total = len(files)
        db.ex("UPDATE tasks SET status='running',message=? WHERE id=?",
              (f"共 {total} 帧", task_id))
        _tlog(task_id, f"开始自动标注：类别={classes} 置信度={conf} 帧数={total}")
        n_box = 0
        for i, fn in enumerate(files):
            if i % 5 == 0 and db.q1("SELECT status FROM tasks WHERE id=?",
                                    (task_id,))["status"] == "cancelling":
                db.ex("UPDATE tasks SET status='cancelled',message=?,cur_index=NULL WHERE id=?",
                      (f"已停止（{i}/{total} 帧）", task_id))
                _tlog(task_id, f"自动标注被用户停止，已标 {i}/{total} 帧")
                return
            path = os.path.join(fdir, *fn.split("/"))
            r = model.predict(path, conf=conf, verbose=False)[0]
            img = cv2.imread(path)
            H, W = img.shape[:2]
            cands = []
            clss = list(r.boxes.cls) if r.boxes.cls is not None else []
            for bi, b in enumerate(r.boxes.xyxy):
                x1, y1, x2, y2 = [float(v) for v in b]
                if (x2 - x1) * (y2 - y1) > 0.6 * W * H:
                    continue
                ci = int(clss[bi]) if bi < len(clss) else 0
                rb = samlib.refine_box(path, (x1, y1, x2, y2))
                cands.append((rb if rb else (x1, y1, x2, y2), ci))
            # 同帧去重
            kept = []
            for (b, ci) in sorted(cands, key=lambda x: -(x[0][2]-x[0][0])*(x[0][3]-x[0][1])):
                dup = False
                for (k, _) in kept:
                    ix1, iy1 = max(b[0], k[0]), max(b[1], k[1])
                    ix2, iy2 = min(b[2], k[2]), min(b[3], k[3])
                    inter = max(0, ix2-ix1) * max(0, iy2-iy1)
                    ua = (b[2]-b[0])*(b[3]-b[1]) + (k[2]-k[0])*(k[3]-k[1]) - inter
                    if ua > 0 and inter / ua > 0.45:
                        dup = True; break
                if not dup:
                    kept.append((b, ci))
            lines = []
            for (b, ci) in kept:
                cx, cy = (b[0]+b[2])/2/W, (b[1]+b[3])/2/H
                lines.append(f"{ci} {cx:.6f} {cy:.6f} {(b[2]-b[0])/W:.6f} {(b[3]-b[1])/H:.6f}")
            with open(os.path.join(ldir, *os.path.splitext(fn)[0].split("/")) + ".txt", "w") as fh:
                fh.write("\n".join(lines) + ("\n" if lines else ""))
            n_box += len(kept)
            # 逐帧上报当前进度与正在标注的帧索引（前端列表同步显示“标注中...”）
            db.ex("UPDATE tasks SET progress=?,message=?,cur_index=? WHERE id=?",
                  (min(0.95, (i + 1) / max(1, total)), f"已标 {i+1}/{total} 帧",
                   i, task_id))
        db.ex("UPDATE tasks SET status='done',progress=1,message=?,cur_index=NULL WHERE id=?",
              (f"共 {n_box} 个框", task_id))
        _tlog(task_id, f"自动标注完成：{total} 帧共 {n_box} 个框")
    except Exception as e:
        import traceback
        db.ex("UPDATE tasks SET status='failed',message=?,cur_index=NULL WHERE id=?",
              (str(e)[:300], task_id))
        _tlog(task_id, "自动标注失败: " + str(e)[:200])


@bp.route("/api/anno_tasks/<int:tid>/videos", methods=["POST"])
@require("admin", "lead", "annotator")
def api_add_videos(tid):
    """向任务追加视频。"""
    if not db.q1("SELECT 1 FROM anno_tasks WHERE id=?", (tid,)):
        return jsonify({"err": "task not found"}), 404
    d = request.get_json(force=True, silent=True) or {}
    ids = d.get("video_ids", [])
    added = 0
    for vid in ids:
        if db.q1("SELECT 1 FROM videos WHERE id=?", (vid,)) and \
           not db.q1("SELECT 1 FROM anno_task_videos WHERE task_id=? AND video_id=?",
                     (tid, vid)):
            db.ex("INSERT INTO anno_task_videos(task_id,video_id) VALUES(?,?)", (tid, vid))
            added += 1
    db.audit(request.user["id"], "task_add_videos", tid, f"+{len(ids)}")
    return jsonify({"ok": True, "added": added})


@bp.route("/api/anno_tasks/<int:tid>/logs")
@require()
def api_task_logs(tid):
    """该标注任务下所有后台任务的状态与日志。"""
    tasks = db.q("SELECT id,kind,status,progress,message,video_id,cur_index FROM tasks "
                 "WHERE dataset_id=? ORDER BY id", (tid,))
    out = []
    for t in tasks:
        logs = db.q("SELECT message,at FROM task_logs WHERE task_id=? ORDER BY id", (t["id"],))
        out.append({"task_id": t["id"], "kind": t["kind"], "status": t["status"],
                    "progress": t["progress"], "message": t["message"],
                    "video_id": t["video_id"], "cur_index": t["cur_index"],
                    "logs": [l["message"] for l in logs]})
    return jsonify(out)


@bp.route("/api/anno_tasks/<int:tid>")
@require()
def api_detail(tid):
    t = db.q1("""SELECT t.*, u.username creator FROM anno_tasks t
                 LEFT JOIN users u ON u.id=t.created_by WHERE t.id=?""", (tid,))
    if not t:
        return jsonify({"err": "not found"}), 404
    vids = db.q("""SELECT v.id, v.orig_name, v.duration, v.width, v.height,
                          tv.frame_start, tv.frame_end
                   FROM anno_task_videos tv JOIN videos v ON v.id=tv.video_id
                   WHERE tv.task_id=?""", (tid,))
    t["videos"] = vids
    return jsonify(t)


@bp.route("/api/anno_tasks/<int:tid>/video_frames/<int:vid>", methods=["DELETE"])
@require("admin", "lead", "annotator")
def api_del_video_frames(tid, vid):
    """删除某视频在任务池中的全部帧及标签，并平移其他视频的帧区间。"""
    t = db.q1("SELECT * FROM anno_tasks WHERE id=?", (tid,))
    v = db.q1("SELECT * FROM videos WHERE id=?", (vid,))
    if not t or not v:
        return jsonify({"err": "not found"}), 404
    row = db.q1("SELECT frame_start,frame_end FROM anno_task_videos "
                "WHERE task_id=? AND video_id=?", (tid, vid))
    if not row or row["frame_start"] is None:
        return jsonify({"err": "该视频尚未抽帧"}), 400
    s0, e0 = row["frame_start"], row["frame_end"]
    n = e0 - s0 + 1
    ds = db.q1("SELECT * FROM datasets WHERE name=?", (f"task{tid}_pool",))
    fdir = xlate_path(ds["frame_dir"]) if ds else None
    ldir = xlate_path(ds["label_dir"]) if ds else None
    if fdir:
        vfs = [r["frame_file"] for r in db.q(
            "SELECT frame_file FROM video_frames WHERE task_id=? AND video_id=? ORDER BY frame_file",
            (tid, vid))]
        if not vfs:   # 旧数据兜底：按区间
            files = sorted(f for f in os.listdir(fdir) if f.lower().endswith(".jpg"))
            vfs = files[s0:e0 + 1]
        for rel in vfs:
            try:
                fp = os.path.join(fdir, *rel.split("/"))
                if os.path.exists(fp):
                    os.remove(fp)
                if ldir:
                    lp = os.path.join(ldir, *os.path.splitext(rel)[0].split("/")) + ".txt"
                    if os.path.exists(lp):
                        os.remove(lp)
                if ds:
                    db.ex("DELETE FROM reviewed_frames WHERE dataset_id=? AND frame_file=?",
                          (ds["id"], rel))
            except OSError:
                pass
    # 清空该视频区间，平移其他视频区间
    db.ex("UPDATE anno_task_videos SET frame_start=NULL,frame_end=NULL "
          "WHERE task_id=? AND video_id=?", (tid, vid))
    for r in db.q("SELECT task_id,video_id,frame_start,frame_end FROM anno_task_videos "
                  "WHERE task_id=?", (tid,)):
        if r["video_id"] != vid and r["frame_start"] is not None:
            ns = r["frame_start"] - n if r["frame_start"] > e0 else r["frame_start"]
            ne = r["frame_end"] - n if r["frame_end"] > e0 else r["frame_end"]
            db.ex("UPDATE anno_task_videos SET frame_start=?,frame_end=? "
                  "WHERE task_id=? AND video_id=?", (ns, ne, tid, r["video_id"]))
    db.ex("DELETE FROM video_frames WHERE task_id=? AND video_id=?", (tid, vid))
    db.ex("DELETE FROM anno_task_videos WHERE task_id=? AND video_id=?", (tid, vid))
    db.audit(request.user["id"], "delete_video_frames",
             f"{t['name']}/{v['orig_name']}", f"{n} frames, removed from task")
    return jsonify({"ok": True, "deleted": n})


@bp.route("/api/anno_tasks/<int:tid>/export", methods=["POST"])
@require("admin", "lead", "annotator")
def api_task_export(tid):
    """导出任务池为 YOLO 数据集到指定目录。"""
    import shutil
    t = db.q1("SELECT * FROM anno_tasks WHERE id=?", (tid,))
    if not t:
        return jsonify({"err": "task not found"}), 404
    d = request.get_json(force=True, silent=True) or {}
    path = (d.get("path") or "").strip()
    fmt = d.get("format", "yolo")
    if fmt != "yolo":
        return jsonify({"err": "暂不支持该格式"}), 400
    if not path:
        return jsonify({"err": "请填写导出目录"}), 400
    ds = db.q1("SELECT * FROM datasets WHERE name=?", (f"task{tid}_pool",))
    if not ds:
        return jsonify({"err": "任务池尚无帧"}), 400
    fdir, ldir = xlate_path(ds["frame_dir"]), xlate_path(ds["label_dir"])
    # 按任务名建子目录：<导出地址>/<任务名>/{images,labels}
    safe_name = "".join(c for c in t["name"] if c not in '\\/:*?"<>|').strip() or f"task{tid}"
    out = os.path.join(xlate_path(path), safe_name)
    img_dir = os.path.join(out, "images")
    lab_dir = os.path.join(out, "labels")
    os.makedirs(img_dir, exist_ok=True)
    os.makedirs(lab_dir, exist_ok=True)
    n = 0
    import api.datasets_api as _dda
    for rel in _dda._frames(ds):
        base = rel.split("/")[-1]
        shutil.copy2(os.path.join(fdir, *rel.split("/")), os.path.join(img_dir, base))
        n += 1
        lp = os.path.join(ldir, *os.path.splitext(rel)[0].split("/")) + ".txt"
        if os.path.exists(lp):
            shutil.copy2(lp, os.path.join(lab_dir, os.path.basename(lp)))
    cls = json.loads(t["classes_json"] or '[{"name":"excavator"}]')
    names = [c["name"] if isinstance(c, dict) else c for c in cls]
    with open(os.path.join(out, "dataset.yaml"), "w", encoding="utf-8") as fh:
        fh.write("path: .\ntrain: images\nval: images\nnames:\n" +
                 "\n".join(f"  {i}: {c}" for i, c in enumerate(names)))
    db.audit(request.user["id"], "export_task", t["name"], f"{n} imgs -> {path}")
    return jsonify({"ok": True, "images": n, "path": out})


@bp.route("/api/fs/dirs")
@require()
def api_fs_dirs():
    """目录浏览器：列出指定路径下的子目录（限制在共享区内）。"""
    p = request.args.get("path", "") or "/"
    p = xlate_path(p)
    if not os.path.isdir(p):
        return jsonify({"err": "目录不存在"}), 404
    # 安全线：只允许浏览共享目录范围内
    if not (p.startswith("/mnt/hgfs/") or p.startswith("D:\\") or p == "/"):
        return jsonify({"err": "仅允许浏览共享目录"}), 403
    dirs = sorted(d for d in os.listdir(p)
                  if os.path.isdir(os.path.join(p, d)) and not d.startswith("."))
    return jsonify({"path": p, "parent": os.path.dirname(p) or "/", "dirs": dirs[:200]})


@bp.route("/api/anno_tasks/<int:tid>/export_zip")
@require()
def api_task_export_zip(tid):
    """导出任务池为 YOLO 压缩包，直接流式下载到客户端（不落服务器目录）。"""
    import io, zipfile
    from flask import send_file
    t = db.q1("SELECT * FROM anno_tasks WHERE id=?", (tid,))
    if not t:
        return jsonify({"err": "task not found"}), 404
    ds = db.q1("SELECT * FROM datasets WHERE name=?", (f"task{tid}_pool",))
    if not ds:
        return jsonify({"err": "任务池尚无帧"}), 400
    fdir, ldir = xlate_path(ds["frame_dir"]), xlate_path(ds["label_dir"])
    safe_name = "".join(c for c in t["name"] if c not in '\\/:*?"<>|').strip() or f"task{tid}"
    cls = json.loads(t["classes_json"] or '[{"name":"excavator"}]')
    names = [c["name"] if isinstance(c, dict) else c for c in cls]
    import api.datasets_api as _dda
    buf = io.BytesIO()
    n = 0
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for rel in _dda._frames(ds):
            base = rel.split("/")[-1]
            src = os.path.join(fdir, *rel.split("/"))
            if not os.path.isfile(src):
                continue
            z.write(src, f"{safe_name}/images/{base}")
            n += 1
            lp = os.path.join(ldir, *os.path.splitext(rel)[0].split("/")) + ".txt"
            if os.path.exists(lp):
                z.write(lp, f"{safe_name}/labels/{os.path.basename(lp)}")
        z.writestr(f"{safe_name}/dataset.yaml",
                   "path: .\ntrain: images\nval: images\nnames:\n" +
                   "\n".join(f"  {i}: {c}" for i, c in enumerate(names)))
    db.audit(request.user["id"], "export_task_zip", t["name"], f"{n} imgs")
    buf.seek(0)
    return send_file(buf, mimetype="application/zip", as_attachment=True,
                     download_name=f"{safe_name}_yolo.zip")


@bp.route("/api/anno_tasks/<int:tid>/publish", methods=["POST"])
@require("admin", "lead", "annotator")
def api_task_publish(tid):
    """发布数据集：导出任务池到 published 目录并登记到数据集广场。"""
    import shutil
    t = db.q1("SELECT * FROM anno_tasks WHERE id=?", (tid,))
    if not t:
        return jsonify({"err": "task not found"}), 404
    ds = db.q1("SELECT * FROM datasets WHERE name=?", (f"task{tid}_pool",))
    if not ds:
        return jsonify({"err": "任务池尚无帧"}), 400
    fdir, ldir = xlate_path(ds["frame_dir"]), xlate_path(ds["label_dir"])
    PUB_ROOT = os.environ.get("ANNOT_PUB_ROOT",
                              os.path.join(BASE, "data", "published"))
    name = (request.get_json(force=True, silent=True) or {}).get("name") or t["name"]
    out = os.path.join(PUB_ROOT, f"{name}_{tid}")
    img_dir, lab_dir = os.path.join(out, "images"), os.path.join(out, "labels")
    os.makedirs(img_dir, exist_ok=True)
    os.makedirs(lab_dir, exist_ok=True)
    n = size = 0
    import api.datasets_api as _dda
    for rel in _dda._frames(ds):
        base = rel.split("/")[-1]
        shutil.copy2(os.path.join(fdir, *rel.split("/")), os.path.join(img_dir, base))
        size += os.path.getsize(os.path.join(img_dir, base))
        n += 1
        lp = os.path.join(ldir, *os.path.splitext(rel)[0].split("/")) + ".txt"
        if os.path.exists(lp):
            shutil.copy2(lp, os.path.join(lab_dir, os.path.basename(lp)))
    cls = json.loads(t["classes_json"] or '[{"name":"excavator"}]')
    names = [c["name"] if isinstance(c, dict) else c for c in cls]
    with open(os.path.join(out, "dataset.yaml"), "w", encoding="utf-8") as fh:
        fh.write("path: .\ntrain: images\nval: images\nnames:\n" +
                 "\n".join(f"  {i}: {c}" for i, c in enumerate(names)))
    pid = db.ex("INSERT INTO published_datasets(task_id,name,path,image_count,"
                "size_bytes,classes_json,created_by) VALUES(?,?,?,?,?,?,?)",
                (tid, name, out, n, size, json.dumps(names, ensure_ascii=False),
                 request.user["id"]))
    db.audit(request.user["id"], "publish", name, f"{n} imgs")
    return jsonify({"ok": True, "id": pid, "images": n})


@bp.route("/api/tasks/<int:task_id>/cancel", methods=["POST"])
@require("admin", "lead", "annotator")
def api_task_cancel(task_id):
    t = db.q1("SELECT * FROM tasks WHERE id=?", (task_id,))
    if not t:
        return jsonify({"err": "not found"}), 404
    if t["status"] not in ("running", "queued"):
        return jsonify({"err": "任务已结束"}), 400
    db.ex("UPDATE tasks SET status='cancelling' WHERE id=?", (task_id,))
    _tlog(task_id, "收到停止请求")
    return jsonify({"ok": True})
