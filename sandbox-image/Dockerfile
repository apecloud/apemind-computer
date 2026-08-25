ARG RECONSTRUCTED_BASE_IMAGE=apemind-computer-reconstructed:local
FROM ${RECONSTRUCTED_BASE_IMAGE}

ARG RECONSTRUCTED_BASE_IMAGE
ARG TREADSTONE_SANDBOX_VERSION=dev
ARG DSH_VERSION=latest

LABEL org.opencontainers.image.source="https://github.com/apecloud/apemind-computer"
LABEL org.opencontainers.image.description="ApeMind Computer sandbox"
LABEL org.opencontainers.image.version="${TREADSTONE_SANDBOX_VERSION}"
LABEL org.opencontainers.image.base.name="${RECONSTRUCTED_BASE_IMAGE}"

SHELL ["/bin/bash", "-o", "pipefail", "-c"]
ENV PATH="/root/.local/bin:${PATH}"

# Long-running agent runtime. Pin with --build-arg DSH_VERSION=x.y.z when needed.
RUN npm install -g "@deepseek-ai/dsh@${DSH_VERSION}" \
  && dsh --version

ENV TREADSTONE_SANDBOX_VERSION="${TREADSTONE_SANDBOX_VERSION}"

COPY run.sh /opt/gem/run.sh
COPY entrypoint.sh /opt/gem/entrypoint.sh
COPY supervisord.conf /opt/gem/supervisord.conf
COPY supervisord.nginx.conf /opt/gem/supervisord/nginx.conf
COPY tinyproxy.sh /opt/gem/tinyproxy.sh
COPY nginx.conf.template /opt/treadstone/templates/nginx.conf.template
COPY tinyproxy-base.conf /opt/gem/tinyproxy/base.conf

RUN set -euo pipefail \
    && if ! getent group gem >/dev/null; then groupadd --gid 1000 gem; fi \
    && if ! id -u gem >/dev/null 2>&1; then useradd --uid 1000 --gid 1000 --shell /bin/bash --create-home gem; fi \
    && install -d -m 755 -o gem -g gem \
         /opt/treadstone \
         /opt/treadstone/home-template \
         /var/log/nginx \
         /var/lib/nginx \
    && for home_dir in /home/gem /opt/treadstone/home-template; do \
         install -d -m 755 -o gem -g gem \
           "${home_dir}" \
           "${home_dir}/.npm-global/lib" \
           "${home_dir}/.config/matplotlib" \
           "${home_dir}/.config/browser/Default"; \
         cp -f /opt/gem/bashrc "${home_dir}/.bashrc"; \
         cp -f /opt/gem/matplotlibrc "${home_dir}/.config/matplotlib/matplotlibrc"; \
         cp -f /opt/gem/preferences.json "${home_dir}/.config/browser/Default/Preferences"; \
         touch "${home_dir}/.Xauthority"; \
       done \
    && chown -R gem:gem \
         /home/gem \
         /opt/treadstone \
         /opt/gem \
         /opt/aio \
         /etc/browser/policies/managed \
         /var/log/nginx \
         /var/lib/nginx \
    && touch /var/log/nginx/error.log \
    && chmod 755 /opt/gem/run.sh /opt/gem/entrypoint.sh /opt/gem/tinyproxy.sh

ENV USER=gem \
    USER_UID=1000 \
    USER_GID=1000 \
    HOME=/home/gem \
    PATH="/home/gem/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    LOG_DIR=/tmp/treadstone/log \
    XDG_RUNTIME_DIR=/tmp/runtime-gem

USER gem
