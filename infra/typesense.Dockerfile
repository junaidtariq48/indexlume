FROM typesense/typesense:30.2

LABEL org.opencontainers.image.licenses="GPL-3.0"

RUN apt-get update \
  && apt-get upgrade --yes \
  && mkdir -p /usr/share/doc/typesense \
  && cp /usr/share/common-licenses/GPL-3 /usr/share/doc/typesense/COPYING \
  && rm -rf /var/lib/apt/lists/*
