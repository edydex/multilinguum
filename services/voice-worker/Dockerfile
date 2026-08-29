FROM pytorch/pytorch:2.7.1-cuda12.8-cudnn9-runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg gosu libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt requirements-gpu.txt ./
RUN python -m pip install -r requirements.txt -r requirements-gpu.txt \
    && python -m pip install --no-deps https://github.com/resemble-ai/chatterbox/archive/5de7a54aa4e5e2baadb0182dde554908b48b85c2.tar.gz \
    && python -c "import torch, torchaudio; from chatterbox.mtl_tts import ChatterboxMultilingualTTS; assert torch.__version__.startswith('2.7.1'), torch.__version__; assert torchaudio.__version__.startswith('2.7.1'), torchaudio.__version__; assert 'v3' in __import__('chatterbox.mtl_tts', fromlist=['MULTILINGUAL_T3_MODELS']).MULTILINGUAL_T3_MODELS"
COPY app ./app
COPY entrypoint.sh /usr/local/bin/multilinguum-voice-entrypoint

RUN useradd --system --uid 10001 --create-home multilinguum \
    && mkdir -p /home/multilinguum/.cache /var/lib/multilinguum/voices \
    && chown -R multilinguum:multilinguum \
        /home/multilinguum/.cache \
        /opt/conda/lib/python3.11/site-packages/librosa \
        /var/lib/multilinguum \
    && chmod 0555 /usr/local/bin/multilinguum-voice-entrypoint

EXPOSE 4320
ENTRYPOINT ["/usr/local/bin/multilinguum-voice-entrypoint"]
CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "4320"]
