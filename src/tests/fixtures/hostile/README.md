Never-execute probe project. Every hook here touches a marker file under $ANSIBLE_MCP_MARK_DIR
(default /tmp/ansible-mcp-marks) when Ansible runs it. Integration tests run each server command
against this dir and assert which markers appear. See docs/design.md section "Never-execute".
