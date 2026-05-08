"""
Ooze Labs — backend for lab.ooze.run

Serves the static frontend at / and exposes proxy endpoints under /api/*
that talk to the Ooze RPC validator + faucet on the VPS. Adds a 24h
per-wallet rate limit on faucet drips and caps each drip at 666 SOL.
"""
from __future__ import annotations

import os
import socket
import time
from pathlib import Path
from typing import Any

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles

# ---------- config ----------

OOZE_RPC_URL = os.getenv("OOZE_RPC_URL", "http://77.42.80.65:8911")
OOZE_FAUCET_HOST = os.getenv("OOZE_FAUCET_HOST", "77.42.80.65")
OOZE_FAUCET_PORT = int(os.getenv("OOZE_FAUCET_PORT", "8912"))

FAUCET_PUBKEY = os.getenv("FAUCET_PUBKEY", "sPTUc7gfr9FBs36KbctKujfRNz5xWcyms2dKiRfrdLT")
MINT_PUBKEY = os.getenv("MINT_PUBKEY", "sPTUc7gfr9FBs36KbctKujfRNz5xWcyms2dKiRfrdLT")

DRIP_CAP_SOL = 666
RATE_LIMIT_WINDOW_SEC = 24 * 60 * 60

LAMPORTS_PER_SOL = 1_000_000_000

STATIC_DIR = Path(__file__).parent / "static"

# ---------- in-memory rate limit ----------
# wallet pubkey -> last drip unix timestamp.
# In-memory means restarts reset the limits. Fine for now; can swap to redis later.
_drip_log: dict[str, float] = {}


def _check_and_record_drip(wallet: str) -> tuple[bool, int]:
    """Return (allowed, seconds_until_next_allowed)."""
    now = time.time()
    last = _drip_log.get(wallet)
    if last is not None:
        elapsed = now - last
        if elapsed < RATE_LIMIT_WINDOW_SEC:
            return False, int(RATE_LIMIT_WINDOW_SEC - elapsed)
    _drip_log[wallet] = now
    return True, 0


# ---------- FastAPI app ----------

app = FastAPI(title="Ooze Labs API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


@app.get("/api/health")
async def health() -> dict[str, Any]:
    return {"ok": True, "rpc": OOZE_RPC_URL}


@app.get("/api/info")
async def info() -> dict[str, Any]:
    """Static-ish info about the Ooze RPC chain. Shown on the page."""
    return {
        "rpcUrl": OOZE_RPC_URL,
        "faucetPubkey": FAUCET_PUBKEY,
        "dripCapSol": DRIP_CAP_SOL,
        "rateLimitHours": RATE_LIMIT_WINDOW_SEC // 3600,
        "scheduler": "ooze",
        "tagline": "VRF-fair transaction ordering. Test SOL only.",
    }


async def _rpc_call(method: str, params: list[Any] | None = None) -> Any:
    """Forward a JSON-RPC call to the Ooze validator."""
    payload = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": method,
        "params": params or [],
    }
    async with httpx.AsyncClient(timeout=10.0) as client:
        try:
            resp = await client.post(OOZE_RPC_URL, json=payload)
            resp.raise_for_status()
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=502, detail=f"RPC unavailable: {exc}") from exc
    data = resp.json()
    if "error" in data:
        raise HTTPException(status_code=400, detail=data["error"])
    return data.get("result")


@app.get("/api/stats")
async def stats() -> dict[str, Any]:
    """Live stats for the page header. Cached client-side; we just relay fresh."""
    slot = await _rpc_call("getSlot")
    epoch_info = await _rpc_call("getEpochInfo")
    cluster_nodes = await _rpc_call("getClusterNodes")
    faucet_balance_resp = await _rpc_call("getBalance", [FAUCET_PUBKEY])
    faucet_lamports = (
        faucet_balance_resp["value"] if isinstance(faucet_balance_resp, dict) else faucet_balance_resp
    )
    return {
        "slot": slot,
        "transactionCount": epoch_info.get("transactionCount") if isinstance(epoch_info, dict) else None,
        "blockHeight": epoch_info.get("blockHeight") if isinstance(epoch_info, dict) else None,
        "epoch": epoch_info.get("epoch") if isinstance(epoch_info, dict) else None,
        "validatorCount": len(cluster_nodes) if isinstance(cluster_nodes, list) else 0,
        "validatorIdentity": (
            cluster_nodes[0]["pubkey"]
            if isinstance(cluster_nodes, list) and cluster_nodes
            else None
        ),
        "faucetBalanceSol": faucet_lamports / LAMPORTS_PER_SOL if faucet_lamports else 0,
    }


