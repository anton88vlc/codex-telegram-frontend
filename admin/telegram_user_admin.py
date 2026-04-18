#!/usr/bin/env python3

import argparse
import asyncio
import inspect
import json
import os
import getpass
import sqlite3
import subprocess
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from urllib import error as urllib_error
from urllib import request as urllib_request

import qrcode
from dotenv import load_dotenv
from telethon import TelegramClient, errors, functions, types


ROOT = Path(__file__).resolve().parent
PROJECT_ROOT = ROOT.parent
DEFAULT_ENV_PATH = ROOT / ".env"
DEFAULT_SESSION_PATH = PROJECT_ROOT / "state" / "anton_user"
DEFAULT_QR_PATH = PROJECT_ROOT / "state" / "login-qr.png"
DEFAULT_PLAN_PATH = ROOT / "bootstrap-plan.json"
DEFAULT_RESULT_PATH = PROJECT_ROOT / "state" / "bootstrap-result.json"
DEFAULT_BRIDGE_STATE_PATH = PROJECT_ROOT / "state" / "state.json"
DEFAULT_THREADS_DB_PATH = Path(os.environ.get("HOME", "/Users/antonnaumov")) / ".codex" / "state_5.sqlite"
DEFAULT_BOT_TOKEN_KEYCHAIN_SERVICE = "codex-telegram-bridge-bot-token"
DEFAULT_MESSAGE_DELAY_MS = 1100
TELEGRAM_TEXT_LIMIT = 3500


@dataclass
class EnvConfig:
    api_id: int
    api_hash: str


class TelegramRetryAfterError(RuntimeError):
    def __init__(self, retry_after: int, message: str):
        super().__init__(message)
        self.retry_after = retry_after


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def load_env(env_path: Path) -> EnvConfig:
    if not env_path.exists():
      raise SystemExit(f"env file not found: {env_path}")
    load_dotenv(env_path, override=False)
    api_id = os.getenv("API_ID")
    api_hash = os.getenv("API_HASH")
    if not api_id or not api_hash:
        raise SystemExit(f"API_ID/API_HASH missing in {env_path}")
    return EnvConfig(api_id=int(api_id), api_hash=api_hash)


def ensure_parent(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)


def save_json(path: Path, payload: dict) -> None:
    ensure_parent(path)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def load_json(path: Path, fallback):
    if not path.exists():
        return fallback
    return json.loads(path.read_text(encoding="utf-8"))


def split_long_paragraph(paragraph: str, limit: int):
    chunks = []
    remaining = paragraph
    while len(remaining) > limit:
        slice_at = remaining.rfind("\n", 0, limit)
        if slice_at < int(limit * 0.5):
            slice_at = remaining.rfind(" ", 0, limit)
        if slice_at < int(limit * 0.5):
            slice_at = limit
        chunks.append(remaining[:slice_at].strip())
        remaining = remaining[slice_at:].strip()
    if remaining:
        chunks.append(remaining)
    return chunks


def split_telegram_text(text: str, limit: int = TELEGRAM_TEXT_LIMIT):
    normalized = str(text or "").replace("\r\n", "\n").strip()
    if not normalized:
        return [""]

    paragraphs = [part.strip() for part in normalized.split("\n\n") if part.strip()]
    if not paragraphs:
        return [""]

    chunks = []
    current = ""
    for paragraph in paragraphs:
        parts = split_long_paragraph(paragraph, limit) if len(paragraph) > limit else [paragraph]
        for part in parts:
            candidate = f"{current}\n\n{part}" if current else part
            if len(candidate) <= limit:
                current = candidate
            else:
                if current:
                    chunks.append(current)
                current = part
    if current:
        chunks.append(current)
    return chunks


def read_keychain_secret(service_name: str):
    try:
        result = subprocess.run(
            ["/usr/bin/security", "find-generic-password", "-s", service_name, "-w"],
            check=True,
            capture_output=True,
            text=True,
        )
        secret = result.stdout.strip()
        return secret or None
    except Exception:
        return None


