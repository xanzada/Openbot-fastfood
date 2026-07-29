FROM alpine:3.21

RUN apk add --no-cache \
    age \
    bash \
    ca-certificates \
    coreutils \
    git \
    openssh-client \
    redis \
    tar \
    zstd

COPY backup/backup.sh /usr/local/bin/backup
COPY backup/healthcheck.sh /usr/local/bin/backup-healthcheck

RUN chmod 0755 /usr/local/bin/backup /usr/local/bin/backup-healthcheck \
    && addgroup -S backup \
    && adduser -S -G backup -h /work backup \
    && mkdir -p /source /work \
    && chown -R backup:backup /work

USER backup
WORKDIR /work

ENTRYPOINT ["/usr/local/bin/backup"]
