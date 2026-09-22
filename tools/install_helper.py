#!/usr/bin/env python3
import argparse
import json
import re
from pathlib import Path

SECTION = "update_manager indx-aim-and-click"
BEGIN = "# BEGIN INDX AIM AND CLICK"
END = "# END INDX AIM AND CLICK"


def update_nav(config_root: Path, install: bool) -> None:
    path = config_root / ".theme" / "navi.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    rows = []
    if path.exists():
        rows = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(rows, list):
            raise RuntimeError(f"Expected a JSON array in {path}")
    rows = [row for row in rows if row.get("href") != "/nozzlecam-calibrator/"]
    if install:
        rows.append({
            "title": "INDX Aim & Click",
            "href": "/nozzlecam-calibrator/",
            "target": "_self",
            "position": 45,
        })
    path.write_text(json.dumps(rows, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def update_moonraker(path: Path, repo: Path, install: bool) -> None:
    text = path.read_text(encoding="utf-8") if path.exists() else ""
    pattern = re.compile(rf"\n?{re.escape(BEGIN)}.*?{re.escape(END)}\n?", re.S)
    text = pattern.sub("\n", text).rstrip() + "\n"
    if install:
        block = f"""
{BEGIN}
[{SECTION}]
type: git_repo
path: {repo}
origin: https://github.com/spi-ntech/indx-aim-and-click.git
primary_branch: main
is_system_service: False
{END}
"""
        text += block
    path.write_text(text, encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("install", "uninstall"))
    parser.add_argument("--config-root", type=Path, required=True)
    parser.add_argument("--repo", type=Path, required=True)
    args = parser.parse_args()
    installing = args.action == "install"
    update_nav(args.config_root, installing)
    update_moonraker(args.config_root / "moonraker.conf", args.repo.resolve(), installing)


if __name__ == "__main__":
    main()