def _is_valid_pubkey(s: str) -> bool:
    """Crude check — Solana pubkeys are base58, 32-44 chars."""
    if not s or not isinstance(s, str):
        return False
    if not (32 <= len(s) <= 44):
        return False
    valid = set("123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz")
    return all(c in valid for c in s)


@app.post("/api/drip")
async def drip(request: Request) -> dict[str, Any]:
    """
    Send SOL from the faucet to the requested wallet.

    Body: {"wallet": "<pubkey>", "amount": <int sol>}
    """
    body = await request.json()
    wallet = (body.get("wallet") or "").strip()
    amount = body.get("amount", 1)

    if not _is_valid_pubkey(wallet):
        raise HTTPException(status_code=400, detail="Invalid wallet address.")

    try:
        amount = int(amount)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="Amount must be an integer.")

    if amount <= 0:
        raise HTTPException(status_code=400, detail="Amount must be > 0.")
    if amount > DRIP_CAP_SOL:
        raise HTTPException(status_code=400, detail=f"Amount must be <= {DRIP_CAP_SOL} SOL.")

    allowed, retry_in = _check_and_record_drip(wallet)
    if not allowed:
        hours = retry_in // 3600
        minutes = (retry_in % 3600) // 60
        raise HTTPException(
            status_code=429,
            detail=f"Already dripped this wallet. Retry in {hours}h {minutes}m.",
        )

    # Talk to the Solana faucet protocol directly. The faucet listens on TCP and
    # accepts a tiny binary request: 16-byte header + 32-byte recipient pubkey.
    # We use solana-py for proper request building.
    try:
        signature = await _faucet_drip(wallet, amount * LAMPORTS_PER_SOL)
    except Exception as exc:
        # Roll back the rate limit on faucet failure so the user can retry.
        _drip_log.pop(wallet, None)
        raise HTTPException(status_code=502, detail=f"Faucet error: {exc}") from exc

    return {
        "ok": True,
        "wallet": wallet,
        "amountSol": amount,
        "signature": signature,
    }


async def _faucet_drip(wallet: str, lamports: int) -> str:
    """
    Talk to solana-faucet TCP protocol.

    Wire format (request):
      - 1 byte: 0 = airdrop request
      - 8 bytes: lamports (little-endian u64)
      - 32 bytes: recipient pubkey
      - 4 bytes: ip-throttle (we send 0.0.0.0)

    Wire format (response):
      - 1 byte: 0 = ok, 1 = error
      - on ok: 64 bytes signature (returned base58)
      - on error: utf8 message
    """
    import asyncio
    import base58

    pubkey_bytes = base58.b58decode(wallet)
    if len(pubkey_bytes) != 32:
        raise ValueError("decoded pubkey not 32 bytes")

    request = bytearray()
    request.append(0)  # airdrop request type
    request += lamports.to_bytes(8, "little")
    request += pubkey_bytes
    request += b"\x00\x00\x00\x00"  # ip placeholder

    reader, writer = await asyncio.open_connection(OOZE_FAUCET_HOST, OOZE_FAUCET_PORT)
    try:
        writer.write(bytes(request))
        await writer.drain()

        status_byte = await reader.readexactly(1)
        if status_byte == b"\x00":
            sig_bytes = await reader.readexactly(64)
            return base58.b58encode(sig_bytes).decode()
        else:
            err = await reader.read(1024)
            raise RuntimeError(err.decode("utf-8", errors="replace"))
    finally:
        writer.close()
        try:
            await writer.wait_closed()
        except Exception:
            pass


# ---------- static frontend ----------

if STATIC_DIR.exists():
    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

    @app.get("/")
    async def index() -> Response:
        return Response(
            content=(STATIC_DIR / "index.html").read_text(encoding="utf-8"),
            media_type="text/html",
        )


# Run via:
#   uvicorn app:app --host 0.0.0.0 --port ${PORT:-8000}