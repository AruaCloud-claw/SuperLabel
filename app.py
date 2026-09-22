#!/usr/bin/env python3
"""标注平台后端入口。

启动: python app.py [--port 8880] [--init-admin USER PASS]
部署: Windows 任务计划程序 (AnnotPlatform, SYSTEM, 开机自启)
"""
import os, sys, argparse
from flask import Flask, send_from_directory

BASE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, BASE)
import db
from auth import create_user

STATIC = os.path.join(BASE, "ui")
app = Flask(__name__, static_folder=None)


# ---------- 页面路由（每页独立 html） ----------
PAGES = ("login", "overview", "videos", "video_detail", "annotate", "admin")


@app.route("/")
def index():
    """入口：前端根据 token 自行分发到登录页或对应功能页。"""
    resp = send_from_directory(STATIC, "login.html")
    resp.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    return resp


@app.route("/ui/<path:p>")
def ui(p):
    resp = send_from_directory(STATIC, p)
    resp.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    return resp


@app.route("/app")
def app_page():
    return send_from_directory(STATIC, "app.html")


# ---------- 注册 API 蓝图 ----------
from api.auth_api import bp as auth_bp
from api.users_api import bp as users_bp
from api.videos_api import bp as videos_bp
from api.datasets_api import bp as datasets_bp
from api.stats_api import bp as stats_bp
from api.anno_tasks_api import bp as anno_tasks_bp
from api.gallery_api import bp as gallery_bp

app.register_blueprint(auth_bp)
app.register_blueprint(users_bp)
app.register_blueprint(videos_bp)
app.register_blueprint(datasets_bp)
app.register_blueprint(stats_bp)
app.register_blueprint(anno_tasks_bp)
app.register_blueprint(gallery_bp)


def ensure_admin():
    db.init()
    if not db.q1("SELECT 1 FROM users WHERE role='admin'"):
        create_user("admin", "admin123", "admin", "系统管理员")
        print("[init] 已创建默认管理员 admin/admin123 （请尽快改密）")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8880)
    ap.add_argument("--init-admin", nargs=2, metavar=("USER", "PASS"), default=None)
    a = ap.parse_args()
    ensure_admin()
    if a.init_admin:
        create_user(a.init_admin[0], a.init_admin[1], "admin")
    print(f"标注平台 http://0.0.0.0:{a.port}")
    app.run(host="0.0.0.0", port=a.port, threaded=True)
