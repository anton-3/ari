import importlib.util
import os
import tempfile
import unittest
from pathlib import Path
spec = importlib.util.spec_from_file_location('reader', Path(__file__).parents[1] / 'fleet-roles/request-reader.py')
reader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reader)

class ReaderTests(unittest.TestCase):
    def test_rotation_partial_lines_and_cursor(self):
        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory) / 'access.log'
            log.write_text('1000 200 a "GET / HTTP/1.1" 1 x 0.1\n1001 200')
            first = reader.read_batch(str(log), now=1002)
            self.assertEqual(len(first['entries']), 1)
            with log.open('a') as stream:
                stream.write(' b "GET / HTTP/1.1" 1 x 0.1\n')
            os.rename(log, str(log) + '.1')
            log.write_text('1002 403 c "GET / HTTP/1.1" 1 x 0.1\n')
            second = reader.read_batch(str(log), first['cursor'], now=1003)
            self.assertEqual(len(second['entries']), 2)
            third = reader.read_batch(str(log), second['cursor'], now=1003)
            self.assertEqual(third['entries'], [])
            self.assertEqual(len(set(e['id'] for e in first['entries'] + second['entries'])), 3)
    def test_missing_inode_is_explicit_gap(self):
        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory) / 'access.log'
            log.write_text('1000 200 a "GET / HTTP/1.1" 1 x 0.1\n')
            batch = reader.read_batch(str(log), {'inode': -1, 'offset': 0}, now=1001)
            self.assertTrue(batch['gap'])

if __name__ == '__main__':
    unittest.main()
