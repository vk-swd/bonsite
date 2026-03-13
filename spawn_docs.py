#!/usr/bin/env python3

import os
import subprocess
import sys

env = os.environ.copy()
env["WORKDIR"] = "/WD"

result = subprocess.run(
    ["docker", "compose", "-f", "documentation.yaml", "build", "docsite"],
    env=env,
)

sys.exit(result.returncode)