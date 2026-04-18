#!/usr/bin/env python3

import argparse
import asyncio
import inspect
import json
import os
import getpass
import re
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
DEFAULT_CONFIG_PATH = PROJECT_ROOT / "config.local.json"
DEFAULT_SESSION_PATH = PROJECT_ROOT / "state" / "anton_user"
DEFAULT_QR_PATH = PROJECT_ROOT / "state" / "login-qr.png"
DEFAULT_PLAN_PATH = ROOT / "bootstrap-plan.json"
DEFAULT_RESULT_PATH = PROJECT_ROOT / "state" / "bootstrap-result.json"
DEFAULT_BRIDGE_STATE_PATH = PROJECT_ROOT / "state" / "state.json"
DEFAULT_RENDER_HELPER_PATH = PROJECT_ROOT / "scripts" / "render_telegram_text.mjs"
DEFAULT_FOLDER_TITLE = "codex"
DEFAULT_TOPIC_DISPLAY = "tabs"
DEFAULT_THREADS_DB_PATH = Path.home() / ".codex" / "state_5.sqlite"
DEFAULT_BOT_TOKEN_KEYCHAIN_SERVICE = "codex-telegram-bridge-bot-token"
DEFAULT_MESSAGE_DELAY_MS = 1100
DEFAULT_BACKFILL_MAX_HISTORY_MESSAGES = 40
DEFAULT_CLEANUP_SCAN_LIMIT = 300
TELEGRAM_TEXT_LIMIT = 3500
TELEGRAM_HTML_TEXT_LIMIT = 3500
DEFAULT_BACKFILL_ASSISTANT_PHASES = ("final_answer",)
CODEX_APP_DIRECTIVE_LINE = re.compile(r"^::[a-z][\w-]*\{.*\}\s*$", re.IGNORECASE)
MEMORY_CITATION_BLOCK_PATTERN = re.compile(r"<oai-mem-citation>[\s\S]*?(?:</oai-mem-citation>|$)", re.IGNORECASE)
MEMORY_CITATION_CHILD_BLOCK_PATTERN = re.compile(
    r"<(?:citation_entries|rollout_ids)>[\s\S]*?</(?:citation_entries|rollout_ids)>",
    re.IGNORECASE,
)
DEFAULT_HISTORY_USER_NOISE_PREFIXES = (
    "Reply with exactly this text",
    "Тест",
)
DEFAULT_HISTORY_ASSISTANT_NOISE_PREFIXES = (
    "TG_SYNC_",
    "TG_TOPIC_",
    "TG_ATTACH_",
    "APP_CTRL_",
    "THREAD_PING_",
    "На месте.",
)
DEFAULT_CLEANUP_TEXT_PREFIXES = (
    "/",
    "Текущая привязка",
    "Bridge health",
    "Project status:",
    "Dry-run:",
    "Sync plan:",
    "Working set",
    "Синхронизировал",
    "Привязал",
    "Отвязал",
    "Справку кинул",
    "Preview `/sync-project`",
    "OUTBOUND_",
    "UX_",
    "TG_SYNC_",
    "TG_ATTACH_",
    "Reply with exactly this text",
    "v1 понимает только текстовые сообщения.",
    "На месте.",
    "Тест",
    "Anton:\nReply with exactly this text",
    "Anton:\nТест",
    "Codex:\nTG_SYNC_",
    "Codex:\nTG_TOPIC_",
    "Codex:\nTG_ATTACH_",
    "Codex:\nAPP_CTRL_",
    "Codex:\nTHREAD_PING_",
    "Codex:\nНа месте.",
)


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


def bootstrap_group_identity(group: dict):
    for key in ("botApiChatId", "groupId", "groupTitle"):
        value = group.get(key)
        if value:
            return f"{key}:{value}"
    return None


