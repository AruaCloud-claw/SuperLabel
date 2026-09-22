#!/usr/bin/env python3
"""原始视频文件 API：上传(多文件)/列表/删除/播放流。"""
import os
from flask import Blueprint, request, jsonify, send_file
import db
from db import xlate_path
from auth import require

bp = Blueprint("videos", __name__)
BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UPLOAD_DIR = os.environ.get("ANNOT_UPLOAD_DIR",
                            os.path.join(BASE, "data", "uploads"))
VIDEO_EXT = (".mp4", ".avi", ".mov", ".mkv", ".flv", ".wmv", ".webm")


def _probe_video(path):
    """cv2 读取视频元信息，失败返回默认值。"""
    try:
        import cv2
        cap = cv2.VideoCapture(path)
        if cap.isOpened():
            fps = cap.get(cv2.CAP_PROP_FPS) or 0
            n = cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0
            meta = {"width": int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)),
                    "height": int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)),
                    "fps": round(fps, 2),
                    "duration": round(n / fps, 1) if fps else 0}
            cap.release()
            return meta
    except Exception:
        pass
    return {"width": 0, "height": 0, "fps": 0, "duration": 0}


@bp.route("/api/videos")
@require()
def api_videos():
    return jsonify(db.q(
        "SELECT v.*, u.username uploader FROM videos v "
        "LEFT JOIN users u ON u.id=v.uploaded_by ORDER BY v.id DESC"))


@bp.route("/api/videos", methods=["POST"])
@require("admin", "lead")
def api_upload_videos():
    files = request.files.getlist("videos") or request.files.getlist("video")
    if not files:
        return jsonify({"err": "no files"}), 400
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    saved, skipped = [], []
    for f in files:
        name = f.filename.replace("\\", "_").replace("/", "_")
        if not name.lower().endswith(VIDEO_EXT):
            skipped.append((name, "格式不支持")); continue
        path = os.path.join(UPLOAD_DIR, name)
        if os.path.exists(path):
            skipped.append((name, "同名文件已存在")); continue
        f.save(path)
        meta = _probe_video(path)
        vid = db.ex(
            "INSERT INTO videos(orig_name,path,size,duration,width,height,fps,uploaded_by) "
            "VALUES(?,?,?,?,?,?,?,?)",
            (name, path, os.path.getsize(path), meta["duration"], meta["width"],
             meta["height"], meta["fps"], request.user["id"]))
        saved.append({"id": vid, "name": name})
    db.audit(request.user["id"], "upload_videos", f"{len(saved)} saved")
    return jsonify({"ok": True, "saved": saved, "skipped": skipped})


@bp.route("/api/videos/<int:vid>", methods=["DELETE"])
@require("admin", "lead")
def api_del_video(vid):
    v = db.q1("SELECT * FROM videos WHERE id=?", (vid,))
    if not v:
        return jsonify({"err": "not found"}), 404
    try:
        os.remove(xlate_path(v["path"]))
    except OSError:
        pass
    db.ex("DELETE FROM videos WHERE id=?", (vid,))
    db.audit(request.user["id"], "delete_video", v["orig_name"])
    return jsonify({"ok": True})


@bp.route("/api/videos/<int:vid>/thumb")
def api_video_thumb(vid):
    """视频缩略图（取 1s 处一帧），带缓存。无需 token（仅限内网低敏图）。"""
    v = db.q1("SELECT * FROM videos WHERE id=?", (vid,))
    if not v:
        return jsonify({"err": "not found"}), 404
    thumb_dir = os.path.join(BASE, "data", "thumbs")
    os.makedirs(thumb_dir, exist_ok=True)
    thumb = os.path.join(thumb_dir, f"{vid}.jpg")
    if not os.path.exists(thumb):
        try:
            import cv2
            cap = cv2.VideoCapture(xlate_path(v["path"]))
            fps = cap.get(cv2.CAP_PROP_FPS) or 25
            cap.set(cv2.CAP_PROP_POS_FRAMES, fps)   # 取第 1 秒
            ok, frame = cap.read()
            cap.release()
            if not ok:
                return jsonify({"err": "无法生成缩略图"}), 404
            h, w = frame.shape[:2]
            if w > 480:
                frame = cv2.resize(frame, (480, int(h * 480 / w)))
            cv2.imwrite(thumb, frame, [cv2.IMWRITE_JPEG_QUALITY, 75])
        except Exception as e:
            return jsonify({"err": str(e)}), 500
    return send_file(thumb, mimetype="image/jpeg")


@bp.route("/api/videos/<int:vid>/file")
def api_video_file(vid):
    # <video> 标签无法携带 Authorization 头，支持 ?token= 查询参数认证
    token = request.args.get("token", "") or \
        request.headers.get("Authorization", "").removeprefix("Bearer ").strip()
    u = db.q1("SELECT u.* FROM tokens t JOIN users u ON u.id=t.user_id "
              "WHERE t.token=? AND u.is_active=1", (token,))
    if not u:
        return jsonify({"err": "unauthorized"}), 401
    v = db.q1("SELECT * FROM videos WHERE id=?", (vid,))
    if not v:
        return jsonify({"err": "not found"}), 404
    return send_file(xlate_path(v["path"]), conditional=True, download_name=v["orig_name"])