def load_bot_token(bot_token_env: str, bot_token_keychain_service: str):
    token = os.getenv(bot_token_env) or read_keychain_secret(bot_token_keychain_service)
    if not token:
        raise SystemExit(
            f"missing Telegram bot token; set {bot_token_env} or Keychain item {bot_token_keychain_service}"
        )
    return token


def call_bot_api(token: str, method: str, payload: dict):
    body = json.dumps(payload).encode("utf-8")
    req = urllib_request.Request(
        f"https://api.telegram.org/bot{token}/{method}",
        data=body,
        headers={"content-type": "application/json"},
        method="POST",
    )
    try:
        with urllib_request.urlopen(req) as response:
            result = json.loads(response.read().decode("utf-8"))
    except urllib_error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")
        try:
            parsed = json.loads(body) if body else {}
        except Exception:
            parsed = {}
        retry_after = parsed.get("parameters", {}).get("retry_after")
        if exc.code == 429 and retry_after:
            raise TelegramRetryAfterError(int(retry_after), parsed.get("description") or body or str(exc)) from exc
        raise RuntimeError(f"telegram {method} failed: {body or exc}") from exc
    if not result.get("ok"):
        raise RuntimeError(f"telegram {method} failed: {result.get('description') or result}")
    return result.get("result")


def make_client(session_path: Path, env: EnvConfig) -> TelegramClient:
    ensure_parent(session_path)
    return TelegramClient(str(session_path), env.api_id, env.api_hash)


def render_qr(url: str, qr_path: Path) -> None:
    ensure_parent(qr_path)
    image = qrcode.make(url)
    image.save(qr_path)


def me_payload(me):
    return {
        "id": me.id,
        "username": me.username,
        "first_name": me.first_name,
        "last_name": me.last_name,
        "phone": getattr(me, "phone", None),
    }


def bot_api_chat_id(channel_id: int) -> str:
    return f"-100{channel_id}"


def admin_rights() -> types.ChatAdminRights:
    wanted = {
        "change_info": True,
        "delete_messages": True,
        "invite_users": True,
        "pin_messages": True,
        "manage_topics": True,
        "other": True,
        "post_messages": False,
        "edit_messages": False,
        "ban_users": False,
        "add_admins": False,
        "anonymous": False,
        "manage_call": False,
        "post_stories": False,
        "edit_stories": False,
        "delete_stories": False,
    }
    sig = inspect.signature(types.ChatAdminRights.__init__)
    kwargs = {key: value for key, value in wanted.items() if key in sig.parameters}
    return types.ChatAdminRights(**kwargs)


async def command_whoami(args):
    env = load_env(args.env_file)
    client = make_client(args.session, env)
    await client.connect()
    try:
        authorized = await client.is_user_authorized()
        payload = {"authorized": authorized, "me": None}
        if authorized:
            payload["me"] = me_payload(await client.get_me())
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    finally:
        await client.disconnect()


async def command_login_qr(args):
    env = load_env(args.env_file)
    client = make_client(args.session, env)
    await client.connect()
    try:
        if await client.is_user_authorized():
            payload = {
                "status": "already_authorized",
                "me": me_payload(await client.get_me()),
            }
            print(json.dumps(payload, ensure_ascii=False, indent=2))
            return

        qr_login = await client.qr_login()
        render_qr(qr_login.url, args.qr_path)
        initial = {
            "status": "scan_required",
            "qr_path": str(args.qr_path),
            "wait_seconds": args.wait_seconds,
        }
        print(json.dumps(initial, ensure_ascii=False, indent=2), flush=True)
        try:
            await asyncio.wait_for(qr_login.wait(), timeout=args.wait_seconds)
        except asyncio.TimeoutError as exc:
            raise SystemExit("QR login timed out; rerun login-qr and scan again.") from exc
        except errors.SessionPasswordNeededError as exc:
            raise SystemExit("QR accepted, but Telegram account requires 2FA password. Handle manually.") from exc

        payload = {
            "status": "authorized",
            "me": me_payload(await client.get_me()),
            "session_path": str(args.session),
        }
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    finally:
        await client.disconnect()


