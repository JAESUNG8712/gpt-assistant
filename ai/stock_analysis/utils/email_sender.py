"""
📧 보고서 이메일 자동 발송
Gmail SMTP 기반 — 오전 7시 / 저녁 10시 보고서 생성 후 자동 전송
"""

import os
import smtplib
import ssl
from datetime import datetime
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText


def _get_config() -> dict:
    return {
        "smtp_host": os.getenv("EMAIL_SMTP_HOST", "smtp.gmail.com"),
        "smtp_port": int(os.getenv("EMAIL_SMTP_PORT", "465")),
        "sender": os.getenv("EMAIL_SENDER", ""),
        "password": os.getenv("EMAIL_PASSWORD", ""),
        "recipients": [
            r.strip()
            for r in os.getenv("EMAIL_RECIPIENTS", "").split(",")
            if r.strip()
        ],
    }


def is_configured() -> bool:
    cfg = _get_config()
    return bool(cfg["sender"] and cfg["password"] and cfg["recipients"])


def send_report(report: str, label: str = "") -> bool:
    if not is_configured():
        print("⚠️  이메일 설정 없음 — EMAIL_SENDER / EMAIL_PASSWORD / EMAIL_RECIPIENTS 환경변수 확인")
        return False

    cfg = _get_config()
    now = datetime.now()
    date_str = now.strftime("%Y년 %m월 %d일")
    time_label = label or ("오전 7시" if now.hour < 12 else "저녁 10시")

    subject = f"📊 주식 분석 보고서 | {date_str} {time_label}"

    preview = ""
    for line in report.splitlines():
        if "KOSPI" in line or "종합 요약" in line:
            preview = line.strip()
            break

    html_body = _build_html(report, date_str, time_label, preview)
    text_body = report

    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = cfg["sender"]
    msg["To"] = ", ".join(cfg["recipients"])

    msg.attach(MIMEText(text_body, "plain", "utf-8"))
    msg.attach(MIMEText(html_body, "html", "utf-8"))

    try:
        context = ssl.create_default_context()
        with smtplib.SMTP_SSL(cfg["smtp_host"], cfg["smtp_port"], context=context, timeout=30) as server:
            server.login(cfg["sender"], cfg["password"])
            server.sendmail(cfg["sender"], cfg["recipients"], msg.as_string())

        print(f"📧 이메일 발송 완료 → {', '.join(cfg['recipients'])}")
        return True

    except smtplib.SMTPAuthenticationError:
        print("❌ 이메일 인증 실패 — Gmail 앱 비밀번호를 확인하세요")
        return False
    except Exception as e:
        print(f"❌ 이메일 발송 실패: {e}")
        return False


def _build_html(report: str, date_str: str, time_label: str, preview: str) -> str:
    lines = report.splitlines()
    html_lines = []

    for line in lines:
        line_stripped = line.strip()

        if line_stripped.startswith("=" * 10):
            html_lines.append('<hr style="border: 2px solid #2c3e50;">')
        elif line_stripped.startswith("─" * 5) or line_stripped.startswith("-" * 5):
            html_lines.append('<hr style="border: 1px solid #bdc3c7; margin: 4px 0;">')
        elif line_stripped.startswith("【") and line_stripped.endswith("】"):
            html_lines.append(
                f'<h2 style="color:#2c3e50;background:#ecf0f1;padding:8px 12px;'
                f'border-left:4px solid #3498db;margin:16px 0 8px 0;">{line_stripped}</h2>'
            )
        elif line_stripped.startswith("■"):
            html_lines.append(
                f'<h3 style="color:#34495e;margin:12px 0 4px 0;">{line_stripped}</h3>'
            )
        elif line_stripped.startswith("▶"):
            html_lines.append(
                f'<h3 style="color:#2980b9;border-bottom:1px solid #3498db;'
                f'padding-bottom:4px;margin:14px 0 6px 0;">{line_stripped}</h3>'
            )
        elif line_stripped.startswith("▸"):
            html_lines.append(
                f'<p style="margin:2px 0;color:#555;"><strong>{line_stripped}</strong></p>'
            )
        elif line_stripped.startswith("✅"):
            html_lines.append(
                f'<p style="margin:2px 0;color:#27ae60;">{line_stripped}</p>'
            )
        elif line_stripped.startswith("⚠️"):
            html_lines.append(
                f'<p style="margin:2px 0;color:#e67e22;">{line_stripped}</p>'
            )
        elif line_stripped.startswith("🤖"):
            html_lines.append(
                f'<p style="margin:4px 0;padding:8px;background:#eaf4fb;'
                f'border-left:3px solid #3498db;color:#2c3e50;">{line_stripped}</p>'
            )
        elif line_stripped.startswith("💡"):
            html_lines.append(
                f'<p style="margin:4px 0;padding:8px;background:#fef9e7;'
                f'border-left:3px solid #f1c40f;color:#7d6608;">{line_stripped}</p>'
            )
        elif line_stripped == "":
            html_lines.append('<br>')
        else:
            escaped = line_stripped.replace("<", "&lt;").replace(">", "&gt;")
            html_lines.append(f'<p style="margin:2px 0;color:#444;">{escaped}</p>')

    body_html = "\n".join(html_lines)

    return f"""<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family:'Apple SD Gothic Neo',Arial,sans-serif;max-width:800px;margin:0 auto;padding:16px;background:#f8f9fa;">

  <div style="background:#2c3e50;color:white;padding:20px 24px;border-radius:8px 8px 0 0;">
    <h1 style="margin:0;font-size:20px;">📊 주식 분석 보고서</h1>
    <p style="margin:6px 0 0 0;opacity:0.8;font-size:14px;">{date_str} {time_label} | AI 분석 시스템</p>
    {f'<p style="margin:8px 0 0 0;font-size:13px;background:rgba(255,255,255,0.1);padding:6px 10px;border-radius:4px;">{preview}</p>' if preview else ''}
  </div>

  <div style="background:white;padding:20px 24px;border-radius:0 0 8px 8px;box-shadow:0 2px 8px rgba(0,0,0,0.1);">
    {body_html}
  </div>

  <p style="text-align:center;color:#aaa;font-size:11px;margin-top:16px;">
    본 보고서는 AI 자동 분석 시스템이 생성한 투자 참고 자료입니다.<br>
    투자 손익의 최종 책임은 투자자 본인에게 있습니다.
  </p>

</body>
</html>"""
