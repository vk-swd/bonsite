#!/bin/sh



docker compose --env-file "$BONSITE_USER_ENV" --env-file .env $@