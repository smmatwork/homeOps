FROM python:3.12-slim

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

COPY requirements.txt ./requirements.txt
RUN python -m pip install --no-cache-dir -r requirements.txt

# Copy all application code (main + channel dispatcher + adapters)
COPY main.py ./main.py
COPY channel_dispatcher.py ./channel_dispatcher.py
COPY channel_adapters/ ./channel_adapters/

EXPOSE 8011

CMD ["python", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8011"]
