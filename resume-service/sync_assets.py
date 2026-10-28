"""Copy the resume files the service needs from your Resume Optimizer and vault into assets/.

    python sync_assets.py [--optimizer "E:\\Projects\\Resume Optimizer"] [--vault "E:\\Projects\\vault\\AboutMe\\Master Resume MD.md"]

Run it before each deploy. It copies, never edits, and prints what changed.
"""
import argparse
import filecmp
import shutil
from pathlib import Path

HERE = Path(__file__).parent / "assets"
FILES = [
    "bases/Base_MLEngineer.tex", "bases/Base_CVResearch.tex", "bases/Base_BackendSystems.tex",
    "tools/verify.py", "tools/ats_check.py", "tools/fact_check.py", "tools/build_check.py",
    "master_resume.md",
]


def copy(src: Path, dst: Path) -> str:
    if not src.exists():
        return f"MISSING  {src}"
    dst.parent.mkdir(parents=True, exist_ok=True)
    same = dst.exists() and filecmp.cmp(src, dst, shallow=False)
    if not same:
        shutil.copy2(src, dst)
    return f"{'same   ' if same else 'updated'}  {dst.relative_to(HERE.parent)}"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--optimizer", default=r"E:\Projects\Resume Optimizer")
    ap.add_argument("--vault", default=r"E:\Projects\vault\AboutMe\Master Resume MD.md")
    a = ap.parse_args()
    opt = Path(a.optimizer)
    lines = [copy(opt / f, HERE / f) for f in FILES] + [copy(Path(a.vault), HERE / "vault_master.md")]
    print("\n".join(lines))
    return 1 if any(l.startswith("MISSING") for l in lines) else 0


if __name__ == "__main__":
    raise SystemExit(main())
