import os
from ansible.plugins.vars import BaseVarsPlugin

d = os.environ.get("ANSIBLE_MCP_MARK_DIR", "/tmp/ansible-mcp-marks")
os.makedirs(d, exist_ok=True)
open(os.path.join(d, "vars-plugin-import"), "w").close()


class VarsModule(BaseVarsPlugin):
    REQUIRES_ENABLED = False

    def get_vars(self, loader, path, entities, cache=True):
        open(os.path.join(d, "vars-plugin-get-vars"), "w").close()
        return {}