async def command_login_phone(args):
    env = load_env(args.env_file)
    client = make_client(args.session, env)
    await client.connect()
    try:
        if await client.is_user_authorized():
            payload = {
                "status": "already_authorized",
                "me": me_payload(await client.get_me()),
            }
            print(json.dumps(payload, ensure_ascii=False, indent=2))
            return

        phone = args.phone or input("Telegram phone (international format): ").strip()
        sent = await client.send_code_request(phone)
        print(json.dumps({
            "status": "code_sent",
            "phone": phone,
            "type": sent.type.__class__.__name__,
        }, ensure_ascii=False, indent=2), flush=True)

        code = input("Telegram login code: ").strip()
        try:
            await client.sign_in(phone=phone, code=code, phone_code_hash=sent.phone_code_hash)
        except errors.SessionPasswordNeededError:
            password = getpass.getpass("Telegram 2FA password: ")
            await client.sign_in(password=password)

        payload = {
            "status": "authorized",
            "me": me_payload(await client.get_me()),
            "session_path": str(args.session),
        }
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    finally:
        await client.disconnect()


async def find_dialog_by_title(client: TelegramClient, title: str):
    async for dialog in client.iter_dialogs():
        if dialog.name == title:
            return dialog
    return None


async def ensure_forum_group(client: TelegramClient, title: str, about: str):
    dialog = await find_dialog_by_title(client, title)
    if dialog is not None:
        entity = await client.get_entity(dialog.entity)
        return entity, False

    updates = await client(
        functions.channels.CreateChannelRequest(
            title=title,
            about=about,
            megagroup=True,
            forum=True,
        )
    )
    for chat in updates.chats:
        if getattr(chat, "title", None) == title:
            entity = await client.get_entity(chat)
            return entity, True
    raise RuntimeError(f"Could not resolve created group for {title}")


async def ensure_bot_member_and_admin(client: TelegramClient, channel, bot_username: str):
    bot = await client.get_input_entity(bot_username)
    try:
        await client(functions.channels.InviteToChannelRequest(channel=channel, users=[bot]))
    except errors.UserAlreadyParticipantError:
        pass

    try:
        await client(
            functions.channels.EditAdminRequest(
                channel=channel,
                user_id=bot,
                admin_rights=admin_rights(),
                rank="codex bridge",
            )
        )
    except errors.UserAdminInvalidError:
        # Already admin or Telegram rejected an unnecessary re-promotion.
        pass


async def get_forum_topics(client: TelegramClient, channel):
    topics = []
    peer = await client.get_input_entity(channel)
    offset_date = None
    offset_id = 0
    offset_topic = 0
    while True:
        result = await client(
            functions.messages.GetForumTopicsRequest(
                peer=peer,
                offset_date=offset_date,
                offset_id=offset_id,
                offset_topic=offset_topic,
                limit=100,
            )
        )
        topics.extend(result.topics)
        if len(result.topics) < 100:
            break
        last = result.topics[-1]
        offset_topic = last.id
        offset_id = getattr(last, "top_message", 0) or 0
        offset_date = getattr(last, "date", None)
    return topics


async def ensure_topic(client: TelegramClient, channel, title: str):
    topics = await get_forum_topics(client, channel)
    for topic in topics:
        if topic.title == title:
            return topic, False

    peer = await client.get_input_entity(channel)
    await client(functions.messages.CreateForumTopicRequest(peer=peer, title=title))
    topics = await get_forum_topics(client, channel)
    for topic in topics:
        if topic.title == title:
            return topic, True
    raise RuntimeError(f"Could not resolve created topic for {title}")


def upsert_binding(bindings: dict, chat_id: str, topic_id: int, title: str, thread_id: str):
    key = f"group:{chat_id}:topic:{topic_id}"
    now = utc_now_iso()
    existing = bindings.get(key, {})
    created_at = existing.get("createdAt", now)
    bindings[key] = {
        "threadId": thread_id,
        "transport": "native",
        "chatId": chat_id,
        "messageThreadId": topic_id,
        "chatTitle": title,
        "createdAt": created_at,
        "updatedAt": now,
    }


