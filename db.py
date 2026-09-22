#!/usr/bin/env python3
"""SQLite 初始化与访问助手。"""
import sqlite3, os, json, time, threading

DB_PATH = os.environ.get("ANNOT_DB", os.path.join(os.path.dirname(
    os.path.abspath(__file__)), "data", "annot.db"))
_local = threading.local()

SCHEMA = """
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','lead','annotator')),
  display_name TEXT DEFAULT '',
  is_active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS tokens(
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS datasets(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  frame_dir TEXT NOT NULL,
  label_dir TEXT NOT NULL,
  classes_json TEXT DEFAULT '["excavator"]',
  status TEXT DEFAULT 'pending',
  created_by INTEGER, created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS assignments(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dataset_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS label_versions(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dataset_id INTEGER NOT NULL,
  frame_file TEXT NOT NULL,
  user_id INTEGER,
  content_json TEXT NOT NULL,
  saved_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS edit_locks(
  dataset_id INTEGER NOT NULL,
  frame_file TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  locked_at REAL NOT NULL,
  PRIMARY KEY(dataset_id, frame_file)
);
CREATE TABLE IF NOT EXISTS audit_log(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER, action TEXT, target TEXT, detail TEXT,
  at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS tasks(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dataset_id INTEGER NOT NULL,
  kind TEXT DEFAULT 'prelabel',
  status TEXT DEFAULT 'queued',
  progress REAL DEFAULT 0, message TEXT DEFAULT '',
  created_by INTEGER, created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS videos(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  orig_name TEXT NOT NULL,
  path TEXT NOT NULL,
  size INTEGER DEFAULT 0,
  duration REAL DEFAULT 0,
  width INTEGER DEFAULT 0,
  height INTEGER DEFAULT 0,
  fps REAL DEFAULT 0,
  uploaded_by INTEGER,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS anno_tasks(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  note TEXT DEFAULT '',
  status TEXT DEFAULT '进行中',
  classes_json TEXT DEFAULT '["excavator"]',
  conf REAL DEFAULT 0.05,
  created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS reviewed_frames(
  dataset_id INTEGER NOT NULL,
  frame_file TEXT NOT NULL,
  user_id INTEGER,
  at TEXT DEFAULT (datetime('now','localtime')),
  PRIMARY KEY(dataset_id, frame_file)
);
CREATE TABLE IF NOT EXISTS published_datasets(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  image_count INTEGER DEFAULT 0,
  size_bytes INTEGER DEFAULT 0,
  classes_json TEXT DEFAULT '[]',
  created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS task_logs(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  message TEXT NOT NULL,
  at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS anno_task_videos(
  task_id INTEGER NOT NULL,
  video_id INTEGER NOT NULL,
  frame_start INTEGER,
  frame_end INTEGER,
  PRIMARY KEY(task_id, video_id)
);
CREATE TABLE IF NOT EXISTS video_frames(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  video_id INTEGER NOT NULL,
  frame_file TEXT NOT NULL,
  UNIQUE(task_id, frame_file)
);
"""

def conn():
    c = getattr(_local, "c", None)
    if c is None:
        c = sqlite3.connect(DB_PATH, timeout=10)
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA foreign_keys=ON")
        _local.c = c
    return c

def init():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn().executescript(SCHEMA)
    for alter in ("ALTER TABLE anno_task_videos ADD COLUMN frame_start INTEGER",
                  "ALTER TABLE anno_task_videos ADD COLUMN frame_end INTEGER",
                  "ALTER TABLE anno_tasks ADD COLUMN classes_json TEXT DEFAULT '[\"excavator\"]'",
                  "ALTER TABLE anno_tasks ADD COLUMN conf REAL DEFAULT 0.05",
                  "ALTER TABLE tasks ADD COLUMN video_id INTEGER",
                  "ALTER TABLE tasks ADD COLUMN cur_index INTEGER"):
        try:
            conn().execute(alter)
        except sqlite3.OperationalError:
            pass   # 列已存在
    conn().commit()

def q(sql, args=()):
    cur = conn().execute(sql, args)
    rows = [dict(r) for r in cur.fetchall()]
    conn().commit()
    return rows

def q1(sql, args=()):
    rows = q(sql, args)
    return rows[0] if rows else None

def ex(sql, args=()):
    cur = conn().execute(sql, args)
    conn().commit()
    return cur.lastrowid

def audit(user_id, action, target="", detail=""):
    ex("INSERT INTO audit_log(user_id,action,target,detail) VALUES(?,?,?,?)",
       (user_id, action, target, json.dumps(detail, ensure_ascii=False) if isinstance(detail,(dict,list)) else detail))


import platform as _platform
_IS_WIN = _platform.system() == "Windows"

def xlate_path(p):
    """跨机路径翻译：按当前运行主机转换为本机可访问路径。"""
    if p is None:
        return p
    if _IS_WIN:
        if p.startswith("/mnt/hgfs/VMShare"):
            return "D:\\VMShare" + p[len("/mnt/hgfs/VMShare"):].replace("/", "\\")
    else:
        if p.startswith("D:\\VMShare"):
            return "/mnt/hgfs/VMShare" + p[len("D:\\VMShare"):].replace("\\", "/")
    return p
