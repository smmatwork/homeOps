FROM python:3.12-slim

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8011

COPY requirements.txt ./requirements.txt
RUN python -m pip install --no-cache-dir -r requirements.txt

# Copy all application code. Keep this list explicit — missing a file here
# crashes the container on import at startup.
COPY main.py ./main.py
COPY intent_registry.py ./intent_registry.py
COPY channel_dispatcher.py ./channel_dispatcher.py
COPY channel_adapters/ ./channel_adapters/
COPY orchestrator/ ./orchestrator/
COPY agents/ ./agents/
COPY kernel/ ./kernel/
COPY routes/ ./routes/
COPY runs/ ./runs/

EXPOSE 8011

# Honor $PORT so this works on Render (which sets PORT dynamically) and
# locally (defaults to 8011). sh -c is required so ${PORT} expands.
CMD ["sh", "-c", "python -m uvicorn main:app --host 0.0.0.0 --port ${PORT:-8011}"]
