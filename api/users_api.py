#!/usr/bin/env python3
"""用户管理 API（仅 admin）。"""
from flask import Blueprint, request, jsonify
from werkzeug.security import generate_password_hash
import db
from auth import require

bp = Blueprint("users", __name__)


@bp.route("/api/users")
@require("admin")
def api_users():
    return jsonify(db.q("SELECT id,username,role,display_name,is_active,created_at "
                        "FROM users ORDER BY id"))


@bp.route("/api/users", methods=["POST"])
@require("admin")
def api_create_user():
    from auth import create_user
    d = request.get_json(force=True, silent=True) or {}
    try:
        u = create_user(d.get("username", "").strip(), d.get("password", ""),
                        d.get("role", "annotator"), d.get("display_name", ""))
    except Exception as e:
        return jsonify({"err": str(e)}), 400
    db.audit(request.user["id"], "create_user", u["username"])
    return jsonify(u)


@bp.route("/api/users/<int:uid>", methods=["PATCH"])
@require("admin")
def api_patch_user(uid):
    d = request.get_json(force=True, silent=True) or {}
    u = db.q1("SELECT * FROM users WHERE id=?", (uid,))
    if not u:
        return jsonify({"err": "not found"}), 404
    if uid == request.user["id"] and d.get("is_active") == 0:
        return jsonify({"err": "不能停用自己"}), 400
    if "role" in d:
        db.ex("UPDATE users SET role=? WHERE id=?", (d["role"], uid))
    if "is_active" in d:
        db.ex("UPDATE users SET is_active=? WHERE id=?", (int(bool(d["is_active"])), uid))
        if not d["is_active"]:
            db.ex("DELETE FROM tokens WHERE user_id=?", (uid,))
    if d.get("password"):
        db.ex("UPDATE users SET password_hash=? WHERE id=?",
              (generate_password_hash(d["password"]), uid))
    if "display_name" in d:
        db.ex("UPDATE users SET display_name=? WHERE id=?", (d["display_name"], uid))
    db.audit(request.user["id"], "patch_user", uid, d)
    return jsonify(db.q1("SELECT id,username,role,display_name,is_active FROM users WHERE id=?",
                         (uid,)))
