"""Offline boundary tests: execute actual AST function bodies, not the full app.

Google signature validation is explicitly mocked; no network, DB or app startup.
The real Pydantic request schema is loaded from the tracked mirror.
"""
import ast
import contextlib
import io
import os
from pathlib import Path
import runpy
from types import SimpleNamespace
from typing import Optional
import unittest
from unittest.mock import Mock, patch

from fastapi import HTTPException, status

ROOT = Path(__file__).resolve().parents[1]
TOKEN = "synthetic-secret-token-must-not-appear-in-logs"
TRUSTED = "847956533620-i97tume6hs4k6g0lja0tu4gkidaulis3.apps.googleusercontent.com"
ANDROID = "847956533620-s39avbq2lame2osonh57i0ioausdblo2.apps.googleusercontent.com"


def actual_function(path, name, namespace):
    tree = ast.parse(path.read_text())
    node = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == name)
    node.decorator_list = []
    exec(compile(ast.Module(body=[node], type_ignores=[]), str(path), "exec"), namespace)
    return namespace[name]


class AuthBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.verifier = Mock(return_value=self.claims())
        self.request = Mock()
        self.ns = {"os": os, "Optional": Optional,
                   "id_token": SimpleNamespace(verify_oauth2_token=self.verifier),
                   "google_requests": SimpleNamespace(Request=self.request)}
        # Use real server-owned allowlist/config declarations, with no live env.
        tree = ast.parse((ROOT / "app/auth.py").read_text())
        nodes: list[ast.stmt] = [n for n in tree.body if
                 (isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id in
                  {"GOOGLE_CLIENT_ID", "TRUSTED_CLIENT_IDS"} for t in n.targets)) or
                 (isinstance(n, ast.If) and isinstance(n.test, ast.Name) and n.test.id == "GOOGLE_CLIENT_ID")]
        with patch.dict(os.environ, {"GOOGLE_CLIENT_ID": ""}):
            exec(compile(ast.Module(body=nodes, type_ignores=[]), "auth-config", "exec"), self.ns)
        self.verify = actual_function(ROOT / "app/auth.py", "verify_google_token", self.ns)
        self.schema = runpy.run_path(str(ROOT / "app/models.py"))["AuthLoginRequest"]

    def claims(self, **changes):
        return dict({"aud": TRUSTED, "iss": "https://accounts.google.com", "email": "allowed@example.test",
                     "name": "Test", "sub": "test-sub", "nonce": "browser-nonce"}, **changes)

    def login(self, **request):
        self.whitelist = Mock(return_value={"id": "u", "email": "allowed@example.test", "name": "Test",
                                           "user_name": "test", "is_admin": False})
        self.session = Mock(return_value="synthetic-session")
        ns = {"AuthLoginRequest": self.schema, "TEST_MODE": False, "os": os,
              "verify_google_token": self.verify, "check_navidrome_whitelist": self.whitelist,
              "create_session_token": self.session, "HTTPException": HTTPException, "status": status}
        login = actual_function(ROOT / "app/main.py", "login", ns)
        with patch.dict(os.environ, {"GOOGLE_CLIENT_ID": ""}):
            return login(self.schema(id_token=TOKEN, **request))

    def test_unknown_client_matching_audience_rejected_before_google(self):
        self.verifier.return_value = self.claims(aud="attacker-client")
        self.assertIsNone(self.verify(TOKEN, "attacker-client"))
        self.verifier.assert_not_called()
        self.request.assert_not_called()

    def test_trusted_client_accepted(self):
        self.assertEqual(self.verify(TOKEN, TRUSTED)["sub"], "test-sub")
        self.verifier.assert_called_once_with(TOKEN, self.request.return_value, TRUSTED)

    def test_trusted_audience_enforced_even_on_first_verifier_success(self):
        for aud in ("attacker-client", None, "", [TRUSTED], ANDROID):
            with self.subTest(aud=aud):
                self.verifier.return_value = self.claims(aud=aud)
                self.assertIsNone(self.verify(TOKEN, TRUSTED))

    def test_without_client_only_allowlisted_audience_accepted(self):
        for aud in (TRUSTED, ANDROID):
            self.verifier.return_value = self.claims(aud=aud)
            self.assertIsNotNone(self.verify(TOKEN))
        for aud in (None, "attacker-client", [TRUSTED]):
            self.verifier.return_value = self.claims(aud=aud)
            self.assertIsNone(self.verify(TOKEN))

    def test_invalid_or_missing_issuer_rejected(self):
        for issuer in (None, "https://attacker.example", ""):
            self.verifier.return_value = self.claims(iss=issuer)
            self.assertIsNone(self.verify(TOKEN, TRUSTED))

    def test_google_issuers_accepted(self):
        for issuer in ("accounts.google.com", "https://accounts.google.com"):
            self.verifier.return_value = self.claims(iss=issuer)
            self.assertIsNotNone(self.verify(TOKEN, TRUSTED))

    def test_signature_verifier_exception_rejected_without_fallback(self):
        self.verifier.side_effect = [ValueError("bad signature"), self.claims()]
        self.assertIsNone(self.verify(TOKEN, TRUSTED))
        self.assertEqual(self.verifier.call_count, 1)

    def test_optional_nonce_match_accepted(self):
        self.assertIsNotNone(self.verify(TOKEN, TRUSTED, expected_nonce="browser-nonce"))

    def test_expected_nonce_missing_or_mismatch_rejected(self):
        for nonce in (None, "", "wrong-nonce"):
            self.verifier.return_value = self.claims(nonce=nonce)
            self.assertIsNone(self.verify(TOKEN, TRUSTED, expected_nonce="browser-nonce"))
        self.assertIsNone(self.verify(TOKEN, TRUSTED, expected_nonce=""))

    def test_android_no_nonce_compatibility_and_all_original_ids_preserved(self):
        for client in (TRUSTED, TRUSTED.removesuffix(".apps.googleusercontent.com"),
                       ANDROID, ANDROID.removesuffix(".apps.googleusercontent.com")):
            self.verifier.return_value = self.claims(aud=client, nonce=None)
            self.assertIsNotNone(self.verify(TOKEN, client))

    def test_android_without_requested_client_accepts_trusted_audience_with_web_config(self):
        self.ns["GOOGLE_CLIENT_ID"] = TRUSTED
        self.verifier.return_value = self.claims(aud=ANDROID, nonce=None)
        self.assertIsNotNone(self.verify(TOKEN))

    def test_configured_client_is_added_by_actual_server_config(self):
        tree = ast.parse((ROOT / "app/auth.py").read_text())
        nodes: list[ast.stmt] = [n for n in tree.body if
            (isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id in
             {"GOOGLE_CLIENT_ID", "TRUSTED_CLIENT_IDS"} for t in n.targets)) or
            (isinstance(n, ast.If) and isinstance(n.test, ast.Name) and n.test.id == "GOOGLE_CLIENT_ID")]
        with patch.dict(os.environ, {"GOOGLE_CLIENT_ID": "server-configured-client"}):
            exec(compile(ast.Module(body=nodes, type_ignores=[]), "auth-config", "exec"), self.ns)
        self.verifier.return_value = self.claims(aud="server-configured-client")
        self.assertIsNotNone(self.verify(TOKEN, "server-configured-client"))
        self.assertIn(TRUSTED, self.ns["TRUSTED_CLIENT_IDS"])
        self.assertIn(ANDROID, self.ns["TRUSTED_CLIENT_IDS"])

    def test_exception_text_never_logs_raw_tokens(self):
        self.verifier.side_effect = ValueError(TOKEN)
        output = io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            self.assertIsNone(self.verify(TOKEN, TRUSTED))
        self.assertNotIn(TOKEN, output.getvalue())

    def test_schema_retains_optional_nonce(self):
        self.assertEqual(self.schema(expected_nonce="browser-nonce").expected_nonce, "browser-nonce")
        self.assertIsNone(self.schema().expected_nonce)

    def test_login_forwards_nonce_and_rejects_mismatch_before_whitelist(self):
        with self.assertRaises(HTTPException) as error:
            self.login(client_id=TRUSTED, expected_nonce="wrong-nonce")
        self.assertEqual(error.exception.status_code, 401)
        self.whitelist.assert_not_called()
        self.session.assert_not_called()

    def test_login_nonce_success_and_android_compatibility(self):
        self.assertEqual(self.login(client_id=TRUSTED, expected_nonce="browser-nonce")["token"], "synthetic-session")
        self.verifier.return_value = self.claims(aud=ANDROID, nonce=None)
        self.assertEqual(self.login(client_id=ANDROID)["token"], "synthetic-session")

    def test_login_still_requires_email_whitelist(self):
        # Real login body, independently controlled whitelist.
        req = self.schema(id_token=TOKEN, client_id=TRUSTED)
        ns = {"AuthLoginRequest": self.schema, "TEST_MODE": False, "os": os,
              "verify_google_token": self.verify, "check_navidrome_whitelist": Mock(return_value=None),
              "create_session_token": Mock(), "HTTPException": HTTPException, "status": status}
        login = actual_function(ROOT / "app/main.py", "login", ns)
        with self.assertRaises(HTTPException) as error:
            login(req)
        self.assertEqual(error.exception.status_code, 403)
        ns["create_session_token"].assert_not_called()

    def test_missing_email_rejected_before_whitelist(self):
        self.verifier.return_value = self.claims(email=None)
        with self.assertRaises(HTTPException) as error:
            self.login(client_id=TRUSTED)
        self.assertEqual(error.exception.status_code, 401)
        self.whitelist.assert_not_called()


if __name__ == "__main__":
    unittest.main(verbosity=2)