def lookup_rollout_path(threads_db: Path, thread_id: str):
    conn = sqlite3.connect(threads_db)
    try:
        row = conn.execute("select rollout_path from threads where id = ?", (thread_id,)).fetchone()
        return row[0] if row else None
    finally:
        conn.close()


def extract_text_parts(content):
    parts = []
    for item in content or []:
        if not isinstance(item, dict):
            continue
        text = item.get("text")
        if isinstance(text, str):
            parts.append(text)
    return "\n".join(parts).strip()


def cleanup_user_text(text: str):
    normalized = str(text or "").strip()
    if not normalized:
        return None
    if normalized.startswith("# AGENTS.md instructions"):
        return None
    if normalized.startswith("<turn_aborted>"):
        return None

    if normalized.startswith("<heartbeat>"):
        start = normalized.find("<instructions>")
        end = normalized.find("</instructions>")
        if start != -1 and end != -1 and end > start:
            instructions = normalized[start + len("<instructions>"):end].strip()
            if instructions:
                return f"[heartbeat]\n{instructions}"
        return None

    files_header = "# Files mentioned by the user:"
    if normalized.startswith(files_header):
        request_marker = "## My request for Codex:"
        files = []
        for line in normalized.splitlines():
            stripped = line.strip()
            if stripped.startswith("## ") and stripped.endswith(":") and stripped != request_marker:
                files.append(stripped.removeprefix("## ").removesuffix(":").strip())
        request = normalized.split(request_marker, 1)[1].strip() if request_marker in normalized else normalized
        cleaned_lines = []
        image_count = 0
        for line in request.splitlines():
            stripped = line.strip()
            if stripped.startswith("<image ") or stripped == "</image>":
                if stripped.startswith("<image "):
                    image_count += 1
                continue
            cleaned_lines.append(line)
        body = "\n".join(cleaned_lines).strip()
        prefix = []
        if files:
            prefix.append("[files]\n" + "\n".join(f"- {name}" for name in files))
        if image_count:
            prefix.append(f"[attached images omitted: {image_count}]")
        if body:
            prefix.append(body)
        return "\n\n".join(part for part in prefix if part).strip() or None

    return normalized


def load_thread_history(rollout_path: Path, stop_after_user_text: str | None = None):
    messages = []
    stop_text = str(stop_after_user_text or "").strip() or None
    for line in rollout_path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        obj = json.loads(line)
        if obj.get("type") != "response_item":
            continue
        payload = obj.get("payload", {})
        if payload.get("type") != "message":
            continue
        role = payload.get("role")
        if role not in {"user", "assistant"}:
            continue
        raw_text = extract_text_parts(payload.get("content", []))
        if not raw_text:
            continue
        if role == "user":
            text = cleanup_user_text(raw_text)
        else:
            text = raw_text.strip()
        if not text:
            continue
        messages.append(
            {
                "role": role,
                "phase": payload.get("phase"),
                "text": text,
            }
        )
        if stop_text and role == "user" and text.strip() == stop_text:
            break
    return messages


async def topic_message_count(client: TelegramClient, chat_id: int, topic_id: int, limit: int = 500):
    entity = await client.get_entity(chat_id)
    count = 0
    async for message in client.iter_messages(entity, limit=limit, reply_to=topic_id):
        if getattr(message, "action", None) is not None:
            continue
        count += 1
    return count


async def send_user_chunks(client: TelegramClient, chat_id: int, topic_id: int, text: str):
    entity = await client.get_entity(chat_id)
    sent = 0
    for chunk in split_telegram_text(text):
        await client.send_message(entity, chunk, reply_to=topic_id, link_preview=False)
        sent += 1
    return sent


def send_bot_chunks(bot_token: str, chat_id: int, topic_id: int, text: str):
    sent = 0
    for chunk in split_telegram_text(text):
        call_bot_api(
            bot_token,
            "sendMessage",
            {
                "chat_id": chat_id,
                "message_thread_id": topic_id,
                "text": chunk,
                "disable_web_page_preview": True,
            },
        )
        sent += 1
    return sent


