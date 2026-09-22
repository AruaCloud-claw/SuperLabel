#!/usr/bin/env python3
"""数据集广场 API：发布 / 列表 / 概览拼图 / 分页预览。"""
import os, json, random
from flask import Blueprint, request, jsonify, send_file
import db
from db import xlate_path
from auth import require

bp = Blueprint("gallery", __name__)
BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PUB_ROOT = os.environ.get("ANNOT_PUB_ROOT",
                          os.path.join(BASE, "data", "published"))


def _images_of(pub):
    img_dir = os.path.join(xlate_path(pub["path"]), "images")
    if not os.path.isdir(img_dir):
        return []
    return sorted(f for f in os.listdir(img_dir)
                  if f.lower().endswith((".jpg", ".jpeg", ".png")))


@bp.route("/api/published")
@require()
def api_list():
    rows = db.q("SELECT p.*, u.username publisher FROM published_datasets p "
                "LEFT JOIN users u ON u.id=p.created_by ORDER BY p.id DESC")
    return jsonify(rows)


@bp.route("/api/published/<int:pid>/thumb")
def api_thumb(pid):
    """概览拼图：随机 4 张 2x2（缓存）。"""
    p = db.q1("SELECT * FROM published_datasets WHERE id=?", (pid,))
    if not p:
        return jsonify({"err": "not found"}), 404
    thumb_dir = os.path.join(PUB_ROOT, "_thumbs")
    os.makedirs(thumb_dir, exist_ok=True)
    thumb = os.path.join(thumb_dir, f"{pid}.jpg")
    if not os.path.exists(thumb):
        imgs = _images_of(p)
        if not imgs:
            return jsonify({"err": "no images"}), 404
        picks = random.sample(imgs, min(4, len(imgs)))
        img_dir = os.path.join(xlate_path(p["path"]), "images")
        try:
            import cv2
            import numpy as np
            tiles = []
            for f in picks:
                im = cv2.imread(os.path.join(img_dir, f))
                if im is None:
                    continue
                im = cv2.resize(im, (320, 320))
                tiles.append(im)
            while len(tiles) < 4:
                tiles.append(np.zeros((320, 320, 3), np.uint8))
            top = np.hstack([tiles[0], tiles[1]])
            bot = np.hstack([tiles[2], tiles[3]])
            cv2.imwrite(thumb, np.vstack([top, bot]),
                        [cv2.IMWRITE_JPEG_QUALITY, 80])
        except Exception as e:
            return jsonify({"err": str(e)[:200]}), 500
    return send_file(thumb, mimetype="image/jpeg")


@bp.route("/api/published/<int:pid>/images")
@require()
def api_images(pid, ):
    p = db.q1("SELECT * FROM published_datasets WHERE id=?", (pid,))
    if not p:
        return jsonify({"err": "not found"}), 404
    imgs = _images_of(p)
    off = int(request.args.get("offset", 0))
    lim = min(int(request.args.get("limit", 60)), 200)
    return jsonify({"total": len(imgs), "files": imgs[off:off + lim]})


@bp.route("/api/published/<int:pid>/image/<path:fname>")
def api_image(pid, fname):
    token = request.args.get("token", "") or \
        request.headers.get("Authorization", "").removeprefix("Bearer ").strip()
    u = db.q1("SELECT u.* FROM tokens t JOIN users u ON u.id=t.user_id "
              "WHERE t.token=? AND u.is_active=1", (token,))
    if not u:
        return jsonify({"err": "unauthorized"}), 401
    p = db.q1("SELECT * FROM published_datasets WHERE id=?", (pid,))
    if not p:
        return jsonify({"err": "not found"}), 404
    img = os.path.join(xlate_path(p["path"]), "images", fname)
    if not os.path.isfile(img):
        return jsonify({"err": "not found"}), 404
    return send_file(img, mimetype="image/jpeg")