def merge_bootstrap_results(existing: dict, current: dict):
    if not isinstance(existing, dict) or not isinstance(existing.get("groups"), list):
        return current

    merged = {**existing, **current}
    groups_by_key = {}
    ordered_keys = []
    for group in [*existing.get("groups", []), *current.get("groups", [])]:
        if not isinstance(group, dict):
            continue
        identity = bootstrap_group_identity(group)
        if not identity:
            continue
        if identity not in groups_by_key:
            ordered_keys.append(identity)
        groups_by_key[identity] = group
    merged["groups"] = [groups_by_key[key] for key in ordered_keys]
    return merged


def normalize_bot_username(value) -> str:
    return str(value or "").strip().lstrip("@")


def resolve_bot_username(args) -> str:
    bridge_config = load_json(DEFAULT_CONFIG_PATH, {})
    return normalize_bot_username(
        args.bot_username
        or os.getenv("CODEX_TELEGRAM_BOT_USERNAME")
        or bridge_config.get("botUsername")
    )


def resolve_folder_title(args, plan) -> str:
    plan_onboarding = plan.get("onboarding", {}) if isinstance(plan, dict) else {}
    return str(args.folder_title or plan_onboarding.get("folderTitle") or DEFAULT_FOLDER_TITLE).strip()


def resolve_topic_display(args, plan) -> str:
    plan_onboarding = plan.get("onboarding", {}) if isinstance(plan, dict) else {}
    topic_display = str(args.topic_display or plan_onboarding.get("topicDisplay") or DEFAULT_TOPIC_DISPLAY).strip().lower()
    if topic_display not in {"tabs", "list"}:
        raise SystemExit("topic display must be 'tabs' or 'list'")
    return topic_display


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


def render_texts_with_node(texts, render_helper: Path):
    completed = subprocess.run(
        ["node", str(render_helper)],
        input=json.dumps({"texts": texts}, ensure_ascii=False),
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=True,
    )
    payload = json.loads(completed.stdout)
    rendered = payload.get("rendered")
    if not isinstance(rendered, list) or len(rendered) != len(texts):
        raise RuntimeError(f"invalid renderer response from {render_helper}")
    return rendered


def render_history_texts(texts, render_mode: str, render_helper: Path):
    if render_mode == "plain":
        return [
            [{"html": None, "plain": chunk} for chunk in split_telegram_text(text, TELEGRAM_HTML_TEXT_LIMIT)]
            for text in texts
        ]
    try:
        return render_texts_with_node(texts, render_helper)
    except (FileNotFoundError, subprocess.CalledProcessError, json.JSONDecodeError, RuntimeError) as error:
        raise SystemExit(f"Telegram HTML renderer failed: {error}") from error


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


async def ensure_forum_display(client: TelegramClient, channel, topic_display: str):
    await client(
        functions.channels.ToggleForumRequest(
            channel=channel,
            enabled=True,
            tabs=topic_display == "tabs",
        )
    )


async def ensure_forum_group(client: TelegramClient, title: str, about: str, topic_display: str):
    dialog = await find_dialog_by_title(client, title)
    if dialog is not None:
        entity = await client.get_entity(dialog.entity)
        await ensure_forum_display(client, entity, topic_display)
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
            await ensure_forum_display(client, entity, topic_display)
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


def dialog_filter_title(dialog_filter) -> str:
    title = getattr(dialog_filter, "title", None)
    return str(getattr(title, "text", title) or "")


def input_peer_key(peer):
    for attr in ("channel_id", "chat_id", "user_id"):
        value = getattr(peer, attr, None)
        if value is not None:
            return (peer.__class__.__name__, value)
    return (peer.__class__.__name__, repr(peer))


def next_dialog_filter_id(filters):
    used = {getattr(item, "id", None) for item in filters}
    for candidate in range(2, 256):
        if candidate not in used:
            return candidate
    raise RuntimeError("No free Telegram dialog filter id available")


