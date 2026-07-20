FROM python:3.14-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app app
# Run as a non-root user (audit I-1 P2).
RUN useradd --create-home --uid 10001 appuser
USER appuser
EXPOSE 3002
# Bind to loopback (audit B-1 P0): the valuation service reaches it over the
# host loopback / internal network; the port is never world-reachable. Override
# HOST at deploy time only if fronting it with an authenticated proxy.
ENV HOST=127.0.0.1 PORT=3002
CMD ["sh", "-c", "uvicorn app.main:app --host \"$HOST\" --port \"$PORT\""]