def format_labeled_history_text(item: dict):
    label = "Anton" if item.get("role") == "user" else "Codex"
    return f"{label}:\n{item.get('text', '').strip()}".strip()


def build_history_transmissions(messages, sender_mode: str):
    transmissions = []
    for item in messages:
        if sender_mode == "labeled-bot":
            base_text = format_labeled_history_text(item)
            sender = "bot"
        else:
            base_text = item["text"]
            sender = "user" if item["role"] == "user" else "bot"
        for chunk in split_telegram_text(base_text):
            transmissions.append(
                {
                    "sender": sender,
                    "text": chunk,
                    "role": item["role"],
                }
            )
    return transmissions


async def command_bootstrap(args):
    env = load_env(args.env_file)
    plan = load_json(args.plan, {"projects": []})
    bridge_state = load_json(args.bridge_state, {"version": 1, "lastUpdateId": 0, "bindings": {}})

    client = make_client(args.session, env)
    await client.connect()
    try:
        if not await client.is_user_authorized():
            raise SystemExit("Session is not authorized. Run login-qr first.")
        me = await client.get_me()

        summary = {
            "me": me_payload(me),
            "groups": [],
        }

        for project in plan.get("projects", []):
            group, created_group = await ensure_forum_group(
                client,
                title=project["groupTitle"],
                about=project.get("about", ""),
            )
            await ensure_bot_member_and_admin(client, group, args.bot_username)
            chat_id = bot_api_chat_id(group.id)

            group_summary = {
                "projectRoot": project["projectRoot"],
                "groupTitle": project["groupTitle"],
                "groupId": group.id,
                "botApiChatId": chat_id,
                "createdGroup": created_group,
                "topics": [],
            }

            for topic_plan in project.get("topics", []):
                topic, created_topic = await ensure_topic(client, group, topic_plan["title"])
                upsert_binding(
                    bridge_state["bindings"],
                    chat_id=chat_id,
                    topic_id=topic.id,
                    title=project["groupTitle"],
                    thread_id=topic_plan["threadId"],
                )
                group_summary["topics"].append(
                    {
                        "title": topic.title,
                        "topicId": topic.id,
                        "threadId": topic_plan["threadId"],
                        "createdTopic": created_topic,
                    }
                )

            summary["groups"].append(group_summary)
    finally:
        await client.disconnect()

    save_json(args.bridge_state, bridge_state)
    save_json(args.result_path, summary)
    print(json.dumps(summary, ensure_ascii=False, indent=2))


async def command_backfill_thread(args):
    env = load_env(args.env_file)
    client = make_client(args.session, env)
    bot_token = load_bot_token(args.bot_token_env, args.bot_token_keychain_service)
    rollout_path = args.rollout_path
    if rollout_path is None:
        resolved = lookup_rollout_path(args.threads_db, args.thread_id)
        if not resolved:
            raise SystemExit(f"thread not found in threads DB: {args.thread_id}")
        rollout_path = Path(resolved)
    if not rollout_path.exists():
        raise SystemExit(f"rollout path not found: {rollout_path}")

    messages = load_thread_history(rollout_path, stop_after_user_text=args.stop_after_user_text)
    if not messages:
        raise SystemExit(f"no clean history messages found in {rollout_path}")

    await client.connect()
    try:
        if not await client.is_user_authorized():
            raise SystemExit("Session is not authorized. Run login-qr first.")
        transmissions = build_history_transmissions(messages, args.sender_mode)
        existing_count = await topic_message_count(client, args.chat_id, args.topic_id, limit=len(transmissions) + 50)
        start_index = min(existing_count, len(transmissions)) if not args.force else 0
        if existing_count > len(transmissions) and not args.force:
            raise SystemExit(
                f"topic already has {existing_count} visible message(s), which is more than planned transmissions {len(transmissions)}"
            )

        sent_messages = start_index
        user_messages = sum(1 for item in messages if item["role"] == "user")
        assistant_messages = sum(1 for item in messages if item["role"] == "assistant")
        entity = await client.get_entity(args.chat_id)

        for transmission in transmissions[start_index:]:
            if transmission["sender"] == "user":
                await client.send_message(entity, transmission["text"], reply_to=args.topic_id, link_preview=False)
            else:
                while True:
                    try:
                        send_bot_chunks(bot_token, args.chat_id, args.topic_id, transmission["text"])
                        break
                    except TelegramRetryAfterError as error:
                        await asyncio.sleep(error.retry_after + 1)
            sent_messages += 1
            if args.message_delay_ms > 0:
                await asyncio.sleep(args.message_delay_ms / 1000)
    finally:
        await client.disconnect()

    print(
        json.dumps(
            {
                "status": "ok",
                "threadId": args.thread_id,
                "chatId": args.chat_id,
                "topicId": args.topic_id,
                "rolloutPath": str(rollout_path),
                "historyMessages": len(messages),
                "transmissions": len(transmissions),
                "resumedFrom": start_index,
                "userMessages": user_messages,
                "assistantMessages": assistant_messages,
                "telegramMessagesSent": sent_messages,
                "senderMode": args.sender_mode,
            },
            ensure_ascii=False,
            indent=2,
        )
    )


