#!/usr/bin/env python3
"""
Modular deployment script.

Assembles a docker compose command from pre-defined service bundles
(files under ./bundles/) according to three deployment flags.

Bundles
-------
  Fnet   – networks (backend_net, edge_net) and shared volumes
  Bcore  – backend core: gql, generator, kafka, db stack, monitoring
  Btun   – backend tunnel client (connects Bcore to a remote frontend)
  Fcore  – frontend core: builder + nginx
  Fauth  – frontend auth: auth server + redis
  Ftun   – frontend tunnel server (SSH reverse-tunnel entry point)

Flags → resolved scenario
--------------------------
  (none)              Single host, with auth    → Fnet + Bcore + Fcore + Fauth
  --no-auth           Single host, no auth      → Fnet + Bcore + Fcore
  --split-f           Frontend host, with auth  → Fnet + Fcore + Fauth + Ftun
  --split-f --no-auth Frontend host, no auth    → Fnet + Fcore + Ftun
  --split-b           Backend host              → Fnet + Bcore + Btun
                      (--no-auth is ignored with --split-b)

Usage
-----
  python deploy.py [--split-f] [--split-b] [--no-auth]
                   [--dry-run] [-p NAME]
                   [-- DOCKER_COMPOSE_ARGS ...]

Examples
--------
  python deploy.py up -d
  python deploy.py --no-auth up -d
  python deploy.py --split-f up -d --build
  python deploy.py --split-f --no-auth up -d
  python deploy.py --split-b up -d
  python deploy.py --dry-run --split-f up -d
  python deploy.py -p myproject up -d

Network name overrides (via environment variables)
--------------------------------------------------
  Set BACKEND_NET / EDGE_NET to avoid network name collisions when running
  multiple stacks on the same host:

    BACKEND_NET=proj1_backend EDGE_NET=proj1_edge python deploy.py up -d
"""

import argparse
import os
import subprocess
import sys
from typing import List, Optional, Tuple

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
BUNDLES_DIR = os.path.join(SCRIPT_DIR, "bundles")


def _b(name: str) -> str:
    """Return the absolute path to a bundle file."""
    return os.path.join(BUNDLES_DIR, name)


FNET  = _b("Fnet.yaml")
BCORE = _b("Bcore.yaml")
BTUN  = _b("Btun.yaml")
FCORE = _b("Fcore.yaml")
FAUTH = _b("Fauth.yaml")
FTUN  = _b("Ftun.yaml")
DOCS  = _b("docs.yaml")

# Overlay files that add the correct nginx_server depends_on per scenario.
LINK_NGINX_GQL    = _b("link_nginx_to_gql.yaml")    # single-host: wait for gql
LINK_NGINX_TUNNEL = _b("link_nginx_to_tunnel.yaml")  # split-front: wait for tunnel

# ---------------------------------------------------------------------------
# Bundle resolution
# ---------------------------------------------------------------------------

def _resolve_bundles(
    split_front: bool,
    split_back: bool,
    no_auth: bool,
) -> Tuple[str, bool, List[str]]:
    """Return (scenario_label, split_hosted, ordered_bundle_files).

    split_back takes precedence over split_front when both are set.
    no_auth is silently ignored when split_back is True.
    """
    if split_back:
        return ("split-back", True, [FNET, BCORE, BTUN])

    if split_front:
        files = [FNET, FCORE]
        if not no_auth:
            files.append(FAUTH)
        files += [FTUN, LINK_NGINX_TUNNEL]
        label = "split-front-noauth" if no_auth else "split-front-auth"
        return (label, True, files)

    # Single host (default)
    files = [FNET, BCORE, FCORE]
    if not no_auth:
        files.append(FAUTH)
    files.append(LINK_NGINX_GQL)
    label = "single-noauth" if no_auth else "single-auth"
    return (label, False, files)

