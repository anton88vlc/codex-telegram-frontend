#!/usr/bin/env python3

import argparse
import asyncio
import inspect
import json
import os
import getpass
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

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


@dataclass
class EnvConfig:
    api_id: int
    api_hash: str


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

    return parser


async def amain():
    parser = build_parser()
    args = parser.parse_args()
    await args.handler(args)


if __name__ == "__main__":
    asyncio.run(amain())
