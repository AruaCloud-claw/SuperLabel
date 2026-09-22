#!/usr/bin/env python3
"""认证与权限：登录、token、角色守卫。"""
import functools, secrets
from flask import request, jsonify
from werkzeug.security import generate_password_hash, check_password_hash
import db

def create_user(username, password, role, display_name=""):
    if role not in ("admin", "lead", "annotator"):
        raise ValueError("bad role")
    if not username or not password:
        raise ValueError("username/password required")
    db.ex("INSERT INTO users(username,password_hash,role,display_name) VALUES(?,?,?,?)",
          (username, generate_password_hash(password), role, display_name))
    return db.q1("SELECT id,username,role,display_name FROM users WHERE username=?", (username,))

def login(username, password):
    u = db.q1("SELECT * FROM users WHERE username=? AND is_active=1", (username,))
    if not u or not check_password_hash(u["password_hash"], password):
        return None
    token = secrets.token_hex(24)
    db.ex("INSERT INTO tokens(token,user_id) VALUES(?,?)", (token, u["id"]))
    return {"token": token, "user": {"id": u["id"], "username": u["username"],
                                     "role": u["role"], "display_name": u["display_name"]}}

def logout(token):
    db.ex("DELETE FROM tokens WHERE token=?", (token,))

def current_user():
    tk = request.headers.get("Authorization", "").removeprefix("Bearer ").strip()
    if not tk:
        return None
    return db.q1("""SELECT u.id,u.username,u.role,u.display_name,u.is_active
                    FROM tokens t JOIN users u ON u.id=t.user_id
                    WHERE t.token=?""", (tk,))

def require(*roles):
    """路由守卫：登录 + 可选角色限制。"""
    def deco(fn):
        @functools.wraps(fn)
        def wrapper(*a, **kw):
            u = current_user()
            if not u or not u["is_active"]:
                return jsonify({"err": "unauthorized"}), 401
            if roles and u["role"] not in roles:
                return jsonify({"err": "forbidden"}), 403
            request.user = u
            return fn(*a, **kw)
        return wrapper
    return deco
