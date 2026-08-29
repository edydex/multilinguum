FROM pytorch/pytorch:2.7.1-cuda12.8-cudnn9-runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt requirements-gpu.txt ./
RUN python -m pip install -r requirements.txt -r requirements-gpu.txt
COPY app ./app

RUN useradd --system --uid 10001 --create-home multilinguum \
    && mkdir -p /var/lib/multilinguum/voices \
    && chown -R multilinguum:multilinguum /var/lib/multilinguum
USER multilinguum

EXPOSE 4320
CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "4320"]
