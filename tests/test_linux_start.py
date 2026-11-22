"""Terminalauswahl ohne echte GUI mit isolierten Programm-Doubles pruefen."""

import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
BASH = shutil.which("bash")


@unittest.skipUnless(os.name == "posix" and BASH, "Linux-Starter benoetigt Bash")
class LinuxStarterTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="bike web launcher ")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.log = self.root / "args"
        # Auch dirname isolieren, damit kein echtes Terminal zufaellig gefunden wird.
        (self.bin / "dirname").symlink_to(shutil.which("dirname"))
        self.env = dict(os.environ, PATH=str(self.bin), DISPLAY=":test",
                        WAYLAND_DISPLAY="", TEST_ARGUMENTS=str(self.log))
        self.env.pop("BIKE_EKG_WEB_TERMINAL", None)

    def program(self, name, code):
        path = self.bin / name
        path.write_text("#!" + BASH + "\n" + code, encoding="utf-8")
        path.chmod(0o755)

    def record(self, name):
        self.program(name, 'printf "%s\\0" "$BIKE_EKG_WEB_TERMINAL" "$@" > "$TEST_ARGUMENTS"\n')

    def launch(self):
        return subprocess.run([BASH, str(ROOT / "start.sh"), "--no-browser", "--port", "0"],
                              cwd=self.root, env=self.env, capture_output=True, text=True, timeout=10)

    def arguments(self):
        return self.log.read_bytes().decode().rstrip("\0").split("\0")

    def test_terminal_variants_preserve_arguments(self):
        variants = {
            "xdg-terminal-exec": [], "konsole": ["--separate", "-e"],
            "gnome-terminal": ["--"], "xfce4-terminal": ["--disable-server", "-x"],
            "kitty": ["--"], "alacritty": ["-e"],
            "x-terminal-emulator": ["-e"], "xterm": ["-e"],
        }
        for name, options in variants.items():
            with self.subTest(terminal=name):
                self.record(name)
                result = self.launch()
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(self.arguments(), ["1"] + options +
                                 [BASH, str(ROOT / "start.sh"), "--no-browser", "--port", "0"])
                (self.bin / name).unlink()

    def test_marked_child_does_not_open_another_terminal(self):
        self.record("konsole")
        self.program("python3", 'if [[ "$1" == -c ]]; then exit 0; fi\n'
                     'printf "%s\\0" "$@" > "$TEST_ARGUMENTS"\n')
        self.env["BIKE_EKG_WEB_TERMINAL"] = "1"
        result = self.launch()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.arguments(), [str(ROOT / "start.py"), "--no-browser", "--port", "0"])

    def test_without_graphical_session_starts_directly(self):
        self.env["DISPLAY"] = ""
        self.program("python3", 'if [[ "$1" == -c ]]; then exit 0; fi\n'
                     'printf "%s\\0" "$@" > "$TEST_ARGUMENTS"\n')
        result = self.launch()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.arguments()[0], str(ROOT / "start.py"))

    def test_existing_terminal_is_reused(self):
        import pty

        self.record("konsole")
        self.program("python3", 'if [[ "$1" == -c ]]; then exit 0; fi\n'
                     'printf "%s\\0" "$@" > "$TEST_ARGUMENTS"\n')
        master, slave = pty.openpty()
        try:
            result = subprocess.run([BASH, str(ROOT / "start.sh"), "--no-browser"],
                                    env=self.env, stdin=slave, stdout=slave,
                                    stderr=subprocess.PIPE, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(self.arguments(), [str(ROOT / "start.py"), "--no-browser"])
        finally:
            os.close(slave)
            os.close(master)

    def test_wayland_session_without_display_opens_terminal(self):
        self.env["DISPLAY"] = ""
        self.env["WAYLAND_DISPLAY"] = "wayland-test"
        self.record("konsole")
        result = self.launch()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.arguments()[:3], ["1", "--separate", "-e"])

    def test_missing_terminal_reports_problem(self):
        result = self.launch()
        self.assertEqual(result.returncode, 1)
        self.assertIn("Kein Terminalprogramm gefunden", result.stderr)

    def test_missing_python_reports_problem(self):
        self.env["BIKE_EKG_WEB_TERMINAL"] = "1"
        result = self.launch()
        self.assertEqual(result.returncode, 1)
        self.assertIn("Python 3.9 oder neuer fehlt", result.stderr)


if __name__ == "__main__":
    unittest.main()
