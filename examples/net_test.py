"""Network test — diagnose VM connectivity."""

import os

from nightshift import NightshiftApp, AgentConfig

app = NightshiftApp()


@app.agent(
    AgentConfig(
        workspace=os.path.join(os.path.dirname(__file__), "test-workspace"),
        vcpu_count=2,
        mem_size_mib=2048,
    )
)
async def net_test(prompt: str):
    import subprocess

    checks = [
        ("resolv.conf", "cat /etc/resolv.conf"),
        ("default route", "ip route show"),
        ("interfaces", "ip addr show"),
        ("ping gateway", "ping -c 1 -W 2 172.16.1.1"),
        ("dns lookup", "nslookup api.anthropic.com"),
        ("curl anthropic", "curl -sv --connect-timeout 5 https://api.anthropic.com 2>&1 | head -20"),
    ]

    for name, cmd in checks:
        result = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=10)
        yield {
            "type": "agent.message",
            "check": name,
            "stdout": result.stdout.strip()[:500],
            "stderr": result.stderr.strip()[:500],
            "exit": result.returncode,
        }


if __name__ == "__main__":
    app.serve()