def clone_dialog_filter_with_peers(dialog_filter, include_peers):
    return types.DialogFilter(
        id=dialog_filter.id,
        title=dialog_filter.title,
        pinned_peers=list(getattr(dialog_filter, "pinned_peers", None) or []),
        include_peers=include_peers,
        exclude_peers=list(getattr(dialog_filter, "exclude_peers", None) or []),
        contacts=getattr(dialog_filter, "contacts", None),
        non_contacts=getattr(dialog_filter, "non_contacts", None),
        groups=getattr(dialog_filter, "groups", None),
        broadcasts=getattr(dialog_filter, "broadcasts", None),
        bots=getattr(dialog_filter, "bots", None),
        exclude_muted=getattr(dialog_filter, "exclude_muted", None),
        exclude_read=getattr(dialog_filter, "exclude_read", None),
        exclude_archived=getattr(dialog_filter, "exclude_archived", None),
        title_noanimate=getattr(dialog_filter, "title_noanimate", None),
        emoticon=getattr(dialog_filter, "emoticon", None),
        color=getattr(dialog_filter, "color", None),
    )


async def ensure_dialog_folder(client: TelegramClient, title: str, channels):
    normalized_title = str(title or "").strip()
    if not normalized_title:
        return None

    response = await client(functions.messages.GetDialogFiltersRequest())
    filters = list(getattr(response, "filters", []) or [])
    existing = next(
        (
            item
            for item in filters
            if item.__class__.__name__ == "DialogFilter"
            and dialog_filter_title(item) == normalized_title
        ),
        None,
    )
    input_peers = [await client.get_input_entity(channel) for channel in channels]
    input_by_key = {input_peer_key(peer): peer for peer in input_peers}

    if existing:
        current_peers = list(getattr(existing, "include_peers", None) or [])
        current_keys = {input_peer_key(peer) for peer in current_peers}
        added_peers = [peer for key, peer in input_by_key.items() if key not in current_keys]
        if added_peers:
            next_filter = clone_dialog_filter_with_peers(existing, current_peers + added_peers)
            await client(functions.messages.UpdateDialogFilterRequest(id=existing.id, filter=next_filter))
        return {
            "title": normalized_title,
            "id": existing.id,
            "created": False,
            "addedPeers": len(added_peers),
            "totalPeers": len(current_peers) + len(added_peers),
        }

    filter_id = next_dialog_filter_id(filters)
    dialog_filter = types.DialogFilter(
        id=filter_id,
        title=types.TextWithEntities(normalized_title, []),
        pinned_peers=[],
        include_peers=input_peers,
        exclude_peers=[],
        groups=False,
        broadcasts=False,
        bots=False,
        contacts=False,
        non_contacts=False,
        exclude_muted=False,
        exclude_read=False,
        exclude_archived=False,
    )
    await client(functions.messages.UpdateDialogFilterRequest(id=filter_id, filter=dialog_filter))
    return {
        "title": normalized_title,
        "id": filter_id,
        "created": True,
        "addedPeers": len(input_peers),
        "totalPeers": len(input_peers),
    }


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
        **existing,
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


def cleanup_user_text(text: str, include_heartbeats: bool = False):
    normalized = str(text or "").strip()
    if not normalized:
        return None
    if normalized.startswith("# AGENTS.md instructions"):
        return None
    if normalized.startswith("<turn_aborted>"):
        return None

    if normalized.startswith("<heartbeat>"):
        if not include_heartbeats:
            return None
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


def cleanup_assistant_text(text: str):
    normalized = str(text or "").replace("\r\n", "\n").strip()
    if not normalized:
        return None
    without_internal_blocks = MEMORY_CITATION_BLOCK_PATTERN.sub("", normalized)
    without_internal_blocks = MEMORY_CITATION_CHILD_BLOCK_PATTERN.sub("", without_internal_blocks)
    cleaned = "\n".join(
        line
        for line in without_internal_blocks.split("\n")
        if not CODEX_APP_DIRECTIVE_LINE.match(line.strip())
    )
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned).strip()
    return cleaned or None


