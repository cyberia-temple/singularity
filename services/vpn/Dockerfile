# Cyberia VPN node: the pass gate (node) and Xray in one container, because
# the gate is what starts, rewrites and restarts Xray.
FROM alpine:3.20 AS xray
ARG TARGETARCH
ARG XRAY_VERSION=25.3.6
# Pinned to the release's own SHA2-256 (Xray-linux-*.zip.dgst).
ARG XRAY_SHA256_AMD64=82d4be3a5ed8bd2621df9c9913c3a2761b86a42ae8485da836f7447ff2ec3d4d
ARG XRAY_SHA256_ARM64=1595f446b3d3a2bfe4a737e3cdb4c189c8c4e271322a7a2a0f5ea735b9511e80
RUN set -eu; \
    case "${TARGETARCH:-amd64}" in \
      amd64) asset=64; sum="$XRAY_SHA256_AMD64" ;; \
      arm64) asset=arm64-v8a; sum="$XRAY_SHA256_ARM64" ;; \
      *) echo "unsupported arch $TARGETARCH"; exit 1 ;; \
    esac; \
    wget -qO /tmp/xray.zip "https://github.com/XTLS/Xray-core/releases/download/v${XRAY_VERSION}/Xray-linux-${asset}.zip"; \
    echo "$sum  /tmp/xray.zip" | sha256sum -c -; \
    mkdir /xray && unzip -q /tmp/xray.zip xray geoip.dat geosite.dat -d /xray

FROM node:22-alpine
WORKDIR /app
COPY --from=xray /xray/xray /usr/local/bin/xray
COPY --from=xray /xray/geoip.dat /xray/geosite.dat /usr/local/share/xray/
ENV XRAY_LOCATION_ASSET=/usr/local/share/xray
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
RUN mkdir /data && chown node:node /data
VOLUME /data
EXPOSE 443/tcp 8780/tcp
ENTRYPOINT ["node", "/app/src/main.mjs"]
