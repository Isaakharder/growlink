import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="GrowLink Forecasting Service", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def root_health() -> dict[str, str]:
    return {"status": "ok", "service": "growlink-forecasting"}


@app.get("/forecasting/health")
def forecasting_health() -> dict[str, str]:
    return {"status": "ok", "scope": "forecasting"}


@app.get("/forecasting/status")
def forecasting_status() -> dict[str, str]:
    return {
        "status": "ready",
        "message": "Forecasting service is ready"
    }


if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("PORT", "8000"))
    uvicorn.run(app, host="0.0.0.0", port=port)
