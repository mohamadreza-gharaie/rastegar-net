# -*- coding: utf-8 -*-
"""
رستگار نت — سامانهٔ آموزش آنلاین
Flask + Flask-SocketIO + WebRTC

اجرا:  python app.py
"""
import json
import math
import os
import re
import secrets
import sqlite3
import threading
import time
import unicodedata
import hmac
from collections import defaultdict, deque
from contextlib import closing
from datetime import datetime, timedelta, timezone
from functools import wraps

from flask import Flask, abort, jsonify, redirect, render_template, request, session
from flask_socketio import SocketIO, emit, join_room
from werkzeug.middleware.proxy_fix import ProxyFix
from werkzeug.security import check_password_hash, generate_password_hash

import config

ROOMS = config.ROOMS
PERM_KEYS = ("mic", "cam", "chat", "screen")
DEFAULT_SETTINGS = {"mic": True, "cam": True, "chat": True, "screen": False}
HASH_METHOD = "pbkdf2:sha256:100000"
_DUMMY_HASH = generate_password_hash("dummy-password", method=HASH_METHOD)


# ─────────────────────────────── برنامه ───────────────────────────────

def _load_secret_key():
    env = os.environ.get("SECRET_KEY")
    if env:
        return env
    os.makedirs(config.INSTANCE_DIR, exist_ok=True)
    path = os.path.join(config.INSTANCE_DIR, "secret.key")
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            key = f.read().strip()
        if key:
            return key
    key = secrets.token_hex(32)
    with open(path, "w", encoding="utf-8") as f:
        f.write(key)
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
    return key


app = Flask(__name__)
app.secret_key = _load_secret_key()
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=config.COOKIE_SECURE,
    PERMANENT_SESSION_LIFETIME=timedelta(hours=12),
    TEMPLATES_AUTO_RELOAD=False,
)
app.json.ensure_ascii = False
if config.TRUST_PROXY:
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)

socketio = SocketIO(
    app,
    async_mode="threading",
    cors_allowed_origins=(config.CORS_ORIGINS or None),
    max_http_buffer_size=200_000,
    ping_interval=10,
    ping_timeout=25,
)


# ─────────────────────────────── پایگاه داده ───────────────────────────────

SCHEMA = """
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    room       TEXT    NOT NULL,
    name       TEXT    NOT NULL,
    name_norm  TEXT    NOT NULL,
    pw_hash    TEXT    NOT NULL,
    created_at REAL    NOT NULL,
    UNIQUE(room, name_norm)
);
CREATE TABLE IF NOT EXISTS room_settings (
    room TEXT PRIMARY KEY,
    data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bans (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    room    TEXT NOT NULL,
    until   REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS attendance (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id   INTEGER,
    room      TEXT NOT NULL,
    name      TEXT NOT NULL,
    joined_at REAL NOT NULL,
    left_at   REAL
);
CREATE INDEX IF NOT EXISTS idx_att_room_time ON attendance(room, joined_at);
"""


