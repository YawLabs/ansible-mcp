#!/bin/sh
d="${ANSIBLE_MCP_MARK_DIR:-/tmp/ansible-mcp-marks}"; mkdir -p "$d"; touch "$d/inventory-script"
echo '{"scripted": {"hosts": ["s1"]}, "_meta": {"hostvars": {}}}'
