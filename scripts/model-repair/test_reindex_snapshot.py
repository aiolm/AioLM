import hashlib
import json
import struct
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from reindex_snapshot import publish_exclusive, reindex_snapshot, tensor_inventory


def weight(path, tensor=None, data=b"\0\0\0\0"):
    header = json.dumps(tensor or {"quantized.weight": {"dtype": "U32", "shape": [1], "data_offsets": [0, 4]}}).encode()
    path.write_bytes(struct.pack("<Q", len(header)) + header + data)
    return hashlib.sha256(path.read_bytes()).hexdigest()


class SnapshotIndexReconstruction(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / "source"
        self.source.mkdir()
        (self.source / "config.json").write_text('{"model_type":"synthetic"}')
        (self.source / "model.safetensors.index.json").write_text('{"weight_map":{"old.weight":"missing.safetensors"}}')
        self.hash = weight(self.source / "model.safetensors")
        self.output = self.root / "derived"

    def run_repair(self):
        return reindex_snapshot(self.source, self.output, {"model.safetensors": self.hash})

    def test_reconstructs_from_verified_tensor_ranges_and_preserves_original(self):
        (self.source / "LICENSE").write_text("Synthetic model license; retain these bytes.")
        (self.source / "NOTICE").write_text("Synthetic attribution notice.")
        before = {path.name: path.read_bytes() for path in self.source.iterdir()}
        audit = self.run_repair()
        index = json.loads((self.output / "model.safetensors.index.json").read_text())
        self.assertEqual(index, {"metadata": {"total_size": 4}, "weight_map": {"quantized.weight": "model.safetensors"}})
        self.assertTrue(audit["loader_validation_required"])
        self.assertEqual((self.output / "source-index.json").read_bytes(), before["model.safetensors.index.json"])
        self.assertEqual((self.output / "model.safetensors").read_bytes(), before["model.safetensors"])
        for name in ("LICENSE", "NOTICE"):
            self.assertEqual((self.output / name).read_bytes(), before[name])
        self.assertEqual({path.name: path.read_bytes() for path in self.source.iterdir()}, before)
        self.assertFalse(list(self.root.glob(".aiolm-reindex-*")))

    def test_rejects_truncation_shape_mismatch_and_overlapping_tensors(self):
        descriptors = [
            {"x": {"dtype": "U32", "shape": [2], "data_offsets": [0, 4]}},
            {"x": {"dtype": "U32", "shape": [1], "data_offsets": [0, 8]}},
            {name: {"dtype": "U32", "shape": [1], "data_offsets": [0, 4]} for name in ("x", "y")},
        ]
        for descriptor in descriptors:
            with self.subTest(descriptor=descriptor):
                weight(self.source / "model.safetensors", descriptor)
                with self.assertRaises(ValueError):
                    tensor_inventory(self.source / "model.safetensors")
        self.assertFalse(self.output.exists())

    def test_rejects_mismatched_hash_and_duplicate_tensors_across_files(self):
        with self.assertRaisesRegex(ValueError, "SHA-256 mismatch"):
            reindex_snapshot(self.source, self.output, {"model.safetensors": "0" * 64})
        second = weight(self.source / "model-other.safetensors")
        with self.assertRaisesRegex(ValueError, "duplicate tensor"):
            reindex_snapshot(self.source, self.output, {"model.safetensors": self.hash, "model-other.safetensors": second})
        self.assertFalse(self.output.exists())

    def test_preserves_existing_output_and_cleans_cancelled_copy(self):
        self.output.mkdir()
        marker = self.output / "existing.txt"
        marker.write_text("Preserve this output.")
        with self.assertRaises(FileExistsError):
            self.run_repair()
        self.assertEqual(marker.read_text(), "Preserve this output.")
        marker.unlink()
        self.output.rmdir()
        with patch("reindex_snapshot.shutil.copyfile", side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                self.run_repair()
        self.assertFalse(self.output.exists())
        self.assertFalse(list(self.root.glob(".aiolm-reindex-*")))

    def test_output_created_during_publication_is_preserved(self):
        def raced_publish(stage, destination):
            destination.mkdir()
            publish_exclusive(stage, destination)

        with patch("reindex_snapshot.publish_exclusive", side_effect=raced_publish):
            with self.assertRaises(FileExistsError):
                self.run_repair()
        self.assertTrue(self.output.is_dir())
        self.assertEqual(list(self.output.iterdir()), [])
        self.assertFalse(list(self.root.glob(".aiolm-reindex-*")))


if __name__ == "__main__":
    unittest.main()