def is_history_noise(role: str, text: str) -> bool:
    prefixes = (
        DEFAULT_HISTORY_USER_NOISE_PREFIXES
        if role == "user"
        else DEFAULT_HISTORY_ASSISTANT_NOISE_PREFIXES
    )
    return any(str(text or "").strip().startswith(prefix) for prefix in prefixes)


def limit_history_messages(messages, max_history_messages: int | None = DEFAULT_BACKFILL_MAX_HISTORY_MESSAGES, max_user_prompts: int | None = None):
    limited = list(messages)
    if max_user_prompts and max_user_prompts > 0:
        tail = []
        user_prompts = 0
        for item in reversed(limited):
            if item.get("role") == "user":
                if user_prompts >= max_user_prompts:
                    break
                user_prompts += 1
            tail.append(item)
        limited = list(reversed(tail))

    if max_history_messages and max_history_messages > 0:
        limited = limited[-max_history_messages:]
        for index, item in enumerate(limited):
            if item.get("role") == "user":
                limited = limited[index:]
                break
    return limited


def load_thread_history(
    rollout_path: Path,
    stop_after_user_text: str | None = None,
    assistant_phases=None,
    include_heartbeats: bool = False,
    max_history_messages: int | None = DEFAULT_BACKFILL_MAX_HISTORY_MESSAGES,
    max_user_prompts: int | None = None,
):
    messages = []
    stop_text = str(stop_after_user_text or "").strip() or None
    allowed_assistant_phases = set(assistant_phases or DEFAULT_BACKFILL_ASSISTANT_PHASES)
    with rollout_path.open("r", encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
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
                text = cleanup_user_text(raw_text, include_heartbeats=include_heartbeats)
            else:
                if payload.get("phase") not in allowed_assistant_phases:
                    continue
                text = cleanup_assistant_text(raw_text)
            if not text:
                continue
            if is_history_noise(role, text):
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
    return limit_history_messages(
        messages,
        max_history_messages=max_history_messages,
        max_user_prompts=max_user_prompts,
    )


async def topic_message_count(client: TelegramClient, chat_id: int, topic_id: int, limit: int = 500, ignore_message_ids=None):
    entity = await client.get_entity(chat_id)
    ignored = set(ignore_message_ids or [])
    count = 0
    async for message in client.iter_messages(entity, limit=limit, reply_to=topic_id):
        if message.id in ignored:
            continue
        if getattr(message, "action", None) is not None:
            continue
        count += 1
    return count


def normalize_resume_text(text: str) -> str:
    return str(text or "").replace("\r\n", "\n").strip()


async def topic_visible_texts(client: TelegramClient, chat_id: int, topic_id: int, limit: int = 500, ignore_message_ids=None):
    entity = await client.get_entity(chat_id)
    ignored = set(ignore_message_ids or [])
    texts = []
    async for message in client.iter_messages(entity, limit=limit, reply_to=topic_id):
        if message.id in ignored:
            continue
        if getattr(message, "action", None) is not None:
            continue
        text = normalize_resume_text(message.message or "")
        if text:
            texts.append(text)
    return list(reversed(texts))


def find_transmission_resume_index(transmissions, existing_texts):
    existing = set(normalize_resume_text(text) for text in existing_texts if normalize_resume_text(text))
    index = 0
    while index < len(transmissions) and normalize_resume_text(transmissions[index].get("text", "")) in existing:
        index += 1
    return index


def filter_missing_transmissions(transmissions, existing_texts):
    existing = set(normalize_resume_text(text) for text in existing_texts if normalize_resume_text(text))
    return [
        item
        for item in transmissions
        if normalize_resume_text(item.get("text", "")) not in existing
    ]


def binding_key_for_topic(chat_id: int, topic_id: int) -> str:
    return f"group:{chat_id}:topic:{topic_id}"


def load_keep_message_ids_from_bridge_state(bridge_state_path: Path, chat_id: int, topic_id: int):
    state = load_json(bridge_state_path, {})
    binding = state.get("bindings", {}).get(binding_key_for_topic(chat_id, topic_id), {})
    keep_ids = {topic_id}
    for key in ("statusBarMessageId",):
        value = binding.get(key)
        if isinstance(value, int):
            keep_ids.add(value)
    return keep_ids


def preview_text(text: str, limit: int = 180) -> str:
    normalized = " ".join(str(text or "").split())
    if len(normalized) <= limit:
        return normalized
    return normalized[: limit - 1] + "…"


def cleanup_candidate_reason(message, prefixes, contains, keep_message_ids):
    if message.id in keep_message_ids:
        return None
    if getattr(message, "action", None) is not None:
        return "service-action"

    text = str(message.message or "").strip()
    if not text:
        return None
    for prefix in prefixes:
        if text.startswith(prefix):
            return f"prefix:{prefix}"
    for needle in contains:
        if needle and needle in text:
            return f"contains:{needle}"
    return None


async def collect_topic_cleanup_candidates(
    client: TelegramClient,
    chat_id: int,
    topic_id: int,
    *,
    scan_limit: int,
    prefixes,
    contains,
    keep_message_ids,
):
    entity = await client.get_entity(chat_id)
    candidates = []
    async for message in client.iter_messages(entity, limit=scan_limit, reply_to=topic_id):
        reason = cleanup_candidate_reason(message, prefixes, contains, keep_message_ids)
        if not reason:
            continue
        candidates.append(
            {
                "id": message.id,
                "date": message.date.isoformat() if message.date else None,
                "reason": reason,
                "pinned": bool(getattr(message, "pinned", False)),
                "textPreview": preview_text(message.message or f"<action {type(message.action).__name__}>"),
            }
        )
    return candidates


async def delete_topic_messages(client: TelegramClient, chat_id: int, message_ids):
    entity = await client.get_entity(chat_id)
    deleted = 0
    ids = list(message_ids)
    for index in range(0, len(ids), 100):
        chunk = ids[index : index + 100]
        if chunk:
            await client.delete_messages(entity, chunk)
            deleted += len(chunk)
    return deleted


async def send_user_transmission(client: TelegramClient, chat_id: int, topic_id: int, transmission: dict):
    entity = await client.get_entity(chat_id)
    html_text = transmission.get("html")
    await client.send_message(
        entity,
        html_text or transmission["text"],
        reply_to=topic_id,
        link_preview=False,
        parse_mode="html" if html_text else None,
    )
    return 1


def send_bot_transmission(bot_token: str, chat_id: int, topic_id: int, transmission: dict):
    html_text = transmission.get("html")
    payload = {
        "chat_id": chat_id,
        "message_thread_id": topic_id,
        "text": html_text or transmission["text"],
        "disable_web_page_preview": True,
    }
    if html_text:
        payload["parse_mode"] = "HTML"
    call_bot_api(bot_token, "sendMessage", payload)
    return 1


def format_labeled_history_text(item: dict):
    label = "Anton" if item.get("role") == "user" else "Codex"
    return f"**{label}:**\n{item.get('text', '').strip()}".strip()


def build_history_transmissions(messages, sender_mode: str, render_mode: str, render_helper: Path):
    base_items = []
    for item in messages:
        if sender_mode == "labeled-bot":
            base_text = format_labeled_history_text(item)
            sender = "bot"
        else:
            base_text = item["text"]
            sender = "user" if item["role"] == "user" else "bot"
        base_items.append({"sender": sender, "text": base_text, "role": item["role"]})

    rendered_texts = render_history_texts([item["text"] for item in base_items], render_mode, render_helper)
    transmissions = []
    for item, rendered_chunks in zip(base_items, rendered_texts):
        for chunk in rendered_chunks:
            plain = str(chunk.get("plain") or "").strip()
            html_text = str(chunk.get("html") or "").strip() or None
            transmissions.append(
                {
                    "sender": item["sender"],
                    "text": plain or item["text"],
                    "html": html_text,
                    "role": item["role"],
                }
            )
    return transmissions


async def command_bootstrap(args):
    env = load_env(args.env_file)
    plan = load_json(args.plan, {"projects": []})
    bridge_state = load_json(args.bridge_state, {"version": 1, "lastUpdateId": 0, "bindings": {}})
    bot_username = resolve_bot_username(args)
    folder_title = resolve_folder_title(args, plan)
    topic_display = resolve_topic_display(args, plan)
    if not bot_username:
        raise SystemExit(
            "Bot username is required. Pass --bot-username, set CODEX_TELEGRAM_BOT_USERNAME, or set botUsername in config.local.json."
        )

    client = make_client(args.session, env)
    await client.connect()
    try:
        if not await client.is_user_authorized():
            raise SystemExit("Session is not authorized. Run login-qr first.")
        me = await client.get_me()

        summary = {
            "me": me_payload(me),
            "groups": [],
            "folder": None,
            "folderTitle": folder_title,
            "topicDisplay": topic_display,
            "rehearsal": bool(plan.get("onboarding", {}).get("rehearsal")),
        }
        folder_channels = []

        for project in plan.get("projects", []):
            group, created_group = await ensure_forum_group(
                client,
                title=project["groupTitle"],
                about=project.get("about", ""),
                topic_display=topic_display,
            )
            folder_channels.append(group)
            await ensure_bot_member_and_admin(client, group, bot_username)
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

        if not args.skip_folder and folder_channels:
            summary["folder"] = await ensure_dialog_folder(client, folder_title, folder_channels)
    finally:
        await client.disconnect()

    save_json(args.bridge_state, bridge_state)
    result_payload = summary
    if not args.replace_result:
        result_payload = merge_bootstrap_results(load_json(args.result_path, {}), summary)
    save_json(args.result_path, result_payload)
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

    assistant_phases = args.assistant_phase or list(DEFAULT_BACKFILL_ASSISTANT_PHASES)
    messages = load_thread_history(
        rollout_path,
        stop_after_user_text=args.stop_after_user_text,
        assistant_phases=assistant_phases,
        include_heartbeats=args.include_heartbeats,
        max_history_messages=args.max_history_messages,
        max_user_prompts=args.max_user_prompts,
    )
    if not messages:
        raise SystemExit(f"no clean history messages found in {rollout_path}")

    await client.connect()
    try:
        if not await client.is_user_authorized():
            raise SystemExit("Session is not authorized. Run login-qr first.")
        transmissions = build_history_transmissions(
            messages,
            args.sender_mode,
            render_mode=args.render_mode,
            render_helper=args.render_helper,
        )
        ignored_existing_ids = set(args.ignore_message_id or [])
        if args.ignore_live_state:
            ignored_existing_ids.update(
                load_keep_message_ids_from_bridge_state(args.bridge_state, args.chat_id, args.topic_id)
            )
        existing_texts = await topic_visible_texts(
            client,
            args.chat_id,
            args.topic_id,
            limit=len(transmissions) + 100,
            ignore_message_ids=ignored_existing_ids,
        )
        resume_index = 0 if args.force else find_transmission_resume_index(transmissions, existing_texts)
        pending_transmissions = transmissions if args.force else filter_missing_transmissions(transmissions, existing_texts)
        skipped_existing = len(transmissions) - len(pending_transmissions)
        if args.dry_run:
            print(
                json.dumps(
                    {
                        "status": "dry-run",
                        "threadId": args.thread_id,
                        "chatId": args.chat_id,
                        "topicId": args.topic_id,
                        "rolloutPath": str(rollout_path),
                        "historyMessages": len(messages),
                        "transmissions": len(transmissions),
                        "transmissionsToSend": len(pending_transmissions),
                        "existingHistoryMessages": len(existing_texts),
                        "resumedFrom": resume_index,
                        "skippedExisting": skipped_existing,
                        "ignoredExistingMessageIds": sorted(ignored_existing_ids),
                        "userMessages": sum(1 for item in messages if item["role"] == "user"),
                        "assistantMessages": sum(1 for item in messages if item["role"] == "assistant"),
                        "assistantPhases": assistant_phases,
                        "maxHistoryMessages": args.max_history_messages,
                        "maxUserPrompts": args.max_user_prompts,
                        "senderMode": args.sender_mode,
                        "renderMode": args.render_mode,
                        "preview": [
                            {
                                "role": item["role"],
                                "phase": item.get("phase"),
                                "textPreview": preview_text(item.get("text", "")),
                            }
                            for item in messages[: min(8, len(messages))]
                        ],
                    },
                    ensure_ascii=False,
                    indent=2,
                )
            )
            return

        sent_messages = 0
        user_messages = sum(1 for item in messages if item["role"] == "user")
        assistant_messages = sum(1 for item in messages if item["role"] == "assistant")

        for transmission in pending_transmissions:
            if transmission["sender"] == "user":
                await send_user_transmission(client, args.chat_id, args.topic_id, transmission)
            else:
                while True:
                    try:
                        send_bot_transmission(bot_token, args.chat_id, args.topic_id, transmission)
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
                "transmissionsToSend": len(pending_transmissions),
                "resumedFrom": resume_index,
                "skippedExisting": skipped_existing,
                "userMessages": user_messages,
                "assistantMessages": assistant_messages,
                "telegramMessagesSent": sent_messages,
                "senderMode": args.sender_mode,
                "renderMode": args.render_mode,
                "assistantPhases": assistant_phases,
                "maxHistoryMessages": args.max_history_messages,
                "maxUserPrompts": args.max_user_prompts,
            },
            ensure_ascii=False,
            indent=2,
        )
    )


