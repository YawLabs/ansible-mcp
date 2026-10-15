#!/bin/sh
d="${ANSIBLE_MCP_MARK_DIR:-/tmp/ansible-mcp-marks}"; mkdir -p "$d"; touch "$d/vault-password-script"
echo FIXTURE-vault-password
