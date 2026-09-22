#!/usr/bin/env python3
"""数据集/帧/标注/版本/编辑锁/导出/抽帧/预标注任务 API。"""
import os, sys, json, time, threading
from flask import Blueprint, request, jsonify, send_from_directory, send_file
import db
from db import xlate_path
from auth import require

bp = Blueprint("datasets", __name__)
BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RELABEL_DIR = os.environ.get("RELABEL_DIR",
                             r"D:\VMShare\datasets\relabel_gpu")


def _ds(did):
    return db.q1("SELECT * FROM datasets WHERE id=?", (did,))


def _frames(ds):
    """递归扫描帧目录（含 v{vid}/ 视频子目录），返回相对路径列表，
    排序：先目录（按视频号数值）后文件名，保证全局序稳定。"""
    root = xlate_path(ds["frame_dir"])
    out = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames.sort(key=lambda d: (len(d), d))
        rel = os.path.relpath(dirpath, root)
        for f in filenames:
            if f.lower().endswith(".jpg"):
                out.append(f if rel == "." else f"{rel.replace(os.sep, '/')}/{f}")
    def key(r):
        d, fn = (r.split("/", 1) + [""])[:2] if "/" in r else ("", r)
        dn = int(d[1:]) if d.startswith("v") and d[1:].isdigit() else 0
        return (dn, fn)
    out.sort(key=key)
    return out


def _frame_path(ds, rel):
    return os.path.join(xlate_path(ds["frame_dir"]), *rel.split("/"))


def _label_path(ds, rel):
    return os.path.join(xlate_path(ds["label_dir"]), *rel.split("/"))


def video_frame_map(ds, tid):
    """返回 task 下 video_id -> [frame_file]（池字典序）。
    旧任务懒回填：video_frames 无记录时按 anno_task_videos 区间推导并落库。"""
    rows = db.q("SELECT video_id,frame_start,frame_end FROM anno_task_videos "
                "WHERE task_id=?", (tid,))
    have = {r["video_id"] for r in db.q(
        "SELECT DISTINCT video_id FROM video_frames WHERE task_id=?", (tid,))}
    if rows and any(r["video_id"] not in have for r in rows):
        files = _frames(ds)   # 池内字典序 = 全局帧序
        for r in rows:
            if r["video_id"] in have or r["frame_start"] is None:
                continue
            for k in range(r["frame_start"], min(r["frame_end"], len(files) - 1) + 1):
                db.ex("INSERT OR IGNORE INTO video_frames(task_id,video_id,frame_file) "
                      "VALUES(?,?,?)", (tid, r["video_id"], files[k]))
    out = {}
    for r in db.q("SELECT video_id,frame_file FROM video_frames "
                  "WHERE task_id=? ORDER BY frame_file", (tid,)):
        out.setdefault(r["video_id"], []).append(r["frame_file"])
    return out


def dataset_visible(ds, user):
    if user["role"] in ("admin", "lead"):
        return True
    # 任务池数据集：随任务对任务参与者可见（不需要手工分配）
    if ds["name"].startswith("task") and ds["name"].endswith("_pool"):
        tid = ds["name"][4:-5]
        if tid.isdigit() and db.q1(
                "SELECT 1 FROM anno_task_videos WHERE task_id=?", (int(tid),)):
            return True
    return db.q1("SELECT 1 FROM assignments WHERE dataset_id=? AND user_id=?",
                 (ds["id"], user["id"])) is not None


def _lock_status(ds, fname, user):
    """只读检查：帧是否被【他人】新近锁定（不拿锁、不写库，查看不占坑）。"""
    lk = db.q1("SELECT * FROM edit_locks WHERE dataset_id=? AND frame_file=?",
               (ds["id"], fname))
    if lk and lk["user_id"] != user["id"] and time.time() - lk["locked_at"] < 1800:
        return False
    return True


def _lock_ok(ds, fname, user):
    """编辑锁：30 分钟超时自动失效。"""
    lk = db.q1("SELECT * FROM edit_locks WHERE dataset_id=? AND frame_file=?",
               (ds["id"], fname))
    if lk and lk["user_id"] != user["id"] and time.time() - lk["locked_at"] < 1800:
        return False
    db.ex("INSERT OR REPLACE INTO edit_locks(dataset_id,frame_file,user_id,locked_at) "
          "VALUES(?,?,?,?)", (ds["id"], fname, user["id"], time.time()))
    return True