async def command_cleanup_topic(args):
    env = load_env(args.env_file)
    client = make_client(args.session, env)
    keep_message_ids = set(args.keep_message_id or [])
    if args.keep_live_state:
        keep_message_ids.update(load_keep_message_ids_from_bridge_state(args.bridge_state, args.chat_id, args.topic_id))

    prefixes = list(DEFAULT_CLEANUP_TEXT_PREFIXES)
    prefixes.extend(args.prefix or [])
    contains = list(args.contains or [])

    await client.connect()
    try:
        if not await client.is_user_authorized():
            raise SystemExit("Session is not authorized. Run login-qr first.")
        candidates = await collect_topic_cleanup_candidates(
            client,
            args.chat_id,
            args.topic_id,
            scan_limit=args.scan_limit,
            prefixes=prefixes,
            contains=contains,
            keep_message_ids=keep_message_ids,
        )
        deleted = 0
        if args.delete and candidates:
            deleted = await delete_topic_messages(client, args.chat_id, [item["id"] for item in candidates])
    finally:
        await client.disconnect()

    print(
        json.dumps(
            {
                "status": "deleted" if args.delete else "dry-run",
                "chatId": args.chat_id,
                "topicId": args.topic_id,
                "scanLimit": args.scan_limit,
                "candidateCount": len(candidates),
                "deletedCount": deleted,
                "keepMessageIds": sorted(keep_message_ids),
                "candidates": candidates,
            },
            ensure_ascii=False,
            indent=2,
        )
    )


