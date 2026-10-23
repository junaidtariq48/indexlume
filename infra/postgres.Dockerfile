FROM golang:1.26.10-bookworm AS gosu-build

RUN git clone --depth 1 --branch 1.19 https://github.com/tianon/gosu.git /src/gosu \
  && cd /src/gosu \
  && CGO_ENABLED=0 go build -trimpath -o /go/bin/gosu .

FROM postgres:17.11-bookworm

LABEL org.opencontainers.image.licenses="PostgreSQL AND Apache-2.0"

COPY --from=gosu-build /go/bin/gosu /usr/local/bin/gosu
COPY --from=gosu-build /src/gosu/LICENSE /usr/share/doc/gosu/copyright

RUN apt-get update \
  && apt-get upgrade --yes \
  && rm -rf /var/lib/apt/lists/*
