"""FastAPI routers for helper/chore endpoints that aren't chat or runs.

Each builder returns an APIRouter configured with the dependencies it
needs (auth key, edge client). `main.py` calls the builders at startup
and `app.include_router`s the result.
"""

from routes.helpers import build_helpers_router


__all__ = ["build_helpers_router"]
