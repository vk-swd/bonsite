#!/bin/bash

tsc && node --trace-warnings build/main.js >> "$LOG_MOUNT"/generator.log 2>&1