# ---------- 数据集 ----------
@bp.route("/api/datasets")
@require()
def api_datasets():
    rows = db.q("SELECT * FROM datasets ORDER BY id")
    out = []
    for r in rows:
        if not dataset_visible(r, request.user):
            continue
        try:
            fc = len(_frames(r)) if os.path.isdir(xlate_path(r["frame_dir"])) else None
        except Exception:
            fc = None
        r2 = dict(r); r2["frame_count"] = fc
        out.append(r2)
    return jsonify(out)


@bp.route("/api/datasets", methods=["POST"])
@require("admin", "lead")
def api_create_dataset():
    d = request.get_json(force=True, silent=True) or {}
    fd = d.get("frame_dir", "").strip()
    if not d.get("name") or not fd:
        return jsonify({"err": "name/frame_dir required"}), 400
    video_ext = (".mp4", ".avi", ".mov", ".mkv", ".flv", ".wmv")
    if not os.path.isdir(fd) and not (os.path.isfile(fd) and fd.lower().endswith(video_ext)):
        return jsonify({"err": f"frame_dir 不存在: {fd}"}), 400
    try:
        did = db.ex("INSERT INTO datasets(name,frame_dir,label_dir,classes_json,status,created_by) "
                    "VALUES(?,?,?,?,?,?)",
                    (d["name"], fd, d.get("label_dir") or
                     os.path.join(os.path.dirname(fd.rstrip("\\/")), "labels"),
                     json.dumps(d.get("classes", ["excavator"])), "pending",
                     request.user["id"]))
    except Exception:
        return jsonify({"err": "数据集名已存在"}), 400
    db.audit(request.user["id"], "create_dataset", d["name"])
    return jsonify(_ds(did))


@bp.route("/api/datasets/<int:did>", methods=["PATCH"])
@require("admin", "lead")
def api_patch_dataset(did):
    d = request.get_json(force=True, silent=True) or {}
    if "classes" in d:
        db.ex("UPDATE datasets SET classes_json=? WHERE id=?",
              (json.dumps(d["classes"]), did))
    if "status" in d:
        db.ex("UPDATE datasets SET status=? WHERE id=?", (d["status"], did))
    db.audit(request.user["id"], "patch_dataset", did, d)
    return jsonify(_ds(did))


@bp.route("/api/datasets/<int:did>/assign", methods=["POST"])
@require("admin", "lead")
def api_assign(did):
    d = request.get_json(force=True, silent=True) or {}
    uid = d.get("user_id")
    if not db.q1("SELECT 1 FROM users WHERE id=? AND is_active=1", (uid,)):
        return jsonify({"err": "用户不存在"}), 404
    db.ex("INSERT OR IGNORE INTO assignments(dataset_id,user_id) VALUES(?,?)", (did, uid))
    return jsonify({"ok": True})


# ---------- 抽帧 ----------
@bp.route("/api/ds/<int:did>/extract", methods=["POST"])
@require("admin", "lead")
def api_extract(did):
    """用 OpenCV 从视频抽帧，生成 frames/ 与 labels/ 目录。"""
    ds = _ds(did)
    if not ds:
        return jsonify({"err": "not found"}), 404
    d = request.get_json(force=True, silent=True) or {}
    fps = float(d.get("fps", 5.0))
    video = d.get("video_path", "")
    if not video or not os.path.isfile(video):
        return jsonify({"err": "video_path 不存在，请先上传"}), 400
    if fps <= 0 or fps > 30:
        return jsonify({"err": "fps 须在 0~30"}), 400
    import cv2
    cap = cv2.VideoCapture(video)
    if not cap.isOpened():
        return jsonify({"err": "视频无法打开"}), 400
    src_fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    step = max(1, int(round(src_fps / fps)))
    frames_dir = os.path.join(BASE, "data", "frames", ds["name"])
    labels_dir = os.path.join(BASE, "data", "labels", ds["name"])
    os.makedirs(frames_dir, exist_ok=True)
    os.makedirs(labels_dir, exist_ok=True)
    n, idx = 0, 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        if idx % step == 0:
            n += 1
            cv2.imwrite(os.path.join(frames_dir, f"f_{n:05d}.jpg"), frame,
                        [cv2.IMWRITE_JPEG_QUALITY, 90])
        idx += 1
    cap.release()
    db.ex("UPDATE datasets SET frame_dir=?, label_dir=?, status='pending' WHERE id=?",
          (frames_dir, labels_dir, did))
    db.audit(request.user["id"], "extract", ds["name"], f"{n} frames @ {fps}fps")
    return jsonify({"ok": True, "frames": n, "frame_dir": frames_dir})


