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

    @unittest.skipUnless(HAS_TEX, "no LaTeX engine")
    def test_request_masters_reach_the_gate_and_a_fail_gets_one_retry(self):
        tools = TMP / "tools"
        tools.mkdir(exist_ok=True)
        # Gate passes only when the tex holds a fact that is in the master fact_check would read.
        (tools / "verify.py").write_text(
            "import os, sys\nm = open(os.environ['RESUME_MASTER']).read()\n"
            "print('FAIL  numbers' if 'ICML' not in open(sys.argv[1]).read() or 'ICML' not in m else 'ok')\n"
            "sys.exit(0 if 'ICML' in open(sys.argv[1]).read() and 'ICML' in m else 1)\n"
        )
        calls = []

        def claude(system, user):
            calls.append(user)
            if len(calls) == 1:
                return {"tex": TEMPLATE, "summary": "first"}
            self.assertIn("<gate_failures>", user)
            self.assertIn("FAIL  numbers", user)
            return {"tex": TEMPLATE.replace("WACV 2025", "ICML 2026"), "summary": "fixed"}

        try:
            out = app.tailor({"role": "ML Engineer Intern", "jd_text": "x", "master_vault": "vault ICML", "master_tagged": "[ID: P1] ICML 2026"}, claude=claude)
            self.assertTrue(out["verify_passed"])
            self.assertEqual(out["attempts"], 2)
            self.assertIn("vault ICML", calls[0])
            self.assertIn("fixed", out["summary"])
        finally:
            shutil.rmtree(tools)

    def test_base_choice_follows_the_role_title(self):
        bases = TMP / "bases"
        bases.mkdir(exist_ok=True)
        for n in ("Base_MLEngineer.tex", "Base_CVResearch.tex", "Base_BackendSystems.tex"):
            (bases / n).write_text(n, encoding="utf-8")
        try:
            self.assertEqual(app.choose_base("Machine Learning Engineer Intern")[0], "Base_MLEngineer.tex")
            self.assertEqual(app.choose_base("Computer Vision Research Intern")[0], "Base_CVResearch.tex")
            self.assertEqual(app.choose_base("AI Research Scientist (PhD)")[0], "Base_CVResearch.tex")
            self.assertEqual(app.choose_base("Software Engineer, Backend")[0], "Base_BackendSystems.tex")
            self.assertEqual(app.choose_base("Quant Research Intern")[0], "Base_MLEngineer.tex")
        finally:
            shutil.rmtree(bases)
        self.assertEqual(app.choose_base("anything")[0], "template.tex")

    def test_masters_prefer_the_request_copy(self):
        self.assertEqual(app.masters({"master_vault": "v", "master_tagged": "t"}), ("v", "t"))
        self.assertIn("Fact: WACV", app.masters({})[1])

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
