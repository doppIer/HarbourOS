# Piper text-to-speech (https://github.com/OHF-Voice/piper1-gpl), the backup
# voice when Kokoro is down. HarborOS calls POST /synthesize.
FROM python:3.12-slim
RUN pip install --no-cache-dir "piper-tts[http]==1.8.0"
WORKDIR /voices
# More voices: https://huggingface.co/rhasspy/piper-voices (add names here).
RUN python -m piper.download_voices en_US-ryan-high en_US-lessac-medium
EXPOSE 5000
CMD ["python", "-m", "piper.http_server", "-m", "en_US-ryan-high", "--data-dir", "/voices", "--host", "0.0.0.0", "--port", "5000"]