# ---------- 帧与标注 ----------
@bp.route("/api/ds/<int:did>/frames")
@require()
def api_frames(did):
    ds = _ds(did)
    if not ds or not dataset_visible(ds, request.user):
        return jsonify({"err": "forbidden"}), 403
    vid = request.args.get("video_id", type=int)
    tid = request.args.get("task_id", type=int)
    vf_set = None
    if vid and tid:   # 只看某视频的帧（返回的全局索引 i 不变，定位/标注不受影响）
        vf = video_frame_map(ds, tid).get(vid, [])
        vf_set = set(vf)
    items = []
    reviewed = {r["frame_file"] for r in db.q(
        "SELECT frame_file FROM reviewed_frames WHERE dataset_id=?", (ds["id"],))}
    for i, f in enumerate(_frames(ds)):
        if vf_set is not None and f not in vf_set:
            continue
        p = _label_path(ds, os.path.splitext(f)[0] + ".txt")
        n = len(open(p).read().strip().splitlines()) if os.path.exists(p) else -1
        items.append({"i": i, "gi": i, "file": f, "boxes": n,
                      "reviewed": 1 if f in reviewed else 0})
    return jsonify(items)


@bp.route("/api/ds/<int:did>/frame/<int:idx>")
def api_frame(did, idx):
    # <img> 标签无法携带 Authorization 头，支持 ?token= 查询参数认证
    token = request.args.get("token", "") or \
        request.headers.get("Authorization", "").removeprefix("Bearer ").strip()
    u = db.q1("SELECT u.* FROM tokens t JOIN users u ON u.id=t.user_id "
              "WHERE t.token=? AND u.is_active=1", (token,))
    if not u:
        return jsonify({"err": "unauthorized"}), 401
    ds = _ds(did)
    fs = _frames(ds)
    if not (0 <= idx < len(fs)):
        return jsonify({"err": "bad index"}), 404
    return send_file(_frame_path(ds, fs[idx]))


@bp.route("/api/ds/<int:did>/label/<int:idx>")
@require()
def api_get_label(did, idx):
    ds = _ds(did)
    f = _frames(ds)[idx]
    p = _label_path(ds, os.path.splitext(f)[0] + ".txt")
    boxes = []
    if os.path.exists(p):
        for line in open(p):
            s = line.split()
            if len(s) == 5:   # 矩形: cls cx cy w h
                cls = int(float(s[0]))
                cx, cy, w, h = map(float, s[1:5])
                boxes.append([cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2, cls])
            elif len(s) >= 7 and len(s) % 2 == 1:   # 多边形: cls x1 y1 x2 y2 ...
                cls = int(float(s[0]))
                pts = [float(v) for v in s[1:]]
                boxes.append(["poly", cls] + pts)
    ok = _lock_status(ds, f, request.user)
    return jsonify({"boxes": boxes, "locked": ok})


