#!/usr/bin/env python3
"""认证 API：登录/登出/当前用户。"""
from flask import Blueprint, request, jsonify
import db
from auth import login, logout, require

bp = Blueprint("auth", __name__)


@bp.route("/api/login", methods=["POST"])
def api_login():
    d = request.get_json(force=True, silent=True)
    if not isinstance(d, dict):
        return jsonify({"err": "bad request"}), 400
    r = login(d.get("username", ""), d.get("password", ""))
    if not r:
        return jsonify({"err": "用户名或密码错误，或账号已停用"}), 401
    db.audit(r["user"]["id"], "login")
    return jsonify(r)


@bp.route("/api/logout", methods=["POST"])
@require()
def api_logout():
    tk = request.headers.get("Authorization", "").removeprefix("Bearer ").strip()
    logout(tk)
    return jsonify({"ok": True})


@bp.route("/api/me")
@require()
def api_me():
    return jsonify(dict(request.user))
