#!/usr/bin/env bash
# اجرای رستگار نت روی لینوکس/مک
cd "$(dirname "$0")"
[ -d venv ] || python3 -m venv venv
./venv/bin/pip install -q -r requirements.txt
# برای دوربین/میکروفن روی شبکه‌ی محلی HTTPS لازم است:
export SSL_ADHOC=${SSL_ADHOC:-1}
./venv/bin/python app.py
