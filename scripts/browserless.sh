#!/bin/bash

# run browser in docker
docker run -e "TIMEOUT=600000" -p 3000:3000 ghcr.io/browserless/chromium
