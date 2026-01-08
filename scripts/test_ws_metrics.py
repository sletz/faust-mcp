#!/usr/bin/env python3
"""Simple WebSocket metrics probe for the rt-ui analysis stream.

Connects to the /ws endpoint, sends a subscribe message, and waits for
at least one metrics frame. Useful for manual checks or CI smoke tests.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import socket
import ssl
import struct
import time
import urllib.parse

WS_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


def _make_accept(key: str) -> str:
    raw = (key + WS_MAGIC).encode("ascii")
    return base64.b64encode(hashlib.sha1(raw).digest()).decode("ascii")


def _encode_client_text_frame(message: str) -> bytes:
    payload = message.encode("utf-8")
    length = len(payload)
    header = bytearray()
    header.append(0x81)  # FIN + text frame
    if length < 126:
        header.append(0x80 | length)
    elif length < 65536:
        header.append(0x80 | 126)
        header.extend(struct.pack("!H", length))
    else:
        header.append(0x80 | 127)
        header.extend(struct.pack("!Q", length))
    mask = os.urandom(4)
    header.extend(mask)
    masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
    return bytes(header) + masked


def _decode_frames(buffer: bytes) -> tuple[list[tuple[int, bytes]], bytes]:
    frames: list[tuple[int, bytes]] = []
    offset = 0
    length = len(buffer)
    while offset + 2 <= length:
        byte1 = buffer[offset]
        byte2 = buffer[offset + 1]
        opcode = byte1 & 0x0F
        masked = (byte2 & 0x80) == 0x80
        payload_len = byte2 & 0x7F
        header_len = 2
        if payload_len == 126:
            if offset + 4 > length:
                break
            payload_len = struct.unpack("!H", buffer[offset + 2:offset + 4])[0]
            header_len = 4
        elif payload_len == 127:
            if offset + 10 > length:
                break
            payload_len = struct.unpack("!Q", buffer[offset + 2:offset + 10])[0]
            header_len = 10
        mask_len = 4 if masked else 0
        frame_len = header_len + mask_len + payload_len
        if offset + frame_len > length:
            break
        mask = b""
        if masked:
            mask = buffer[offset + header_len:offset + header_len + 4]
        start = offset + header_len + mask_len
        end = offset + frame_len
        payload = buffer[start:end]
        if masked and mask:
            payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        frames.append((opcode, payload))
        offset += frame_len
    return frames, buffer[offset:]


def _open_socket(url: urllib.parse.ParseResult, timeout: float) -> socket.socket:
    host = url.hostname or "127.0.0.1"
    port = url.port or (443 if url.scheme == "wss" else 80)
    sock = socket.create_connection((host, port), timeout=timeout)
    if url.scheme == "wss":
        context = ssl.create_default_context()
        sock = context.wrap_socket(sock, server_hostname=host)
    sock.settimeout(timeout)
    return sock


def _handshake(sock: socket.socket, url: urllib.parse.ParseResult) -> None:
    key = base64.b64encode(os.urandom(16)).decode("ascii")
    path = url.path or "/ws"
    if url.query:
        path = f"{path}?{url.query}"
    host = url.hostname or "127.0.0.1"
    port = url.port or (443 if url.scheme == "wss" else 80)
    lines = [
        f"GET {path} HTTP/1.1",
        f"Host: {host}:{port}",
        "Upgrade: websocket",
        "Connection: Upgrade",
        f"Sec-WebSocket-Key: {key}",
        "Sec-WebSocket-Version: 13",
        "\r\n",
    ]
    sock.sendall("\r\n".join(lines).encode("ascii"))
    response = b""
    while b"\r\n\r\n" not in response:
        chunk = sock.recv(4096)
        if not chunk:
            break
        response += chunk
    header_text = response.split(b"\r\n\r\n", 1)[0].decode("ascii", errors="ignore")
    if "101" not in header_text:
        raise RuntimeError(f"Handshake failed: {header_text}")
    accept = ""
    for line in header_text.split("\r\n"):
        if line.lower().startswith("sec-websocket-accept:"):
            accept = line.split(":", 1)[1].strip()
            break
    expected = _make_accept(key)
    if accept != expected:
        raise RuntimeError("Invalid Sec-WebSocket-Accept response")


def main() -> int:
    parser = argparse.ArgumentParser(description="Test WS metrics stream.")
    parser.add_argument("--url", default="ws://127.0.0.1:8787/ws", help="WebSocket URL.")
    parser.add_argument("--timeout", type=float, default=5.0, help="Seconds to wait for metrics.")
    parser.add_argument("--include-scope", action="store_true", help="Request scope samples.")
    parser.add_argument("--include-spectrum", action="store_true", help="Request spectrum bins.")
    parser.add_argument("--per-channel", action="store_true", help="Request per-channel data.")
    parser.add_argument("--probe-id", type=int, default=None, help="Probe id to filter.")
    args = parser.parse_args()

    url = urllib.parse.urlparse(args.url)
    sock = _open_socket(url, args.timeout)
    try:
        _handshake(sock, url)
        subscribe = {
            "type": "subscribe",
            "include_scope": bool(args.include_scope),
            "include_spectrum": bool(args.include_spectrum),
            "per_channel": bool(args.per_channel),
            "scope_fps": 4,
            "spectrum_fps": 2,
            "probe_fps": 2,
            "probe_id": args.probe_id,
        }
        sock.sendall(_encode_client_text_frame(json.dumps(subscribe)))
        deadline = time.time() + args.timeout
        buffer = b""
        while time.time() < deadline:
            chunk = sock.recv(4096)
            if not chunk:
                break
            buffer += chunk
            frames, buffer = _decode_frames(buffer)
            for opcode, payload in frames:
                if opcode == 0x1:
                    data = json.loads(payload.decode("utf-8"))
                    if data.get("type") == "metrics":
                        keys = ", ".join(sorted((data.get("payload") or {}).keys()))
                        print(f"Received metrics frame ({keys})")
                        return 0
                    if data.get("type") == "error":
                        print(f"Server error: {data.get('error')}")
                        return 1
        print("Timeout waiting for metrics frame")
        return 1
    finally:
        try:
            sock.close()
        except OSError:
            pass


if __name__ == "__main__":
    raise SystemExit(main())