@bp.route("/api/ds/<int:did>/label/<int:idx>", methods=["POST"])
@require()
def api_save_label(did, idx):
    ds = _ds(did)
    f = _frames(ds)[idx]
    boxes = request.get_json(force=True).get("boxes", [])
    for b in boxes:
        if b and b[0] == "poly":
            if len(b) < 8 or len(b) % 2 == 1 or \
               not all(0 <= float(v) <= 1 for v in b[2:]):
                return jsonify({"err": "bad polygon"}), 400
        elif (len(b) not in (4, 5) or not all(0 <= v <= 1 for v in b[:4])
                or b[2] - b[0] < 0.001 or b[3] - b[1] < 0.001):
            return jsonify({"err": "bad box"}), 400
    if not _lock_ok(ds, f, request.user):
        return jsonify({"err": "帧正被他人编辑"}), 423
    os.makedirs(xlate_path(ds["label_dir"]), exist_ok=True)
    p = _label_path(ds, os.path.splitext(f)[0] + ".txt")
    lines = []
    for b in boxes:
        if b and b[0] == "poly":
            cls = int(b[1])
            lines.append(str(cls) + " " +
                         " ".join(f"{float(v):.6f}" for v in b[2:]))
        else:
            cls = int(b[4]) if len(b) > 4 else 0
            cx, cy = (b[0] + b[2]) / 2, (b[1] + b[3]) / 2
            lines.append(f"{cls} {cx:.6f} {cy:.6f} {b[2]-b[0]:.6f} {b[3]-b[1]:.6f}")
    with open(p, "w") as fh:
        fh.write("\n".join(lines) + ("\n" if lines else ""))
    db.ex("INSERT INTO label_versions(dataset_id,frame_file,user_id,content_json) "
          "VALUES(?,?,?,?)", (did, f, request.user["id"], json.dumps(boxes)))
    db.ex("INSERT OR REPLACE INTO reviewed_frames(dataset_id,frame_file,user_id) "
          "VALUES(?,?,?)", (did, f, request.user["id"]))
    db.audit(request.user["id"], "save_label", f"{ds['name']}/{f}", f"{len(boxes)} boxes")
    return jsonify({"ok": True, "version": db.q1(
        "SELECT MAX(id) v FROM label_versions WHERE dataset_id=? AND frame_file=?",
        (did, f))["v"]})


@bp.route("/api/ds/<int:did>/versions/<path:fname>")
@require()
def api_versions(did, fname):
    return jsonify(db.q("SELECT id,user_id,content_json,saved_at FROM label_versions "
                        "WHERE dataset_id=? AND frame_file=? ORDER BY id DESC LIMIT 50",
                        (did, fname)))


# ---------- 导出 ----------
@bp.route("/api/ds/<int:did>/export")
@require("admin", "lead")
def api_export(did):
    import zipfile, tempfile
    ds = _ds(did)
    fs = _frames(ds)
    tmp = os.path.join(tempfile.gettempdir(), f"export_{did}.zip")
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_STORED) as z:
        for i, f in enumerate(fs):
            split = "val" if i % 10 in (8, 9) else "train"
            z.write(_frame_path(ds, f), f"images/{split}/{f}")
            lp = _label_path(ds, os.path.splitext(f)[0] + ".txt")
            if os.path.exists(lp):
                z.write(lp, f"labels/{split}/{os.path.basename(lp)}")
        classes = json.loads(ds["classes_json"])
        z.writestr("dataset.yaml",
                   "path: .\ntrain: images/train\nval: images/val\nnames:\n" +
                   "\n".join(f"  {i}: {c}" for i, c in enumerate(classes)))
    db.audit(request.user["id"], "export", ds["name"])
    return send_file(tmp, as_attachment=True, download_name=f"{ds['name']}_yolo.zip")


# ---------- 预标注任务（接入 relabel_v4 引擎） ----------
def _prelabel_worker(task_id, ds, conf, imgsz):
    try:
        sys.path.insert(0, RELABEL_DIR)
        os.environ.setdefault("RELABEL_SKIP_VLM", "1")
        import importlib
        import relabel_v4
        importlib.reload(relabel_v4)
        relabel_v4.CONF = conf
        relabel_v4.IMGSZ = imgsz
        relabel_v4.FORCE_DIR = ds["frame_dir"]
        db.ex("UPDATE tasks SET status='running' WHERE id=?", (task_id,))
        relabel_v4.run(ds["name"])
        db.ex("UPDATE tasks SET status='done',progress=1 WHERE id=?", (task_id,))
    except Exception as e:
        db.ex("UPDATE tasks SET status='failed',message=? WHERE id=?", (str(e)[:500], task_id))


