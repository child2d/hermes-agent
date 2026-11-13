import _path_setup
"""One request key admits at most one logical business run (host boundary evidence)."""
import os
import tempfile
import threading
import unittest
from pathlib import Path

from baymax_delivery.start_admission import StartAdmission


def _admit_in_child(path, args, queue):
    """Child entry point: one independent admission attempt in its own process."""
    gate = StartAdmission(path)
    try:
        queue.put(bool(gate.admit(**args)['shouldLaunch']))
    except Exception as error:  # a refused attempt must not be counted as a launch
        queue.put(f'error: {error}')
    finally:
        gate.close()


class AdmissionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=os.environ['TMPDIR'], prefix='baymax-adm-')
        self.gate = StartAdmission(Path(self.tmp.name) / 'admission.sqlite')
        self.args = dict(request_key='click-1', issue_id='42', execution_ref='run:1', goal_version='goal-a')

    def tearDown(self):
        self.gate.close()
        self.tmp.cleanup()

    def test_repeated_click_launches_once(self):
        first = self.gate.admit(**self.args)
        self.assertTrue(first['shouldLaunch'])
        second = self.gate.admit(**self.args)
        self.assertFalse(second['shouldLaunch'])
        self.assertEqual(second['state'], 'started')
        self.assertEqual(second['admission']['executionRef'], 'run:1')

    def test_concurrent_click_launches_once(self):
        results = []
        def click():
            results.append(self.gate.admit(**self.args))
        threads = [threading.Thread(target=click) for _ in range(4)]
        for thread in threads: thread.start()
        for thread in threads: thread.join()
        self.assertEqual(sum(1 for r in results if r['shouldLaunch']), 1)

    def test_concurrent_processes_launch_once(self):
        """Separate OS processes, separate sqlite connections: still exactly one launch."""
        import multiprocessing
        ctx = multiprocessing.get_context('spawn')
        path = str(Path(self.tmp.name) / 'admission.sqlite')
        children, queue = [], ctx.Queue()
        for _ in range(6):
            child = ctx.Process(target=_admit_in_child, args=(path, self.args, queue))
            child.start()
            children.append(child)
        for child in children: child.join(20)
        verdicts = [queue.get(timeout=5) for _ in children]
        self.assertEqual(sum(1 for v in verdicts if v), 1, verdicts)

    def test_same_key_with_different_content_is_refused(self):
        self.gate.admit(**self.args)
        with self.assertRaises(ValueError):
            self.gate.admit(**{**self.args, 'goal_version': 'goal-b'})

    def test_finished_or_abandoned_run_is_not_relaunched(self):
        self.gate.admit(**self.args)
        self.gate.finish('click-1', note='delivered')
        again = self.gate.admit(**self.args)
        self.assertFalse(again['shouldLaunch'])
        self.assertEqual(again['state'], 'finished')
        self.gate.admit(**{**self.args, 'request_key': 'click-2'})
        self.gate.abandon('click-2', note='host stopped')
        third = self.gate.admit(**{**self.args, 'request_key': 'click-2'})
        self.assertFalse(third['shouldLaunch'])
        self.assertEqual(third['state'], 'abandoned')


if __name__ == '__main__':
    unittest.main()
