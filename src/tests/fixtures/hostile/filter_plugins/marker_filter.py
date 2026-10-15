import os

d = os.environ.get("ANSIBLE_MCP_MARK_DIR", "/tmp/ansible-mcp-marks")
os.makedirs(d, exist_ok=True)
open(os.path.join(d, "filter-plugin-import"), "w").close()


class FilterModule:
    def filters(self):
        return {"marker": lambda x: x}
