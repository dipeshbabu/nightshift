from __future__ import annotations

import json
import sys


def main() -> int:
    config = json.load(sys.stdin)
    results = run(config)
    json.dump(results, sys.stdout)
    return 0


def run(config: dict) -> dict:
    raise NotImplementedError


if __name__ == "__main__":
    sys.exit(main())
