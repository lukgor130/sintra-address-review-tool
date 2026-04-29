#!/usr/bin/env python3

import argparse
import json
import os
import posixpath
import re
import uuid
import urllib.parse
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


RANGE_RE = re.compile(r"bytes=(\d*)-(\d*)$")
DEFAULT_SESSION_SLUG = "default"


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def random_id() -> str:
    return uuid.uuid4().hex


def json_response(handler, payload, status=HTTPStatus.OK):
    body = json.dumps(payload, indent=2).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Cache-Control", "no-store")
    handler.end_headers()
    handler.wfile.write(body)


def normalize_feedback(payload, parcel_id):
    safe_parcel_id = int(parcel_id)
    return {
        "sourceObjectId": int(payload.get("sourceObjectId", safe_parcel_id)),
        "parcelObjectId": int(payload.get("parcelObjectId", safe_parcel_id)),
        "knowledgeStatus": str(payload.get("knowledgeStatus", "")),
        "leadName": str(payload.get("leadName", "")),
        "contactTrail": str(payload.get("contactTrail", "")),
        "confidence": str(payload.get("confidence", "")),
        "notes": str(payload.get("notes", "")),
        "reviewedAt": payload.get("reviewedAt") or None,
        "updatedAt": payload.get("updatedAt") or now_iso(),
    }


def serialize_session(session):
    return {
        "id": session["id"],
        "packId": session["pack_id"],
        "slug": session["slug"],
        "title": session.get("title"),
        "isDefault": bool(session.get("is_default")),
        "createdAt": session["created_at"],
        "updatedAt": session["updated_at"],
    }


def serialize_feedback_rows(session):
    return {
        str(parcel_id): {**payload, "updatedAt": payload.get("updatedAt") or session["updated_at"]}
        for parcel_id, payload in session["parcels"].items()
    }


def ensure_default_session(store, pack_id, title):
    key = (pack_id, DEFAULT_SESSION_SLUG)
    session_id = store["default_sessions"].get(key)
    if session_id and session_id in store["sessions"]:
        return store["sessions"][session_id]
    now = now_iso()
    session = {
        "id": random_id(),
        "pack_id": pack_id,
        "slug": DEFAULT_SESSION_SLUG,
        "title": f"{title} shared notes",
        "is_default": 1,
        "created_at": now,
        "updated_at": now,
        "parcels": {},
    }
    store["sessions"][session["id"]] = session
    store["default_sessions"][key] = session["id"]
    return session


def ensure_session_by_id(store, pack_id, session_id, title):
    session = store["sessions"].get(session_id)
    if session:
        if session["pack_id"] != pack_id:
            raise ValueError("session-pack-mismatch")
        return session
    now = now_iso()
    session = {
        "id": session_id,
        "pack_id": pack_id,
        "slug": session_id,
        "title": title or "AOI session",
        "is_default": 0,
        "created_at": now,
        "updated_at": now,
        "parcels": {},
    }
    store["sessions"][session_id] = session
    return session


def clone_session(store, source_session_id, target_session_id):
    source = store["sessions"].get(source_session_id)
    target = store["sessions"].get(target_session_id)
    if not source or not target or source["pack_id"] != target["pack_id"]:
        return {}
    target["parcels"] = {
        parcel_id: dict(payload) for parcel_id, payload in source["parcels"].items()
    }
    target["updated_at"] = now_iso()
    return serialize_feedback_rows(target)


class RangeRequestHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, directory=None, **kwargs):
        self.range = None
        super().__init__(*args, directory=directory, **kwargs)

    def do_GET(self):
        if self.path.startswith("/api/aoi"):
            self.handle_aoi_api()
            return
        super().do_GET()

    def do_POST(self):
        if self.path.startswith("/api/aoi"):
            self.handle_aoi_api()
            return
        self.send_error(HTTPStatus.METHOD_NOT_ALLOWED, "Unsupported method")

    def send_head(self):
        path = self.translate_path(self.path)
        if os.path.isdir(path):
            return super().send_head()

        ctype = self.guess_type(path)
        try:
            file_handle = open(path, "rb")
        except OSError:
            self.send_error(HTTPStatus.NOT_FOUND, "File not found")
            return None

        size = os.fstat(file_handle.fileno()).st_size
        self.range = None
        range_header = self.headers.get("Range")
        if range_header:
            match = RANGE_RE.match(range_header.strip())
            if match:
                start_text, end_text = match.groups()
                start = int(start_text) if start_text else 0
                end = int(end_text) if end_text else size - 1
                end = min(end, size - 1)
                if start <= end:
                    self.range = (start, end)
                    self.send_response(HTTPStatus.PARTIAL_CONTENT)
                    self.send_header("Content-type", ctype)
                    self.send_header("Accept-Ranges", "bytes")
                    self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
                    self.send_header("Content-Length", str(end - start + 1))
                    self.send_header("Last-Modified", self.date_time_string(os.path.getmtime(path)))
                    self.end_headers()
                    return file_handle

        self.send_response(HTTPStatus.OK)
        self.send_header("Content-type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(size))
        self.send_header("Last-Modified", self.date_time_string(os.path.getmtime(path)))
        self.end_headers()
        return file_handle

    def copyfile(self, source, outputfile):
        if not self.range:
            return super().copyfile(source, outputfile)

        start, end = self.range
        source.seek(start)
        remaining = end - start + 1
        while remaining > 0:
            chunk = source.read(min(64 * 1024, remaining))
            if not chunk:
                break
            outputfile.write(chunk)
            remaining -= len(chunk)

    def translate_path(self, path):
        path = path.split("?", 1)[0].split("#", 1)[0]
        trailing_slash = path.rstrip().endswith("/")
        path = urllib.parse.unquote(path)
        path = posixpath.normpath(path)
        parts = [part for part in path.split("/") if part and part not in {".", ".."}]
        resolved = Path(self.directory)
        for part in parts:
            resolved /= part
        if trailing_slash:
            return str(resolved) + "/"
        return str(resolved)

    def handle_aoi_api(self):
        parsed = urllib.parse.urlparse(self.path)
        query = urllib.parse.parse_qs(parsed.query)
        action = query.get("action", ["bootstrap"])[0]
        pack_id = query.get("packId", [""])[0].strip()
        if not pack_id:
            json_response(self, {"ok": False, "error": "Missing packId."}, HTTPStatus.BAD_REQUEST)
            return

        store = self.server.aoi_store
        title = query.get("title", ["AOI"])[0]
        length = int(self.headers.get("Content-Length") or 0)
        body = {}
        if length:
            try:
                body = json.loads(self.rfile.read(length).decode("utf-8"))
            except json.JSONDecodeError:
                body = {}

        try:
            if action == "bootstrap" and self.command == "POST":
                requested_session_id = str(body.get("sessionId") or "").strip()
                session = (
                    ensure_session_by_id(store, pack_id, requested_session_id, title)
                    if requested_session_id
                    else ensure_default_session(store, pack_id, title)
                )
                json_response(
                    self,
                    {
                        "ok": True,
                        "session": serialize_session(session),
                        "feedback": serialize_feedback_rows(session),
                    },
                )
                return

            if action == "create-session" and self.command == "POST":
                session_id = random_id()
                now = now_iso()
                session = {
                    "id": session_id,
                    "pack_id": pack_id,
                    "slug": session_id,
                    "title": str(body.get("title") or f"{title} session").strip(),
                    "is_default": 0,
                    "created_at": now,
                    "updated_at": now,
                    "parcels": {},
                }
                store["sessions"][session_id] = session
                clone_from = str(body.get("cloneFromSessionId") or "").strip()
                feedback = clone_session(store, clone_from, session_id) if clone_from else {}
                json_response(
                    self,
                    {
                        "ok": True,
                        "session": serialize_session(session),
                        "feedback": feedback,
                    },
                )
                return

            if action == "upsert" and self.command == "POST":
                session_id = str(body.get("sessionId") or "").strip()
                rows = body.get("rows") if isinstance(body.get("rows"), list) else []
                session = store["sessions"].get(session_id)
                if not session:
                    json_response(self, {"ok": False, "error": "Unknown session."}, HTTPStatus.NOT_FOUND)
                    return
                if session["pack_id"] != pack_id:
                    json_response(
                        self,
                        {"ok": False, "error": "Session does not belong to this AOI pack."},
                        HTTPStatus.CONFLICT,
                    )
                    return

                synced_at = now_iso()
                for row in rows:
                    parcel_id = int(row.get("parcelId"))
                    session["parcels"][str(parcel_id)] = {
                        **normalize_feedback(row.get("feedback") or {}, parcel_id),
                        "updatedAt": synced_at,
                    }
                session["updated_at"] = synced_at
                json_response(
                    self,
                    {
                        "ok": True,
                        "session": serialize_session(session),
                        "feedback": {"syncedAt": synced_at, "parcels": serialize_feedback_rows(session)},
                    },
                )
                return

            json_response(self, {"ok": False, "error": "Unsupported action."}, HTTPStatus.NOT_FOUND)
        except ValueError as error:
            if str(error) == "session-pack-mismatch":
                json_response(
                    self,
                    {"ok": False, "error": "Session does not belong to this AOI pack."},
                    HTTPStatus.CONFLICT,
                )
                return
            raise


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Serve the workspace with byte-range support.")
    parser.add_argument("--port", type=int, default=8011, help="Port to bind.")
    parser.add_argument(
        "--dir",
        default=".",
        help="Directory to serve. Defaults to the repository root.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    directory = str(Path(args.dir).resolve())
    handler = lambda *handler_args, **handler_kwargs: RangeRequestHandler(
        *handler_args, directory=directory, **handler_kwargs
    )
    server = ThreadingHTTPServer(("0.0.0.0", args.port), handler)
    server.aoi_store = {"sessions": {}, "default_sessions": {}}
    print(f"Serving {directory} on http://127.0.0.1:{args.port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