def db():
    conn = sqlite3.connect(config.DB_PATH, timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def q(sql, args=(), one=False):
    with closing(db()) as c:
        rows = c.execute(sql, args).fetchall()
    if one:
        return rows[0] if rows else None
    return rows


def x(sql, args=()):
    with closing(db()) as c:
        with c:
            return c.execute(sql, args).lastrowid


def init_db():
    os.makedirs(os.path.dirname(config.DB_PATH), exist_ok=True)
    with closing(db()) as c:
        c.executescript(SCHEMA)
        # نشست‌های نیمه‌تمام از اجرای قبلی سرور را ببند
        with c:
            c.execute("UPDATE attendance SET left_at = joined_at WHERE left_at IS NULL")


SETTINGS = {}


def load_settings():
    for r in ROOMS:
        SETTINGS[r] = dict(DEFAULT_SETTINGS)
    for row in q("SELECT room, data FROM room_settings"):
        if row["room"] not in SETTINGS:
            continue
        try:
            data = json.loads(row["data"])
        except ValueError:
            continue
        for k in PERM_KEYS:
            if k in data:
                SETTINGS[row["room"]][k] = bool(data[k])


def save_settings(room):
    x(
        "INSERT INTO room_settings(room, data) VALUES(?, ?) "
        "ON CONFLICT(room) DO UPDATE SET data = excluded.data",
        (room, json.dumps(SETTINGS[room])),
    )


# ─────────────────────────────── ابزارها ───────────────────────────────

_CHAR_MAP = str.maketrans({"ي": "ی", "ك": "ک", "ى": "ی", "ۀ": "ه", "ة": "ه", "ؤ": "و"})
_DIGIT_MAP = str.maketrans("۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩", "01234567890123456789")
_CTRL_RE = re.compile(r"[\x00-\x1f\x7f\u200e\u200f\u202a-\u202e\u2066-\u2069]")


def clean_name(s, limit=40):
    s = unicodedata.normalize("NFKC", str(s or ""))
    s = _CTRL_RE.sub("", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s[:limit]


def norm_name(s):
    s = unicodedata.normalize("NFKC", str(s or ""))
    s = s.translate(_CHAR_MAP).translate(_DIGIT_MAP)
    s = s.replace("\u200c", " ")
    s = _CTRL_RE.sub("", s)
    return re.sub(r"\s+", " ", s).strip().casefold()


_PW_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"


def gen_password(n=6):
    return "".join(secrets.choice(_PW_ALPHABET) for _ in range(n))


def ban_until(uid):
    r = q("SELECT until FROM bans WHERE user_id = ?", (uid,), one=True)
    if not r:
        return 0
    if r["until"] > time.time():
        return r["until"]
    x("DELETE FROM bans WHERE user_id = ?", (uid,))
    return 0


def minutes_left(until):
    return max(1, int(math.ceil((until - time.time()) / 60)))


_fails = defaultdict(list)
_fails_lock = threading.Lock()


def login_blocked(ip):
    now = time.time()
    with _fails_lock:
        _fails[ip] = [t for t in _fails[ip] if now - t < 600]
        return len(_fails[ip]) >= 8


def login_failed(ip):
    with _fails_lock:
        _fails[ip].append(time.time())


def login_ok(ip):
    with _fails_lock:
        _fails.pop(ip, None)


# ─────────────────────────────── وضعیت زنده ───────────────────────────────

LOCK = threading.RLock()
ROOMSTATE = {
    r: {"peers": {}, "overrides": {}, "chat": deque(maxlen=200)} for r in ROOMS
}
SID = {}  # sid -> {"admin": bool, "student": {...}|None, "room": str|None, "chat_times": deque}


def effective_perms(room, peer):
    if peer["role"] == "teacher":
        return {k: True for k in PERM_KEYS}
    base = SETTINGS[room]
    ov = ROOMSTATE[room]["overrides"].get(peer["user_id"], {})
    return {k: bool(ov.get(k, base[k])) for k in PERM_KEYS}


def peer_public(p):
    return {
        "sid": p["sid"],
        "name": p["name"],
        "role": p["role"],
        "mic": p["mic"],
        "cam": p["cam"],
        "screen": p["screen"],
    }


def _sorted_peers(room):
    return sorted(
        ROOMSTATE[room]["peers"].values(),
        key=lambda p: (p["role"] != "teacher", p["joined_at"]),
    )


def teacher_state(room):
    now = time.time()
    users = q("SELECT id, name FROM users WHERE room = ? ORDER BY name_norm", (room,))
    bans = {
        r["user_id"]: r["until"]
        for r in q("SELECT user_id, until FROM bans WHERE room = ? AND until > ?", (room, now))
    }
    with LOCK:
        peers = _sorted_peers(room)
        present = []
        for p in peers:
            d = peer_public(p)
            d["user_id"] = p["user_id"]
            d["perms"] = effective_perms(room, p)
            d["joined_at"] = p["joined_at"]
            present.append(d)
        online_ids = {p["user_id"] for p in peers if p["role"] == "student"}
        settings = dict(SETTINGS[room])
    absent = [
        {"user_id": u["id"], "name": u["name"], "banned_until": bans.get(u["id"])}
        for u in users
        if u["id"] not in online_ids
    ]
    return {
        "room": room,
        "settings": settings,
        "present": present,
        "absent": absent,
        "registered": len(users),
        "kick_minutes": config.KICK_MINUTES,
    }


def admin_state():
    now = time.time()
    bans = {
        r["user_id"]: r["until"]
        for r in q("SELECT user_id, until FROM bans WHERE until > ?", (now,))
    }
    by_room = defaultdict(list)
    for u in q("SELECT id, room, name FROM users ORDER BY name_norm"):
        by_room[u["room"]].append(u)
    rooms = []
    with LOCK:
        for room in ROOMS:
            peers = _sorted_peers(room)
            online = {p["user_id"]: p for p in peers if p["role"] == "student"}
            teachers = [p["name"] for p in peers if p["role"] == "teacher"]
            users = []
            for u in by_room[room]:
                if u["id"] in online:
                    status, since = "present", online[u["id"]]["joined_at"]
                elif u["id"] in bans:
                    status, since = "banned", None
                else:
                    status, since = "absent", None
                users.append({
                    "id": u["id"],
                    "name": u["name"],
                    "status": status,
                    "since": since,
                    "until": bans.get(u["id"]),
                })
            rooms.append({
                "room": room,
                "settings": dict(SETTINGS[room]),
                "teachers": teachers,
                "present": len(online),
                "registered": len(users),
                "users": users,
            })
    return {"rooms": rooms, "now": now, "kick_minutes": config.KICK_MINUTES}


def push_admin():
    socketio.emit("admin_state", admin_state(), to="admins")


def push_room(room, admin=True):
    with LOCK:
        roster = [peer_public(p) for p in _sorted_peers(room)]
    socketio.emit("roster", {"peers": roster}, to="class:" + room)
    socketio.emit("room_state", teacher_state(room), to="t:" + room)
    if admin:
        push_admin()


def remove_peer(sid):
    with LOCK:
        info = SID.get(sid)
        if not info or not info.get("room"):
            return
        room = info["room"]
        info["room"] = None
        peer = ROOMSTATE[room]["peers"].pop(sid, None)
    if peer is None:
        return
    if peer.get("att_id"):
        x("UPDATE attendance SET left_at = ? WHERE id = ?", (time.time(), peer["att_id"]))
    push_room(room)


def drop_sid(sid, event=None, payload=None):
    """یک اتصال را (پس از ارسال پیام) قطع می‌کند."""
    if event:
        socketio.emit(event, payload or {}, to=sid)
        socketio.sleep(0.15)
    remove_peer(sid)
    try:
        socketio.server.disconnect(sid)
    except Exception:
        pass


def apply_perms(room):
    with LOCK:
        for sid, p in ROOMSTATE[room]["peers"].items():
            perms = effective_perms(room, p)
            if not perms["mic"]:
                p["mic"] = False
            if not perms["cam"]:
                p["cam"] = False
            if not perms["screen"]:
                p["screen"] = False
            socketio.emit("perms", perms, to=sid)
    push_room(room)


# ─────────────────────────────── صفحات ───────────────────────────────

@app.before_request
def csrf_guard():
    if request.method in ("POST", "PUT", "DELETE", "PATCH") and request.path.startswith("/api/"):
        if request.headers.get("X-RN") != "1":
            abort(403)


@app.after_request
def security_headers(resp):
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("X-Frame-Options", "DENY")
    resp.headers.setdefault("Referrer-Policy", "same-origin")
    resp.headers.setdefault("Permissions-Policy", "camera=(self), microphone=(self), display-capture=(self)")
    if request.path.startswith("/api/") or request.path in ("/admin", "/admin/login") or request.path.startswith("/class/"):
        resp.headers["Cache-Control"] = "no-store"
    return resp


def admin_required(f):
    @wraps(f)
    def wrapper(*a, **k):
        if not session.get("admin"):
            return jsonify(error="دسترسی مجاز نیست؛ دوباره وارد شوید."), 401
        return f(*a, **k)
    return wrapper


@app.get("/")
def index():
    floors = defaultdict(list)
    for r in ROOMS:
        floors[r[0]].append(r)
    msg = request.args.get("msg", "")
    return render_template(
        "index.html",
        floors=sorted(floors.items()),
        selected=request.args.get("room", ""),
        msg=msg if msg in ("banned", "login") else "",
        kick_minutes=config.KICK_MINUTES,
    )


@app.get("/admin/login")
def admin_login_page():
    if session.get("admin"):
        return redirect("/admin")
    return render_template("admin_login.html")


@app.get("/admin")
def admin_page():
    if not session.get("admin"):
        return redirect("/admin/login")
    return render_template("admin.html", rooms=ROOMS, kick_minutes=config.KICK_MINUTES)


@app.get("/class/<room>")
def class_page(room):
    if room not in ROOMS:
        abort(404)
    name = ""
    if session.get("admin"):
        role = "teacher"
    else:
        st = session.get("student")
        if not st or st.get("room") != room:
            return redirect("/?room=" + room + "&msg=login")
        user = q("SELECT id, name FROM users WHERE id = ? AND room = ?", (st.get("uid"), room), one=True)
        if not user:
            session.pop("student", None)
            return redirect("/?room=" + room + "&msg=login")
        if ban_until(user["id"]):
            return redirect("/?room=" + room + "&msg=banned")
        role, name = "student", user["name"]
    return render_template(
        "class.html",
        room=room,
        role=role,
        name=name,
        ice=config.ice_servers(),
        kick_minutes=config.KICK_MINUTES,
    )


@app.get("/healthz")
def healthz():
    return jsonify(ok=True)


# ─────────────────────────────── API: ورود ───────────────────────────────

@app.post("/api/student/login")
def api_student_login():
    ip = request.remote_addr or "?"
    if login_blocked(ip):
        return jsonify(error="تلاش‌های ناموفق زیاد بود. چند دقیقه بعد دوباره امتحان کنید."), 429
    d = request.get_json(silent=True) or {}
    room = str(d.get("room", "")).strip()
    name = norm_name(d.get("name", ""))
    password = str(d.get("password", ""))
    if room not in ROOMS:
        return jsonify(error="یک کلاس را انتخاب کنید."), 400
    if not name or not password:
        return jsonify(error="نام و رمز عبور را وارد کنید."), 400
    user = q("SELECT * FROM users WHERE room = ? AND name_norm = ?", (room, name), one=True)
    good = check_password_hash(user["pw_hash"] if user else _DUMMY_HASH, password)
    if not user or not good:
        login_failed(ip)
        return jsonify(error="نام یا رمز عبور این کلاس درست نیست."), 401
    until = ban_until(user["id"])
    if until:
        return jsonify(error="شما از این کلاس اخراج شده‌اید. تا %d دقیقهٔ دیگر نمی‌توانید وارد شوید." % minutes_left(until)), 403
    login_ok(ip)
    session["student"] = {"uid": user["id"], "room": room}
    session.permanent = True
    return jsonify(ok=True, redirect="/class/" + room)


@app.post("/api/student/logout")
def api_student_logout():
    session.pop("student", None)
    return jsonify(ok=True)


@app.post("/api/admin/login")
def api_admin_login():
    ip = request.remote_addr or "?"
    if login_blocked(ip):
        return jsonify(error="تلاش‌های ناموفق زیاد بود. چند دقیقه بعد دوباره امتحان کنید."), 429
    d = request.get_json(silent=True) or {}
    pw = str(d.get("password", "")).encode("utf-8")
    if not hmac.compare_digest(pw, config.ADMIN_PASSWORD.encode("utf-8")):
        login_failed(ip)
        return jsonify(error="رمز عبور درست نیست."), 401
    login_ok(ip)
    session["admin"] = True
    session.permanent = True
    return jsonify(ok=True, redirect="/admin")


@app.post("/api/admin/logout")
def api_admin_logout():
    session.pop("admin", None)
    return jsonify(ok=True)


# ─────────────────────────────── API: مدیریت ───────────────────────────────

@app.get("/api/admin/state")
@admin_required
def api_admin_state():
    return jsonify(admin_state())


@app.post("/api/admin/users")
@admin_required
def api_users_create():
    d = request.get_json(silent=True) or {}
    room = str(d.get("room", ""))
    entries = d.get("entries")
    if room not in ROOMS:
        return jsonify(error="کلاس نامعتبر است."), 400
    if not isinstance(entries, list) or not entries or len(entries) > 100:
        return jsonify(error="فهرست کاربران خالی است یا بیش از ۱۰۰ نفر است."), 400
    count = q("SELECT COUNT(*) AS c FROM users WHERE room = ?", (room,), one=True)["c"]
    created, errors = [], []
    for e in entries:
        e = e if isinstance(e, dict) else {}
        name = clean_name(e.get("name"))
        pw = str(e.get("password") or "").strip() or gen_password()
        if len(name) < 2:
            errors.append({"name": name, "error": "نام باید حداقل ۲ نویسه باشد."})
            continue
        if not (4 <= len(pw) <= 64):
            errors.append({"name": name, "error": "رمز عبور باید بین ۴ تا ۶۴ نویسه باشد."})
            continue
        if count >= config.MAX_USERS_PER_ROOM:
            errors.append({"name": name, "error": "ظرفیت ثبت کاربر در این کلاس پر است."})
            continue
        try:
            uid = x(
                "INSERT INTO users(room, name, name_norm, pw_hash, created_at) VALUES(?,?,?,?,?)",
                (room, name, norm_name(name), generate_password_hash(pw, method=HASH_METHOD), time.time()),
            )
        except sqlite3.IntegrityError:
            errors.append({"name": name, "error": "این نام قبلاً در این کلاس ثبت شده است."})
            continue
        count += 1
        created.append({"id": uid, "name": name, "password": pw})
    if created:
        push_room(room)
    return jsonify(created=created, errors=errors)


@app.put("/api/admin/users/<int:uid>")
@admin_required
def api_users_update(uid):
    user = q("SELECT * FROM users WHERE id = ?", (uid,), one=True)
    if not user:
        return jsonify(error="کاربر پیدا نشد."), 404
    d = request.get_json(silent=True) or {}
    changed = False
    if d.get("password"):
        pw = str(d["password"]).strip()
        if not (4 <= len(pw) <= 64):
            return jsonify(error="رمز عبور باید بین ۴ تا ۶۴ نویسه باشد."), 400
        x("UPDATE users SET pw_hash = ? WHERE id = ?", (generate_password_hash(pw, method=HASH_METHOD), uid))
        changed = True
    if d.get("name"):
        name = clean_name(d["name"])
        if len(name) < 2:
            return jsonify(error="نام باید حداقل ۲ نویسه باشد."), 400
        try:
            x("UPDATE users SET name = ?, name_norm = ? WHERE id = ?", (name, norm_name(name), uid))
        except sqlite3.IntegrityError:
            return jsonify(error="این نام قبلاً در این کلاس ثبت شده است."), 400
        with LOCK:
            for p in ROOMSTATE[user["room"]]["peers"].values():
                if p["user_id"] == uid:
                    p["name"] = name
        changed = True
    if changed:
        push_room(user["room"])
    return jsonify(ok=True)


@app.delete("/api/admin/users/<int:uid>")
@admin_required
def api_users_delete(uid):
    user = q("SELECT * FROM users WHERE id = ?", (uid,), one=True)
    if not user:
        return jsonify(error="کاربر پیدا نشد."), 404
    room = user["room"]
    with LOCK:
        sids = [s for s, p in ROOMSTATE[room]["peers"].items() if p["user_id"] == uid]
        ROOMSTATE[room]["overrides"].pop(uid, None)
    for s in sids:
        drop_sid(s, "kicked", {"removed": True})
    x("DELETE FROM bans WHERE user_id = ?", (uid,))
    x("DELETE FROM users WHERE id = ?", (uid,))
    push_room(room)
    return jsonify(ok=True)


def kick_user(room, uid):
    until = time.time() + config.KICK_MINUTES * 60
    x(
        "INSERT INTO bans(user_id, room, until) VALUES(?,?,?) "
        "ON CONFLICT(user_id) DO UPDATE SET until = excluded.until, room = excluded.room",
        (uid, room, until),
    )
    with LOCK:
        sids = [s for s, p in ROOMSTATE[room]["peers"].items() if p["user_id"] == uid]
    for s in sids:
        drop_sid(s, "kicked", {"minutes": config.KICK_MINUTES})
    push_room(room)


def unban_user(room, uid):
    x("DELETE FROM bans WHERE user_id = ?", (uid,))
    push_room(room)


@app.post("/api/admin/users/<int:uid>/kick")
@admin_required
def api_users_kick(uid):
    user = q("SELECT room FROM users WHERE id = ?", (uid,), one=True)
    if not user:
        return jsonify(error="کاربر پیدا نشد."), 404
    kick_user(user["room"], uid)
    return jsonify(ok=True)


@app.post("/api/admin/users/<int:uid>/unban")
@admin_required
def api_users_unban(uid):
    user = q("SELECT room FROM users WHERE id = ?", (uid,), one=True)
    if not user:
        return jsonify(error="کاربر پیدا نشد."), 404
    unban_user(user["room"], uid)
    return jsonify(ok=True)


@app.get("/api/admin/attendance")
@admin_required
def api_attendance():
    room = request.args.get("room", "")
    date = request.args.get("date", "")
    try:
        tz = int(request.args.get("tz", "0"))
        day = datetime.strptime(date, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp()
    except ValueError:
        return jsonify(error="تاریخ نامعتبر است."), 400
    if room not in ROOMS:
        return jsonify(error="کلاس نامعتبر است."), 400
    start = day + tz * 60  # tz = دقیقه‌های اختلاف UTC با ساعت محلی (مثل JS getTimezoneOffset)
    end = start + 86400
    now = time.time()
    rows = q(
        "SELECT user_id, name, joined_at, left_at FROM attendance "
        "WHERE room = ? AND joined_at < ? AND COALESCE(left_at, ?) >= ? ORDER BY joined_at",
        (room, end, now, start),
    )
    agg = {}
    for r in rows:
        key = r["user_id"] if r["user_id"] is not None else r["name"]
        a = max(r["joined_at"], start)
        b = min(r["left_at"] if r["left_at"] is not None else now, end, now)
        e = agg.setdefault(key, {"user_id": r["user_id"], "name": r["name"], "first": a, "seconds": 0, "sessions": 0})
        e["name"] = r["name"]
        e["first"] = min(e["first"], a)
        e["seconds"] += max(0, int(b - a))
        e["sessions"] += 1
    present = sorted(agg.values(), key=lambda e: e["first"])
    present_ids = {e["user_id"] for e in present if e["user_id"] is not None}
    absent = [
        {"user_id": u["id"], "name": u["name"]}
        for u in q("SELECT id, name FROM users WHERE room = ? ORDER BY name_norm", (room,))
        if u["id"] not in present_ids
    ]
    return jsonify(room=room, date=date, present=present, absent=absent)


# ─────────────────────────────── Socket.IO ───────────────────────────────

def _is_admin():
    info = SID.get(request.sid)
    return bool(info and info["admin"])


@socketio.on("connect")
def on_connect(auth=None):
    st = session.get("student")
    SID[request.sid] = {
        "admin": bool(session.get("admin")),
        "student": dict(st) if st else None,
        "room": None,
        "chat_times": deque(maxlen=6),
    }


@socketio.on("disconnect")
def on_disconnect(*args):
    sid = request.sid
    remove_peer(sid)
    SID.pop(sid, None)


@socketio.on("admin_watch")
def on_admin_watch(*args):
    if not _is_admin():
        return
    join_room("admins")
    emit("admin_state", admin_state())


@socketio.on("join")
def on_join(data):
    sid = request.sid
    info = SID.get(sid)
    data = data if isinstance(data, dict) else {}
    room = str(data.get("room", ""))
    if info is None or room not in ROOMS or info.get("room"):
        return

    if info["admin"]:
        role, uid = "teacher", None
        name = clean_name(data.get("name")) or "معلم"
    else:
        st = info.get("student")
        if not st or st.get("room") != room:
            emit("fatal", {"msg": "ابتدا وارد کلاس شوید.", "redirect": "/?room=" + room + "&msg=login"})
            return
        user = q("SELECT id, name FROM users WHERE id = ? AND room = ?", (st.get("uid"), room), one=True)
        if not user:
            emit("fatal", {"msg": "حساب شما در این کلاس وجود ندارد.", "redirect": "/"})
            return
        until = ban_until(user["id"])
        if until:
            emit("kicked", {"minutes": minutes_left(until)})
            return
        role, uid, name = "student", user["id"], user["name"]

    # یک دانش‌آموز فقط یک اتصال فعال دارد؛ اتصال قبلی بسته می‌شود
    if role == "student":
        with LOCK:
            dup = [s for s, p in ROOMSTATE[room]["peers"].items() if p["user_id"] == uid]
        for s in dup:
            drop_sid(s, "replaced", {})

    now = time.time()
    peer = {
        "sid": sid, "room": room, "role": role, "user_id": uid, "name": name,
        "mic": False, "cam": False, "screen": False, "joined_at": now, "att_id": None,
    }
    if role == "student":
        peer["att_id"] = x(
            "INSERT INTO attendance(user_id, room, name, joined_at) VALUES(?,?,?,?)",
            (uid, room, name, now),
        )
    join_room("class:" + room)
    if role == "teacher":
        join_room("t:" + room)
    with LOCK:
        rs = ROOMSTATE[room]
        others = [peer_public(p) for s, p in rs["peers"].items() if s != sid]
        rs["peers"][sid] = peer
        info["room"] = room
        perms = effective_perms(room, peer)
        chat = list(rs["chat"])
    emit("joined", {"sid": sid, "role": role, "name": name, "peers": others, "perms": perms, "chat": chat})
    push_room(room)


@socketio.on("signal")
def on_signal(data):
    sid = request.sid
    info = SID.get(sid)
    if not info or not info.get("room") or not isinstance(data, dict):
        return
    to, payload = data.get("to"), data.get("data")
    if not isinstance(to, str) or not isinstance(payload, dict) or len(json.dumps(payload)) > 40_000:
        return
    with LOCK:
        peers = ROOMSTATE[info["room"]]["peers"]
        ok = sid in peers and to in peers
    if ok:
        socketio.emit("signal", {"from": sid, "data": payload}, to=to)


def _my_peer():
    info = SID.get(request.sid)
    if not info or not info.get("room"):
        return None, None
    room = info["room"]
    return room, ROOMSTATE[room]["peers"].get(request.sid)


@socketio.on("media_state")
def on_media_state(data):
    room, peer = _my_peer()
    if not peer or not isinstance(data, dict):
        return
    with LOCK:
        perms = effective_perms(room, peer)
        mic = bool(data.get("mic")) and perms["mic"]
        cam = bool(data.get("cam")) and perms["cam"]
        denied = (bool(data.get("mic")) and not mic) or (bool(data.get("cam")) and not cam)
        peer["mic"], peer["cam"] = mic, cam
    if denied:
        emit("perms", perms)
    push_room(room, admin=False)


@socketio.on("screen_state")
def on_screen_state(data):
    room, peer = _my_peer()
    if not peer or not isinstance(data, dict):
        return
    with LOCK:
        perms = effective_perms(room, peer)
        on = bool(data.get("on")) and perms["screen"]
        peer["screen"] = on
    if data.get("on") and not on:
        emit("perms", perms)
    push_room(room, admin=False)


@socketio.on("chat")
def on_chat(data):
    room, peer = _my_peer()
    if not peer or not isinstance(data, dict):
        return
    text = str(data.get("text", "")).replace("\r", "").strip()[:1000]
    if not text:
        return
    with LOCK:
        perms = effective_perms(room, peer)
    if not perms["chat"]:
        emit("perms", perms)
        return
    times = SID[request.sid]["chat_times"]
    now = time.time()
    if len(times) == times.maxlen and now - times[0] < 5:
        emit("toast", {"msg": "پیام‌ها را کمی آهسته‌تر بفرستید."})
        return
    times.append(now)
    msg = {
        "id": secrets.token_hex(4),
        "sid": request.sid,
        "name": peer["name"],
        "role": peer["role"],
        "text": text,
        "ts": now,
    }
    with LOCK:
        ROOMSTATE[room]["chat"].append(msg)
    socketio.emit("chat", msg, to="class:" + room)


def _ctl_room(data):
    if not _is_admin() or not isinstance(data, dict):
        return None
    room = str(data.get("room", ""))
    return room if room in ROOMS else None


@socketio.on("ctl_setting")
def ctl_setting(data):
    room = _ctl_room(data)
    key = data.get("key") if room else None
    if key not in PERM_KEYS:
        return
    value = bool(data.get("value"))
    with LOCK:
        SETTINGS[room][key] = value
        for ov in ROOMSTATE[room]["overrides"].values():
            ov.pop(key, None)  # تنظیم کل کلاس بر استثناهای فردی غلبه می‌کند
    save_settings(room)
    apply_perms(room)


@socketio.on("ctl_user")
def ctl_user(data):
    room = _ctl_room(data)
    key = data.get("key") if room else None
    uid = data.get("user_id") if room else None
    if key not in PERM_KEYS or not isinstance(uid, int):
        return
    value = data.get("value")
    with LOCK:
        ov = ROOMSTATE[room]["overrides"].setdefault(uid, {})
        if value is None:
            ov.pop(key, None)
        else:
            ov[key] = bool(value)
    apply_perms(room)


@socketio.on("ctl_kick")
def ctl_kick(data):
    room = _ctl_room(data)
    uid = data.get("user_id") if room else None
    if not isinstance(uid, int):
        return
    if q("SELECT 1 FROM users WHERE id = ? AND room = ?", (uid, room), one=True):
        kick_user(room, uid)


@socketio.on("ctl_unban")
def ctl_unban(data):
    room = _ctl_room(data)
    uid = data.get("user_id") if room else None
    if isinstance(uid, int):
        unban_user(room, uid)


@socketio.on("ctl_clear_chat")
def ctl_clear_chat(data):
    room = _ctl_room(data)
    if not room:
        return
    with LOCK:
        ROOMSTATE[room]["chat"].clear()
    socketio.emit("chat_cleared", {}, to="class:" + room)


# ─────────────────────────────── راه‌اندازی ───────────────────────────────

init_db()
load_settings()


def main():
    kwargs = {}
    scheme = "http"
    if config.SSL_CERT and config.SSL_KEY:
        kwargs["ssl_context"] = (config.SSL_CERT, config.SSL_KEY)
        scheme = "https"
    elif config.SSL_ADHOC:
        kwargs["ssl_context"] = "adhoc"
        scheme = "https"
    print("\n  رستگار نت در حال اجراست:  %s://localhost:%d\n  پنل مدیریت:               %s://localhost:%d/admin\n"
          % (scheme, config.PORT, scheme, config.PORT))
    socketio.run(app, host=config.HOST, port=config.PORT, allow_unsafe_werkzeug=True, **kwargs)


if __name__ == "__main__":
    main()
