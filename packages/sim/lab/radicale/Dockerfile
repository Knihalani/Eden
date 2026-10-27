# Radicale, a small open-source CalDAV server, as the calendar backend. No auth: it only listens on the lab network.
FROM mirror.gcr.io/library/python:3.12-slim
ARG HTTPS_PROXY
COPY ca.crt /ca.crt
RUN HTTPS_PROXY=$HTTPS_PROXY PIP_CERT=/ca.crt pip install --no-cache-dir radicale==3.5.4
ENTRYPOINT ["python", "-m", "radicale", "--server-hosts", "0.0.0.0:5232", "--auth-type", "none", \
  "--storage-filesystem-folder", "/collections", "--rights-type", "owner_only"]
