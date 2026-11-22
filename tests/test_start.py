"""Offline-Starter mit echten lokalen HTTP-Requests, ohne Browser oder BLE testen."""

import importlib.util
from pathlib import Path
import socket
import threading
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import build_opener, ProxyHandler

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("bike_ekg_start", ROOT / "start.py")
starter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(starter)


class StarterTests(unittest.TestCase):
    def test_local_server_serves_files_and_workers(self):
        server = starter.create_server(0)
        self.assertEqual(server.server_address[0], "127.0.0.1")
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        opener = build_opener(ProxyHandler({}))
        base = "http://127.0.0.1:{}/".format(server.server_port)
        try:
            for name in ("", "monitor.js?v=0.1.8", "visualization-worker.js",
                         "visualization-filter-worker.js", "styles.css?v=0.1.8", "README.md"):
                with opener.open(base + name, timeout=5) as response:
                    self.assertEqual(response.status, 200)
                    self.assertTrue(response.read())
            with opener.open(base, timeout=5) as response:
                self.assertIn(b"<title>Bike-EKG_Web</title>", response.read())
            with self.assertRaises(HTTPError) as result:
                opener.open(base + "missing-file", timeout=5)
            self.assertEqual(result.exception.code, 404)
            result.exception.close()
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)

    def test_busy_port_uses_new_server_without_opening_browser(self):
        busy = socket.socket()
        busy.bind(("127.0.0.1", 0))
        busy.listen(1)
        port = busy.getsockname()[1]
        try:
            with patch.object(starter.ThreadingHTTPServer, "serve_forever",
                              side_effect=KeyboardInterrupt), patch.object(starter, "open_browser") as browser:
                self.assertEqual(starter.main(["--port", str(port), "--no-browser"]), 0)
                browser.assert_not_called()
        finally:
            busy.close()

    def test_invalid_port_is_rejected(self):
        for value in ("-1", "65536", "abc"):
            with self.assertRaises(starter.argparse.ArgumentTypeError):
                starter.port_number(value)


if __name__ == "__main__":
    unittest.main()
