# Zigbee2MQTT with the ZRHP zigbee-herdsman fork (zigbee-rs NCP over USB-Serial-JTAG or UART).
#
#   docker build -t zigbee2mqtt-zrhp -f docker/zrhp-z2m/Dockerfile .
#   docker build -t zigbee2mqtt-zrhp --build-arg HERDSMAN_REF=<commit> --build-arg Z2M_REF=2.14.3 -f docker/zrhp-z2m/Dockerfile .
#
# Runs like the official image: data in /app/data, frontend on 8080, the NCP passed with --device.
# See docs/zrhp-z2m-testing.md.

FROM node:24-alpine AS build
RUN apk add --no-cache bash git make gcc g++ python3 linux-headers && corepack enable
ARG Z2M_REF=2.14.3
ARG HERDSMAN_REPO=https://github.com/faronov/zigbee-herdsman.git
ARG HERDSMAN_REF=zrhp
COPY scripts/zrhp/build-z2m.sh scripts/zrhp/probe.js /
RUN Z2M_REF="$Z2M_REF" HERDSMAN_REPO="$HERDSMAN_REPO" HERDSMAN_REF="$HERDSMAN_REF" bash /build-z2m.sh /app && \
    cd /app && \
    # musl: build the serial port binding for this image instead of using prebuilds
    rm -rf $(find ./node_modules/.pnpm/ -wholename "*/@serialport/bindings-cpp/prebuilds" -type d) && \
    CI=true corepack pnpm rebuild @serialport/bindings-cpp && \
    CI=true corepack pnpm prune --prod && \
    rm -rf .git

FROM node:24-alpine AS release
RUN apk add --no-cache tzdata eudev tini
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app /app
RUN mkdir -p /app/data
LABEL org.opencontainers.image.title="Zigbee2MQTT (ZRHP test build)"
LABEL org.opencontainers.image.source="https://github.com/faronov/zigbee-herdsman"
EXPOSE 8080
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "index.js"]
