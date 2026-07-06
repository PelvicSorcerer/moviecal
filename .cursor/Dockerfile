# Cursor Cloud Agent base image: Node 24 matches CI (verify.yml), .nvmrc, and package.json engines.
# Do not COPY the project — Cursor clones the repo into the workspace at runtime.
FROM node:24-bookworm

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    git \
    jq \
    sudo \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