@bp.route("/api/ds/<int:did>/prelabel", methods=["POST"])
@require("admin", "lead")
def api_prelabel(did):
    ds = _ds(did)
    if not ds:
        return jsonify({"err": "not found"}), 404
    d = request.get_json(force=True, silent=True) or {}
    tid = db.ex("INSERT INTO tasks(dataset_id,kind,created_by) VALUES(?,?,?)",
                (did, "prelabel", request.user["id"]))
    th = threading.Thread(target=_prelabel_worker,
                          args=(tid, ds, float(d.get("conf", 0.05)),
                                int(d.get("imgsz", 1280))), daemon=True)
    th.start()
    return jsonify({"task_id": tid})


@bp.route("/api/tasks/<int:tid>")
@require()
def api_task(tid):
    return jsonify(db.q1("SELECT * FROM tasks WHERE id=?", (tid,)))


@bp.route("/api/ds/<int:did>/frame/<int:idx>", methods=["DELETE"])
@require("admin", "lead", "annotator")
def api_del_frame(did, idx):
    """删除帧图片及其标签文件（不可逆）。"""
    ds = _ds(did)
    fs = _frames(ds)
    if not (0 <= idx < len(fs)):
        return jsonify({"err": "bad index"}), 404
    f = fs[idx]
    fpath = _frame_path(ds, f)
    try:
        os.remove(fpath)
    except OSError as e:
        return jsonify({"err": f"文件被占用，删除失败（{e}），请稍后重试"}), 409
    if os.path.exists(fpath):   # 双保险：确认真删掉了
        return jsonify({"err": "删除未生效（文件仍存在），请稍后重试"}), 409
    lp = _label_path(ds, os.path.splitext(f)[0] + ".txt")
    if os.path.exists(lp):
        try:
            os.remove(lp)
        except OSError:
            pass   # 标签文件删除失败不阻塞，但图片必须删掉才算成功
    db.ex("DELETE FROM reviewed_frames WHERE dataset_id=? AND frame_file=?", (did, f))
    db.ex("DELETE FROM video_frames WHERE frame_file=?", (f,))   # 同步清视频映射
    db.ex("DELETE FROM edit_locks WHERE dataset_id=? AND frame_file=?", (did, f))
    db.audit(request.user["id"], "delete_frame", f"{ds['name']}/{f}")
    return jsonify({"ok": True})


@bp.route("/api/ds/<int:did>/review/<int:idx>", methods=["POST"])
@require("admin", "lead", "annotator")
def api_review_frame(did, idx):
    """标记帧为已人工复核（不改标注内容）。"""
    ds = _ds(did)
    fs = _frames(ds)
    if not (0 <= idx < len(fs)):
        return jsonify({"err": "bad index"}), 404
    db.ex("INSERT OR REPLACE INTO reviewed_frames(dataset_id,frame_file,user_id) "
          "VALUES(?,?,?)", (did, fs[idx], request.user["id"]))
    return jsonify({"ok": True})


# ---------- 标签统计 / 批量改名 ----------

def _scope_gis(ds, task_id, body):
    """解析统计/改名范围：{video_id} 或 {gis:[全局帧号]}；返回 (gi_list, err)。"""
    if body.get("video_id"):
        vf = video_frame_map(ds, task_id).get(int(body["video_id"]), [])
        files = _frames(ds)
        pos = {f: k for k, f in enumerate(files)}
        return sorted(pos[f] for f in vf if f in pos), None
    gis = body.get("gis")
    if not isinstance(gis, list):
        return None, "缺少范围（video_id 或 gis）"
    try:
        return sorted({int(g) for g in gis}), None
    except Exception:
        return None, "gis 格式错误"


def _cls_count(ds, gi):
    """某帧 YOLO txt 里各类别计数。"""
    f = _frames(ds)[gi]
    p = _label_path(ds, os.path.splitext(f)[0] + ".txt")
    cnt = {}
    if os.path.exists(p):
        for line in open(p):
            s = line.split()
            if s:
                try:
                    c = int(float(s[0]))
                    cnt[c] = cnt.get(c, 0) + 1
                except ValueError:
                    pass
    return cnt


