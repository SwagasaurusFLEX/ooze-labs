# ooze-labs

Public landing page + faucet proxy for the Ooze fair-ordering Solana RPC.

Lives at <https://lab.ooze.run>.

## What it is

A FastAPI app that:

- Serves the static frontend at `/` (terminal-aesthetic landing page with copy-RPC + drip-faucet)
- Proxies JSON-RPC and faucet requests to the Ooze validator running on the VPS
- Adds a 24h per-wallet rate limit and a 666 SOL cap on the faucet
- Adds CORS + HTTPS in front of the bare HTTP RPC

## Run locally

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app:app --reload
```

Visit <http://localhost:8000>.

## Environment variables

| var               | default                                              |
| ----------------- | ---------------------------------------------------- |
| `OOZE_RPC_URL`    | `http://drip.ooze.run:8911`                            |
| `OOZE_FAUCET_HOST`| `77.42.80.65`                                        |
| `OOZE_FAUCET_PORT`| `8912`                                               |
| `FAUCET_PUBKEY`   | `sPTUc7gfr9FBs36KbctKujfRNz5xWcyms2dKiRfrdLT`        |
| `MINT_PUBKEY`     | `sPTUc7gfr9FBs36KbctKujfRNz5xWcyms2dKiRfrdLT`        |
| `PORT`            | `8000`                                               |

## Deploy on Railway

This repo is auto-deployed by Railway from the `main` branch. Railway provides
`PORT`. The Procfile + `railway.json` cover the start command.

After first deploy, set the custom domain to `lab.ooze.run`.
