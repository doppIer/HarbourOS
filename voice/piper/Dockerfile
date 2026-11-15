# Piper text-to-speech (https://github.com/OHF-Voice/piper1-gpl), with a
# Turkish and an English voice baked in. HarborOS calls POST /synthesize.
FROM python:3.12-slim
RUN pip install --no-cache-dir "piper-tts[http]==1.8.0"
WORKDIR /voices
# More voices: https://huggingface.co/rhasspy/piper-voices (add names here).
RUN python -m piper.download_voices tr_TR-dfki-medium en_US-lessac-medium en_US-ryan-high
EXPOSE 5000
CMD ["python", "-m", "piper.http_server", "-m", "tr_TR-dfki-medium", "--data-dir", "/voices", "--host", "0.0.0.0", "--port", "5000"]
