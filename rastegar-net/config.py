# -*- coding: utf-8 -*-
"""
تنظیمات «رستگار نت»
همهٔ مقادیر را می‌توان با متغیرهای محیطی (Environment Variables) تغییر داد.
"""
import os

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
INSTANCE_DIR = os.path.join(BASE_DIR, "instance")

APP_NAME = "رستگار نت"

# رمز عبور بخش مدیریت (مدیران و معلمان)
# پیشنهاد: پس از نصب نهایی، با متغیر محیطی ADMIN_PASSWORD آن را عوض کنید.
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "Rastegar12net21")

# اتاق‌های (کلاس‌های) سامانه
ROOMS = ["701", "702", "703", "801", "802", "803", "901", "902", "903"]

# مدت محرومیت دانش‌آموز اخراج‌شده (دقیقه)
KICK_MINUTES = int(os.environ.get("KICK_MINUTES", "30"))

# حداکثر تعداد کاربر ثبت‌شده در هر کلاس
MAX_USERS_PER_ROOM = int(os.environ.get("MAX_USERS_PER_ROOM", "200"))

# تنظیمات سرور
HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "5000"))

DB_PATH = os.environ.get("RASTEGAR_DB", os.path.join(INSTANCE_DIR, "rastegar.db"))

# HTTPS (برای دوربین/میکروفن روی شبکه‌ی محلی، مرورگرها HTTPS می‌خواهند)
#   SSL_ADHOC=1            -> گواهی خودامضا (نیاز به پکیج cryptography)
#   SSL_CERT / SSL_KEY     -> مسیر گواهی و کلید واقعی
SSL_ADHOC = os.environ.get("SSL_ADHOC", "") == "1"
SSL_CERT = os.environ.get("SSL_CERT", "")
SSL_KEY = os.environ.get("SSL_KEY", "")
COOKIE_SECURE = os.environ.get("COOKIE_SECURE", "") == "1" or SSL_ADHOC or bool(SSL_CERT)

# پشت پروکسی معکوس (nginx و ...) بودن
TRUST_PROXY = os.environ.get("TRUST_PROXY", "") == "1"

# فقط در صورت نیاز: دامنه‌های مجاز برای Socket.IO (با کاما جدا کنید). خالی = فقط همین سایت
CORS_ORIGINS = [o.strip() for o in os.environ.get("CORS_ORIGINS", "").split(",") if o.strip()]

# سرورهای ICE برای WebRTC
# STUN برای اغلب شبکه‌ها کافی است؛ اگر دانش‌آموزان پشت NAT سخت هستند، یک سرور TURN اضافه کنید.
STUN_URLS = [u.strip() for u in os.environ.get("STUN_URLS", "stun:stun.l.google.com:19302").split(",") if u.strip()]
TURN_URL = os.environ.get("TURN_URL", "")        # مثال: turn:turn.example.com:3478
TURN_USER = os.environ.get("TURN_USER", "")
TURN_PASS = os.environ.get("TURN_PASS", "")


def ice_servers():
    servers = []
    if STUN_URLS:
        servers.append({"urls": STUN_URLS})
    if TURN_URL:
        servers.append({
            "urls": [u.strip() for u in TURN_URL.split(",") if u.strip()],
            "username": TURN_USER,
            "credential": TURN_PASS,
        })
    return servers