# Env files loaded in order (skipped silently when absent).
def get_user_env_file() -> Optional[str]:
    """Return the user env file path from BONSITE_USER_ENV, or None if not set."""
    env_file = os.environ.get("BONSITE_USER_ENV")
    if env_file == None:
        print("BONSITE_USER_ENV not set, skipping user env file.")
        exit(1)
    if not os.path.exists(os.path.join(SCRIPT_DIR, env_file)):
        print(f"BONSITE_USER_ENV file '{env_file}' does not exist.")
        exit(1)
    return os.path.join(SCRIPT_DIR, env_file)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="deploy.py",
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
        add_help=True,
    )
    parser.add_argument(
        "--split-f",
        action="store_true",
        default=False,
        dest="split_front",
        help="Deploy the frontend side of a split-host setup.",
    )
    parser.add_argument(
        "--split-b",
        action="store_true",
        default=False,
        dest="split_back",
        help="Deploy the backend side of a split-host setup.",
    )
    parser.add_argument(
        "--no-auth",
        action="store_true",
        default=False,
        dest="no_auth",
        help="Omit the Fauth bundle (auth server + Redis). Ignored with --split-b.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        default=False,
        help="Print the assembled docker compose command without executing it.",
    )
    parser.add_argument(
        "-p", "--project-name",
        metavar="NAME",
        default=None,
        help="Docker Compose project name (passed as -p to docker compose).",
    )
    parser.add_argument(
        "docker_args",
        nargs=argparse.REMAINDER,
        help=(
            "Arguments forwarded verbatim to docker compose "
            "(e.g. up -d, down, logs -f nginx_server). "
            "Separate from script flags with '--' if needed."
        ),
    )
    return parser


# ---------------------------------------------------------------------------
# Docker Compose command detection
# ---------------------------------------------------------------------------

def _detect_compose() -> List[str]:
    """Return the docker compose invocation, e.g. ['docker', 'compose'].

    Tries the modern plugin first ('docker compose'), then falls back to the
    legacy standalone binary ('docker-compose').  Exits with a clear message
    if neither is found so the user is not left guessing.
    """
    for candidate in (["docker", "compose"], ["docker-compose"]):
        try:
            r = subprocess.run(
                candidate + ["version"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            if r.returncode == 0:
                return candidate
        except FileNotFoundError:
            continue

    print(
        "ERROR: Neither 'docker compose' nor 'docker-compose' was found on PATH.\n"
        "Please install Docker: https://docs.docker.com/get-docker/",
        file=sys.stderr,
    )
    sys.exit(1)


# ---------------------------------------------------------------------------
# Command assembly
# ---------------------------------------------------------------------------

def _assemble_command(
    files: List[str],
    project_name: Optional[str],
    docker_args: List[str],
) -> List[str]:
    """Build the full `docker compose` invocation."""
    cmd: List[str] = _detect_compose()

    if project_name:
        cmd.extend(["-p", project_name])

    ENV_FILES = [
        get_user_env_file(),
        os.path.join(SCRIPT_DIR, "env"),
    ]
    for env_file in ENV_FILES:
        if os.path.exists(env_file):
            cmd.extend(["--env-file", env_file])

    for f in files:
        cmd.extend(["-f", f])

    # Strip leading '--' separator that users may add for clarity.
    if docker_args and docker_args[0] == "--":
        docker_args = docker_args[1:]

    cmd.extend(docker_args)
    return cmd


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> None:
    parser = _build_parser()
    args = parser.parse_args()

    label, split_hosted, files = _resolve_bundles(
        split_front=args.split_front,
        split_back=args.split_back,
        no_auth=args.no_auth,
    )

    # Sanity-check that every bundle file exists before invoking docker.
    missing = [f for f in files if not os.path.exists(f)]
    if missing:
        lines = "\n".join(f"  {f}" for f in missing)
        print(f"ERROR: Missing bundle files:\n{lines}", file=sys.stderr)
        sys.exit(1)
    
    docker_args = args.docker_args
    if docker_args and docker_args[0] == "--":
        docker_args = docker_args[1:]

    if args.no_auth:
        os.environ["NGINX_CONF_FILE"] = "./no_login.conf"

    if args.split_front:
        os.environ["BACKEND_NET"] = "backend_net_for_frontend"
        os.environ["EDGE_NET"] = "edge_net_for_frontend"

    cmd = _assemble_command(files, args.project_name, docker_args)

    # Build environment: propagate SPLIT_HOSTED for split scenarios.
    env = os.environ.copy()
    if split_hosted:
        env["SPLIT_HOSTED"] = "true"
    else:
        env.pop("SPLIT_HOSTED", None)

    # Summary
    bundle_names = [os.path.basename(f) for f in files]
    print(f"  Scenario     : {label}")
    print(f"  Bundles      : {' + '.join(bundle_names)}")
    print(f"  SPLIT_HOSTED : {'true' if split_hosted else 'false'}")
    print(f"  Command      : {' '.join(cmd)}")
    print()

    if args.dry_run:
        print("[dry-run] Command not executed.")
        return

    result = subprocess.run(cmd, cwd=SCRIPT_DIR, env=env)
    sys.exit(result.returncode)


if __name__ == "__main__":
    main()
