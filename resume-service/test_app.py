"""Run: cd resume-service && python3 -m unittest -v (needs pdflatex or tectonic for the compile tests)."""
import base64
import json
import os
import shutil
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

TMP = Path(tempfile.mkdtemp())
(TMP / "master_resume.md").write_text("# Master\n- Fact: WACV 2025 second author.\n", encoding="utf-8")
TEMPLATE = r"""\documentclass{article}
\pagestyle{empty}
\begin{document}
Nischit Hosamani\\ Fact: WACV 2025 second author.
\end{document}
"""
(TMP / "template.tex").write_text(TEMPLATE, encoding="utf-8")
os.environ["ASSETS_DIR"] = str(TMP)
os.environ["RESUME_SERVICE_TOKEN"] = "t" * 32

import app  # noqa: E402

HAS_TEX = bool(shutil.which("tectonic") or shutil.which("pdflatex"))


def fake_claude(system, user):
    assert "<jd>" in user and "<master_resume>" in user
    return {"tex": TEMPLATE.replace("Fact", "Fact — tailored"), "summary": "moved WACV up"}


class TailorTests(unittest.TestCase):
    @unittest.skipUnless(HAS_TEX, "no LaTeX engine")
    def test_tailor_compiles_one_page_and_strips_em_dash(self):
        out = app.tailor({"company": "DRW", "role": "QR Intern", "jd_text": "stats"}, claude=fake_claude)
        self.assertEqual(out["pages"], 1)
        self.assertTrue(base64.b64decode(out["pdf_base64"]).startswith(b"%PDF"))
        self.assertNotIn("—", out["tex"])
        self.assertIsNone(out["verify_passed"])  # no verify.py in assets

    @unittest.skipUnless(HAS_TEX, "no LaTeX engine")
    def test_two_pages_fail_the_gate(self):
        long_tex = TEMPLATE.replace("\\end{document}", "\\newpage second page\n\\end{document}")
        out = app.tailor({"jd_text": "x"}, claude=lambda s, u: {"tex": long_tex, "summary": ""})
        self.assertEqual(out["pages"], 2)
        self.assertFalse(out["verify_passed"])

    @unittest.skipUnless(HAS_TEX, "no LaTeX engine")
    def test_verify_script_runs(self):
        (TMP / "verify.py").write_text("import sys; sys.exit(0 if 'WACV' in open(sys.argv[1]).read() else 1)\n")
        try:
            out = app.tailor({"jd_text": "x"}, claude=fake_claude)
            self.assertTrue(out["verify_passed"])
        finally:
            (TMP / "verify.py").unlink()

    def test_page_count(self):
        self.assertEqual(app.pdf_page_count(b"<< /Type /Pages /Count 2 >> << /Type /Page >> << /Type/Page >>"), 2)


class HttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = app.ThreadingHTTPServer(("127.0.0.1", 0), app.Handler)
        cls.port = cls.srv.server_address[1]
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()

    def _post(self, token):
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}/tailor", data=json.dumps({"jd_text": "x"}).encode(), headers={"x-service-token": token, "content-type": "application/json"})
        return urllib.request.urlopen(req, timeout=10)

    def test_rejects_bad_token(self):
        with self.assertRaises(urllib.error.HTTPError) as e:
            self._post("wrong")
        self.assertEqual(e.exception.code, 401)

    def test_health(self):
        with urllib.request.urlopen(f"http://127.0.0.1:{self.port}/health", timeout=5) as r:
            self.assertTrue(json.loads(r.read())["ok"])


if __name__ == "__main__":
    unittest.main()
