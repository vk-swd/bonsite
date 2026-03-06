#!/bin/sh



# SPLIT_HOSTED=true docker compose --env-file gitignored/someenv --env-file .env $@
docker compose --env-file gitignored/someenv --env-file .env $@