@bp.route("/api/ds/<int:did>/label_stats", methods=["POST"])
@require()
def api_label_stats(did):
    """标签统计：{task_id, video_id} 或 {task_id, gis:[...]}。"""
    ds = _ds(did)
    if not ds:
        return jsonify({"err": "dataset not found"}), 404
    body = request.get_json(force=True, silent=True) or {}
    gis, err = _scope_gis(ds, body.get("task_id"), body)
    if err:
        return jsonify({"err": err}), 400
    files = _frames(ds)
    cnt = {}
    n_frame = 0
    for gi in gis:
        if not (0 <= gi < len(files)):
            continue
        c = _cls_count(ds, gi)
        if c:
            n_frame += 1
            for k, v in c.items():
                cnt[k] = cnt.get(k, 0) + v
    return jsonify({"ok": True, "frames": n_frame,
                    "stats": [{"cls": k, "count": v} for k, v in sorted(cnt.items())]})


@bp.route("/api/ds/<int:did>/rename_label", methods=["POST"])
@require("admin", "lead", "annotator")
def api_rename_label(did):
    """批量替换标签：把范围内 cls==from 的框改为 to（写回 YOLO txt，逐帧备份）。"""
    ds = _ds(did)
    if not ds:
        return jsonify({"err": "dataset not found"}), 404
    body = request.get_json(force=True, silent=True) or {}
    gis, err = _scope_gis(ds, body.get("task_id"), body)
    if err:
        return jsonify({"err": err}), 400
    src, dst = int(body.get("from", -1)), int(body.get("to", -1))
    if src < 0 or dst < -1 or src == dst:   # dst=-1 = 删除模式，合法
        return jsonify({"err": "from/to 无效"}), 400
    delete_mode = (dst == -1)   # to=-1：删除该类标注
    files = _frames(ds)
    ldir = xlate_path(ds["label_dir"])
    changed, touched, failed = 0, 0, []
    for gi in gis:
        if not (0 <= gi < len(files)):
            continue
        f = files[gi]
        p = os.path.join(ldir, os.path.splitext(f)[0] + ".txt")
        if not os.path.exists(p):
            continue
        try:
            lines = open(p).read().splitlines()
            out, hit = [], 0
            for ln in lines:
                s = ln.split()
                if len(s) >= 2:
                    try:
                        c = int(float(s[0]))
                    except ValueError:
                        out.append(ln); continue
                    if c == src:
                        if not delete_mode:
                            s[0] = str(dst)
                            out.append(" ".join(s))
                        hit += 1   # delete_mode：不回写，直接丢弃该行
                        continue
                out.append(ln)
            if hit:
                bdir = os.path.join(ldir, "_rename_backup")
                os.makedirs(bdir, exist_ok=True)
                if not os.path.exists(os.path.join(bdir, os.path.basename(p))):
                    import shutil
                    shutil.copy2(p, os.path.join(bdir, os.path.basename(p)))
                with open(p, "w") as fh:
                    fh.write("\n".join(out) + ("\n" if out else ""))
                changed += hit
                touched += 1
        except OSError as e:
            failed.append(f)
    db.audit(request.user["id"], "rename_label",
             f"{ds['name']} cls {src}->{dst} frames={touched} boxes={changed}")
    return jsonify({"ok": True, "frames": touched, "boxes": changed,
                    "failed": failed[:10]})


@bp.route("/api/ds/<int:did>/rename_label/undo", methods=["POST"])
@require("admin", "lead")
def api_rename_undo(did):
    """撤销最近一次批量改名：从 _rename_backup 还原（admin/lead）。"""
    ds = _ds(did)
    ldir = xlate_path(ds["label_dir"])
    bdir = os.path.join(ldir, "_rename_backup")
    if not os.path.isdir(bdir):
        return jsonify({"err": "没有可撤销的改名备份"}), 404
    n = 0
    import shutil
    for f in os.listdir(bdir):
        shutil.copy2(os.path.join(bdir, f), os.path.join(ldir, f))
        n += 1
    shutil.rmtree(bdir, ignore_errors=True)
    db.audit(request.user["id"], "rename_label_undo", f"{ds['name']} frames={n}")
    return jsonify({"ok": True, "frames": n})
