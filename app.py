"""
Ooze Labs — backend for lab.ooze.run

Serves the static frontend at / and exposes proxy endpoints under /api/*
that talk to the Ooze RPC validator on the VPS. Adds a 24h per-wallet
rate limit on faucet drips and caps each drip at 666 SOL.

Drips are sent via the validator's `requestAirdrop` JSON-RPC method.
"""
from __future__ import annotations

import os
import time
from pathlib import Path
from typing import Any

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles

# ---------- config ----------

OOZE_RPC_URL = os.getenv("OOZE_RPC_URL", "http://77.42.74.189:8911")

FAUCET_PUBKEY = os.getenv("FAUCET_PUBKEY", "sPTUc7gfr9FBs36KbctKujfRNz5xWcyms2dKiRfrdLT")
MINT_PUBKEY = os.getenv("MINT_PUBKEY", "sPTUc7gfr9FBs36KbctKujfRNz5xWcyms2dKiRfrdLT")

DRIP_CAP_SOL = 666
RATE_LIMIT_WINDOW_SEC = 24 * 60 * 60

LAMPORTS_PER_SOL = 1_000_000_000

STATIC_DIR = Path(__file__).parent / "static"

# ---------- in-memory rate limit ----------
_drip_log: dict[str, float] = {}


def _check_and_record_drip(wallet: str) -> tuple[bool, int]:
    now = time.time()
    last = _drip_log.get(wallet)
    if last is not None:
        elapsed = now - last
        if elapsed < RATE_LIMIT_WINDOW_SEC:
            return False, int(RATE_LIMIT_WINDOW_SEC - elapsed)
    _drip_log[wallet] = now
    return True, 0


# ---------- FastAPI app ----------

app = FastAPI(title="Ooze Labs API", version="0.2.0")

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
    return {
        "rpcUrl": OOZE_RPC_URL,
        "faucetPubkey": FAUCET_PUBKEY,
        "dripCapSol": DRIP_CAP_SOL,
        "rateLimitHours": RATE_LIMIT_WINDOW_SEC // 3600,
        "scheduler": "ooze",
        "tagline": "VRF-fair transaction ordering. Test SOL only.",
    }


async def _rpc_call(method: str, params: list[Any] | None = None, timeout: float = 10.0) -> Any:
    """Forward a JSON-RPC call to the Ooze validator."""
    payload = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": method,
        "params": params or [],
    }
    async with httpx.AsyncClient(timeout=timeout) as client:
        try:
            resp = await client.post(OOZE_RPC_URL, json=payload)
            resp.raise_for_status()
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=502, detail=f"RPC unavailable: {exc}") from exc
    data = resp.json()
    if "error" in data:
        # rpc returned a structured JSON-RPC error
        err = data["error"]
        msg = err.get("message", str(err)) if isinstance(err, dict) else str(err)
        raise HTTPException(status_code=400, detail=msg)
    return data.get("result")


@app.get("/api/stats")
async def stats() -> dict[str, Any]:
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
    Send SOL to the requested wallet via the validator's requestAirdrop RPC.

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

    lamports = amount * LAMPORTS_PER_SOL
    try:
        signature = await _rpc_call("requestAirdrop", [wallet, lamports], timeout=15.0)
    except HTTPException:
        # Roll back rate limit so the user can retry on transient failure.
        _drip_log.pop(wallet, None)
        raise
    except Exception as exc:
        _drip_log.pop(wallet, None)
        raise HTTPException(status_code=502, detail=f"Airdrop failed: {exc}") from exc

    if not signature or not isinstance(signature, str):
        _drip_log.pop(wallet, None)
        raise HTTPException(status_code=502, detail="Airdrop returned no signature.")

    return {
        "ok": True,
        "wallet": wallet,
        "amountSol": amount,
        "signature": signature,
    }


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
