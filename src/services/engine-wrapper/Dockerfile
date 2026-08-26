FROM python:3.14-slim

WORKDIR /srv/engine-wrapper
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app

# Run as a non-root user (audit I-1 P2).
RUN useradd --create-home --uid 10001 appuser
USER appuser

EXPOSE 3003
# Bind to loopback (audit B-1 P0): the valuation service reaches it over the
# host loopback / internal network; the port is never world-reachable. Override
# HOST at deploy time only if fronting it with an authenticated proxy.
ENV HOST=127.0.0.1 PORT=3003
# See the Node images for why this is here: a running container is not a serving
# one, and without a HEALTHCHECK the image reports healthy from the moment
# uvicorn forks. docker-compose.yml keeps its own per-service healthcheck; this
# is the floor for every other way the image is started.
#
# `python -m app.healthcheck` rather than an inline one-liner — see that module
# for the two ways the obvious one-liner is wrong while looking correct.
HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=5 \
  CMD python -m app.healthcheck

CMD ["sh", "-c", "uvicorn app.main:app --host \"$HOST\" --port \"$PORT\" --timeout-graceful-shutdown 15"]
