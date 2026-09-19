"""Installer safety/anchor tests against a deliberately small synthetic fixture.
These tests are NOT an application of the patch to a complete Nitro checkout.
"""
import hashlib
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

path = Path(__file__).with_name("install.py")
spec = importlib.util.spec_from_file_location("installer", path)
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)

FIXTURE = '''package gethexec

type ExecutionEngine struct {
}
func canonical() {
	if err != nil { return err }
	blockWriteToDbTimer.Update(time.Since(startTime).Nanoseconds())
}
func reorg() {
	err := s.bc.ReorgToOldBlock(lastBlockToKeep)
}
'''

class InstallerTests(unittest.TestCase):
    def test_exact_injection_boundaries(self):
        result = installer.transform(FIXTURE)
        self.assertIn("nativeArbExport nativeArbExportState", result)
        self.assertLess(result.index("if err != nil"), result.index("nativeArbExportBlock"))
        self.assertLess(result.index("nativeArbExportInvalidate"), result.index("ReorgToOldBlock"))
        self.assertEqual(result.count("nativeArbExportBlock"), 1)

    def test_missing_or_duplicate_anchor_fails(self):
        for source in ("package other", FIXTURE + FIXTURE, FIXTURE.replace("type ExecutionEngine struct {", "type Different struct {")):
            with self.assertRaises(ValueError):
                installer.transform(source)

    def test_git_blob_hash_matches_git_object_definition(self):
        self.assertEqual(installer.git_blob(b"hello\n"), "ce013625030ba8dba906f756967f9e9ca394464a")

    def test_wrong_revision_is_read_only_failure(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(installer, "git", return_value="wrong"):
            with self.assertRaisesRegex(ValueError, "wrong Nitro"):
                installer.install(Path(directory))
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_dirty_checkout_is_not_modified(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(installer, "git", side_effect=[installer.REVISION, " M file"]):
            with self.assertRaisesRegex(ValueError, "not clean"):
                installer.install(Path(directory))
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_wrong_submodule_is_not_modified(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(installer, "git", side_effect=[installer.REVISION, "", "wrong"]):
            with self.assertRaisesRegex(ValueError, "submodule"):
                installer.install(Path(directory))
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_synthetic_apply_and_check_only(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / installer.SOURCE
            target.parent.mkdir(parents=True)
            target.write_text(FIXTURE)
            answers = [installer.REVISION, "", installer.GETH_REVISION, ""]
            with patch.object(installer, "git", side_effect=answers), patch.object(installer, "ENGINE_BLOB", installer.git_blob(FIXTURE.encode())):
                report = installer.install(root, True)
                self.assertTrue(report["checkOnly"])
                self.assertEqual(target.read_text(), FIXTURE)
                self.assertFalse((root / "execution/nativebridge").exists())
            with patch.object(installer, "git", side_effect=answers), patch.object(installer, "ENGINE_BLOB", installer.git_blob(FIXTURE.encode())):
                report = installer.install(root)
                self.assertEqual(target.read_text(), installer.transform(FIXTURE))
                self.assertFalse(report["nitroBuildExecuted"])
                for file, expected in report["files"].items():
                    self.assertEqual(hashlib.sha256((root / file).read_bytes()).hexdigest(), expected)

if __name__ == "__main__":
    unittest.main()
