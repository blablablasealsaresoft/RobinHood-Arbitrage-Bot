#!/usr/bin/env python3
"""Install the observer into ONE pinned, clean Nitro checkout; never deploy/run it.

No network, shell scripts, consensus changes, or credential handling. Reapplying
or applying to another revision fails. Full Nitro/Stylus compilation remains a
separate required validation step.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import os
import tempfile
from pathlib import Path
import subprocess

REVISION = "a618155919315241665356fe60f3cd00d66d5e46"
ENGINE_BLOB = "b65ba2c676c8f9baef00d72d1b5eee60d516f9f9"
GETH_REVISION = "0f618f330b8d78457524839997f0041d86f3cd1a"
SOURCE = Path("execution/gethexec/executionengine.go")


def git_blob(data: bytes) -> str:
    return hashlib.sha1(f"blob {len(data)}\0".encode() + data).hexdigest()


def transform(text: str) -> str:
    edits = (
        ("type ExecutionEngine struct {\n", "type ExecutionEngine struct {\n\tnativeArbExport nativeArbExportState\n"),
        ("\tblockWriteToDbTimer.Update(time.Since(startTime).Nanoseconds())\n",
         "\ts.nativeArbExportBlock(block, receipts)\n\tblockWriteToDbTimer.Update(time.Since(startTime).Nanoseconds())\n"),
        ("\terr := s.bc.ReorgToOldBlock(lastBlockToKeep)\n",
         "\ts.nativeArbExportInvalidate(uint64(lastBlockNumToKeep) + 1)\n\terr := s.bc.ReorgToOldBlock(lastBlockToKeep)\n"),
    )
    for old, new in edits:
        if text.count(old) != 1:
            raise ValueError(f"expected exactly one patch anchor: {old.strip()}")
        text = text.replace(old, new, 1)
    return text


def atomic_write(target: Path, data: bytes) -> None:
    mode = target.stat().st_mode & 0o777
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=target.parent, prefix=".native-export-", delete=False) as handle:
            temporary = Path(handle.name)
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        temporary.chmod(mode)
        os.replace(temporary, target)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def git(root: Path, *args: str) -> str:
    return subprocess.check_output(["git", "-C", str(root), *args], text=True).strip()


def install(root: Path, check_only: bool = False) -> dict:
    root = root.resolve(strict=True)
    if git(root, "rev-parse", "HEAD") != REVISION:
        raise ValueError("wrong Nitro revision; no edits made")
    if git(root, "status", "--porcelain", "--untracked-files=normal"):
        raise ValueError("Nitro checkout is not clean; no edits made")
    if git(root / "go-ethereum", "rev-parse", "HEAD") != GETH_REVISION:
        raise ValueError("go-ethereum submodule is missing or at a different revision")
    if git(root / "go-ethereum", "status", "--porcelain", "--untracked-files=normal"):
        raise ValueError("go-ethereum submodule is dirty")
    original = (root / SOURCE).read_bytes()
    if git_blob(original) != ENGINE_BLOB:
        raise ValueError("execution engine source differs from reviewed blob")
    changed = transform(original.decode("utf-8")).encode("utf-8")
    here = Path(__file__).resolve().parent
    output = {SOURCE: changed}
    # Copy the standalone standard-library package into the existing Nitro
    # module, without its independent go.mod or test fixtures.
    for name in ("config.go", "capture.go", "server.go"):
        output[Path("execution/nativebridge") / name] = (here / name).read_bytes()
    output[Path("execution/gethexec/nativearbexport.go")] = (here / "templates/nativearbexport.go.txt").read_bytes()
    output[Path("execution/gethexec/nativearbexport_other.go")] = (here / "templates/nativearbexport_other.go.txt").read_bytes()
    for file in output:
        if file != SOURCE and (root / file).exists():
            raise ValueError(f"target exists: {file}")
    report = {"nitroRevision": REVISION, "gethRevision": GETH_REVISION,
              "engineBlobBefore": ENGINE_BLOB, "checkOnly": check_only,
              "files": {str(k): hashlib.sha256(v).hexdigest() for k, v in output.items()},
              "nitroBuildExecuted": False, "productionReady": False}
    if not check_only:
        created = []
        try:
            for file, data in output.items():
                if file == SOURCE:
                    continue
                (root / file).parent.mkdir(parents=True, exist_ok=True)
                with (root / file).open("xb") as handle:
                    handle.write(data)
                created.append(root / file)
            # Modify the engine last. All checks/copies must have succeeded first.
            atomic_write(root / SOURCE, changed)
        except Exception:
            atomic_write(root / SOURCE, original)
            for file in created:
                file.unlink(missing_ok=True)
            raise
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("nitro_checkout", type=Path)
    parser.add_argument("--check", action="store_true", help="validate exact source/patch without writing")
    args = parser.parse_args()
    try:
        print(json.dumps(install(args.nitro_checkout, args.check), indent=2))
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        parser.exit(1, f"native exporter installer: {error}\n")