def build_parser():
    parser = argparse.ArgumentParser(description="User-side Telegram admin helper for Codex bridge.")
    parser.add_argument("--env-file", type=Path, default=DEFAULT_ENV_PATH)
    parser.add_argument("--session", type=Path, default=DEFAULT_SESSION_PATH)

    subparsers = parser.add_subparsers(dest="command", required=True)

    whoami = subparsers.add_parser("whoami")
    whoami.set_defaults(handler=command_whoami)

    login_qr = subparsers.add_parser("login-qr")
    login_qr.add_argument("--qr-path", type=Path, default=DEFAULT_QR_PATH)
    login_qr.add_argument("--wait-seconds", type=int, default=300)
    login_qr.set_defaults(handler=command_login_qr)

    login_phone = subparsers.add_parser("login-phone")
    login_phone.add_argument("--phone", default=None)
    login_phone.set_defaults(handler=command_login_phone)

    bootstrap = subparsers.add_parser("bootstrap")
    bootstrap.add_argument("--plan", type=Path, default=DEFAULT_PLAN_PATH)
    bootstrap.add_argument("--result-path", type=Path, default=DEFAULT_RESULT_PATH)
    bootstrap.add_argument("--bridge-state", type=Path, default=DEFAULT_BRIDGE_STATE_PATH)
    bootstrap.add_argument("--bot-username", default="cdxanton2026bot")
    bootstrap.set_defaults(handler=command_bootstrap)

    backfill = subparsers.add_parser("backfill-thread")
    backfill.add_argument("--thread-id", required=True)
    backfill.add_argument("--chat-id", type=int, required=True)
    backfill.add_argument("--topic-id", type=int, required=True)
    backfill.add_argument("--threads-db", type=Path, default=DEFAULT_THREADS_DB_PATH)
    backfill.add_argument("--rollout-path", type=Path, default=None)
    backfill.add_argument("--bot-token-env", default="CODEX_TELEGRAM_BOT_TOKEN")
    backfill.add_argument("--bot-token-keychain-service", default=DEFAULT_BOT_TOKEN_KEYCHAIN_SERVICE)
    backfill.add_argument("--message-delay-ms", type=int, default=DEFAULT_MESSAGE_DELAY_MS)
    backfill.add_argument("--stop-after-user-text", default=None)
    backfill.add_argument("--sender-mode", choices=["labeled-bot", "mixed"], default="labeled-bot")
    backfill.add_argument("--force", action="store_true")
    backfill.set_defaults(handler=command_backfill_thread)

    return parser


async def amain():
    parser = build_parser()
    args = parser.parse_args()
    await args.handler(args)


if __name__ == "__main__":
    asyncio.run(amain())