async def command_pin_message(args):
    env = load_env(args.env_file)
    client = make_client(args.session, env)
    await client.connect()
    try:
        if not await client.is_user_authorized():
            raise SystemExit("Session is not authorized. Run login-qr first.")
        entity = await client.get_entity(args.chat_id)
        await client(
            functions.messages.UpdatePinnedMessageRequest(
                peer=entity,
                id=args.message_id,
                silent=args.silent,
            )
        )
        message = await client.get_messages(entity, ids=args.message_id)
    finally:
        await client.disconnect()

    print(
        json.dumps(
            {
                "status": "ok",
                "chatId": args.chat_id,
                "messageId": args.message_id,
                "pinned": bool(getattr(message, "pinned", False)),
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
    bootstrap.add_argument("--bot-username", default=None)
    bootstrap.add_argument("--folder-title", default=None)
    bootstrap.add_argument("--topic-display", choices=["tabs", "list"], default=None)
    bootstrap.add_argument("--replace-result", action="store_true")
    bootstrap.add_argument("--skip-folder", action="store_true")
    bootstrap.set_defaults(handler=command_bootstrap)

    backfill = subparsers.add_parser("backfill-thread")
    backfill.add_argument("--thread-id", required=True)
    backfill.add_argument("--chat-id", type=int, required=True)
    backfill.add_argument("--topic-id", type=int, required=True)
    backfill.add_argument("--threads-db", type=Path, default=DEFAULT_THREADS_DB_PATH)
    backfill.add_argument("--rollout-path", type=Path, default=None)
    backfill.add_argument("--bridge-state", type=Path, default=DEFAULT_BRIDGE_STATE_PATH)
    backfill.add_argument("--bot-token-env", default="CODEX_TELEGRAM_BOT_TOKEN")
    backfill.add_argument("--bot-token-keychain-service", default=DEFAULT_BOT_TOKEN_KEYCHAIN_SERVICE)
    backfill.add_argument("--message-delay-ms", type=int, default=DEFAULT_MESSAGE_DELAY_MS)
    backfill.add_argument("--render-mode", choices=["html", "plain"], default="html")
    backfill.add_argument("--render-helper", type=Path, default=DEFAULT_RENDER_HELPER_PATH)
    backfill.add_argument("--stop-after-user-text", default=None)
    backfill.add_argument("--assistant-phase", action="append", default=None)
    backfill.add_argument("--max-history-messages", type=int, default=DEFAULT_BACKFILL_MAX_HISTORY_MESSAGES)
    backfill.add_argument("--max-user-prompts", type=int, default=None)
    backfill.add_argument("--include-heartbeats", action="store_true")
    backfill.add_argument("--ignore-message-id", action="append", type=int, default=None)
    backfill.add_argument("--no-ignore-live-state", dest="ignore_live_state", action="store_false")
    backfill.add_argument("--dry-run", action="store_true")
    backfill.add_argument("--sender-mode", choices=["labeled-bot", "mixed"], default="labeled-bot")
    backfill.add_argument("--force", action="store_true")
    backfill.set_defaults(handler=command_backfill_thread, ignore_live_state=True)

    cleanup = subparsers.add_parser("cleanup-topic")
    cleanup.add_argument("--chat-id", type=int, required=True)
    cleanup.add_argument("--topic-id", type=int, required=True)
    cleanup.add_argument("--bridge-state", type=Path, default=DEFAULT_BRIDGE_STATE_PATH)
    cleanup.add_argument("--scan-limit", type=int, default=DEFAULT_CLEANUP_SCAN_LIMIT)
    cleanup.add_argument("--prefix", action="append", default=None)
    cleanup.add_argument("--contains", action="append", default=None)
    cleanup.add_argument("--keep-message-id", action="append", type=int, default=None)
    cleanup.add_argument("--no-keep-live-state", dest="keep_live_state", action="store_false")
    cleanup.add_argument("--delete", action="store_true")
    cleanup.set_defaults(handler=command_cleanup_topic, keep_live_state=True)

    pin_message = subparsers.add_parser("pin-message")
    pin_message.add_argument("--chat-id", type=int, required=True)
    pin_message.add_argument("--message-id", type=int, required=True)
    pin_message.add_argument("--silent", action="store_true")
    pin_message.set_defaults(handler=command_pin_message)

    return parser


async def amain():
    parser = build_parser()
    args = parser.parse_args()
    await args.handler(args)


if __name__ == "__main__":
    asyncio.run(amain())
