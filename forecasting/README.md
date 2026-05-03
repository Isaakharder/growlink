# GrowLink Forecasting Service

FastAPI shell service for future forecasting features.

## Local run

```bash
pip install -r requirements.txt
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

## Current routes

- `GET /health`
- `GET /forecasting/health`
- `GET /forecasting/status`

No forecasting calculations are implemented yet.
