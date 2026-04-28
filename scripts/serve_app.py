#!/usr/bin/env python3

import argparse
import os
import posixpath
import re
import urllib.parse
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


RANGE_RE = re.compile(r"bytes=(\d*)-(\d*)$")


class RangeRequestHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, directory=None, **kwargs):
        self.range = None
        super().__init__(*args, directory=directory, **kwargs)

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


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Serve the app with byte-range support.")
    parser.add_argument("--port", type=int, default=8011, help="Port to bind.")
    parser.add_argument(
        "--dir",
        default="app",
        help="Directory to serve. Defaults to ./app",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    directory = str(Path(args.dir).resolve())
    handler = lambda *handler_args, **handler_kwargs: RangeRequestHandler(
        *handler_args, directory=directory, **handler_kwargs
    )
    server = ThreadingHTTPServer(("0.0.0.0", args.port), handler)
    print(f"Serving {directory} on http://127.0.0.1:{args.port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
