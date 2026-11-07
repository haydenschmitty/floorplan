"""The plugin's Python half, run the way Hermes runs it: `register(ctx)` on a real package import.

The probe, and the `ask` worker: the NDJSON protocol, the confined reader and the
single-use tickets. Nothing here calls a provider or a real model: `ctx.llm` is a stand-in.

    python3 -m unittest discover -s tests -p 'hermes_runner_test.py'
"""
import argparse
import hashlib
import importlib
import importlib.util
import io
import json
import os
import platform
import sys
import tempfile
import time
import types
import unittest
from contextlib import redirect_stdout
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]


class FakeContext:
    """The registration surface this plugin uses, and nothing else: skills, CLI commands, the manifest."""

    manifest = types.SimpleNamespace(name="floorplan", version="9.9.9-test")
    profile_name = "throwaway-profile"

    def __init__(self):
        self.skills = []
        self.cli_commands = []

    def register_skill(self, name, path, description=""):
        self.skills.append({"name": name, "path": Path(path), "description": description})

    def register_cli_command(self, name, help, setup_fn, handler_fn=None, description=""):
        self.cli_commands.append({"name": name, "help": help, "setup_fn": setup_fn,
                                  "handler_fn": handler_fn, "description": description})


def load_plugin():
    """Import the plugin the way hermes_cli.plugins_loader does: as `hermes_plugins.<key>`, a package."""
    parent = "hermes_plugins"
    if parent not in sys.modules:
        package = types.ModuleType(parent)
        package.__path__ = []
        sys.modules[parent] = package
    name = parent + ".floorplan"
    spec = importlib.util.spec_from_file_location(
        name, REPO / "__init__.py", submodule_search_locations=[str(REPO)])
    module = importlib.util.module_from_spec(spec)
    module.__package__, module.__path__ = name, [str(REPO)]
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


class PluginTest(unittest.TestCase):
    def setUp(self):
        self.plugin = load_plugin()
        self.ctx = FakeContext()
        self.plugin.register(self.ctx)
        self.runner = importlib.import_module("hermes_plugins.floorplan.hermes.runner")

    def command(self, argv):
        """The CLI parser Hermes builds from this plugin, and the handler it runs for `hermes floorplan …`."""
        self.assertEqual([c["name"] for c in self.ctx.cli_commands], ["floorplan"])
        entry = self.ctx.cli_commands[0]
        parser = argparse.ArgumentParser(prog="hermes floorplan")
        entry["setup_fn"](parser)
        parser.set_defaults(func=entry["handler_fn"])
        args = parser.parse_args(argv)
        out = io.StringIO()
        with redirect_stdout(out):
            code = args.func(args)
        return code, out.getvalue()

    def test_registers_one_skill_and_one_cli_command(self):
        self.assertEqual([s["name"] for s in self.ctx.skills], ["floorplan"])
        self.assertEqual(self.ctx.skills[0]["path"], REPO / "skills" / "floorplan" / "SKILL.md")
        self.assertTrue(self.ctx.skills[0]["description"])
        self.assertEqual(len(self.ctx.cli_commands), 1)
        self.assertTrue(callable(self.ctx.cli_commands[0]["handler_fn"]))

    def test_probe_names_this_install_without_a_model(self):
        code, out = self.command(["probe"])
        self.assertEqual(code, 0)
        payload = json.loads(out)
        self.assertEqual(payload["plugin"], "floorplan")
        self.assertEqual(payload["plugin_version"], "9.9.9-test")
        self.assertEqual(payload["protocol"], 1)
        self.assertEqual(payload["profile"], "throwaway-profile")
        self.assertEqual(payload["skill"], "floorplan:floorplan")
        self.assertEqual(payload["skill_dir"], str((REPO / "skills" / "floorplan").resolve()))
        self.assertEqual(payload["commands"], ["floorplan"])
        self.assertEqual(payload["ask"], "ready" if self.runner.SUPPORTED else "unsupported_runtime")
        self.assertEqual(payload["python"]["implementation"], platform.python_implementation())
        self.assertTrue(payload["os"]["system"])

    def test_probe_prints_no_credential_or_machine_setting(self):
        _, out = self.command(["probe"])
        payload = json.loads(out)
        forbidden = ("token", "secret", "password", "credential", "api_key", "auth")
        self.assertEqual([k for k in payload if any(word in k.lower() for word in forbidden)], [])
        self.assertEqual([k for k in payload["python"] if any(word in k.lower() for word in forbidden)], [])

    def test_the_probe_reports_unsupported_outside_posix(self):
        # One gate for the probe and the ask worker: posix, O_NOFOLLOW, and a dir_fd-capable os.open.
        self.assertEqual(self.runner.SUPPORTED, os.name == "posix" and hasattr(os, "O_NOFOLLOW")
                         and os.open in os.supports_dir_fd)
        original = self.runner.SUPPORTED
        self.runner.SUPPORTED = False
        try:
            payload = self.runner.probe_payload(profile="throwaway-profile", plugin_version="9.9.9-test",
                                                skill_path=REPO / "skills" / "floorplan" / "SKILL.md")
        finally:
            self.runner.SUPPORTED = original
        self.assertEqual(payload["ask"], "unsupported_runtime")

    def test_ask_takes_a_root_option_and_serves_the_worker(self):
        parser = argparse.ArgumentParser(prog="hermes floorplan")
        self.ctx.cli_commands[0]["setup_fn"](parser)
        args = parser.parse_args(["ask", "--root", "/tmp/x"])
        self.assertEqual((args.floorplan_command, args.root), ("ask", "/tmp/x"))

    def test_a_skill_path_outside_the_installed_plugin_is_refused(self):
        with self.assertRaises(ValueError):
            self.runner.probe_payload(profile="throwaway-profile", plugin_version="9.9.9-test",
                                      skill_path=Path("/etc/hostname"))


class FakeLlm:
    """`ctx.llm.complete_structured`, scripted: one decision (or one exception) per call."""

    def __init__(self, decisions):
        self.decisions = list(decisions)
        self.calls = []

    def complete_structured(self, *, instructions=None, input=None, json_schema=None, timeout=None,
                            purpose=None, **kw):
        text = "".join(b.get("text", "") if isinstance(b, dict) else getattr(b, "text", "") for b in input or [])
        self.calls.append({"text": text, "json_schema": json_schema, "timeout": timeout, "purpose": purpose})
        decision = self.decisions.pop(0)
        if isinstance(decision, BaseException):
            raise decision
        if isinstance(decision, str):  # a reply the host could not parse as a whole: it leaves parsed empty
            return types.SimpleNamespace(parsed=None, text=decision, provider="test-prov", model="test-model",
                                         agent_id="a", usage=None, audit={})
        return types.SimpleNamespace(parsed=decision, text=json.dumps(decision), provider="test-prov",
                                     model="test-model", agent_id="a", usage=None, audit={})


class PluginLlmTrustError(PermissionError):
    """The host's typed refusal, by name (the runner maps it without importing Hermes outside it)."""


SHA = lambda path: hashlib.sha256(Path(path).read_bytes()).hexdigest()  # noqa: E731
ROOT_DIGEST = lambda root: hashlib.sha256(os.path.realpath(root).encode()).hexdigest()  # noqa: E731


class SwappingStdin(io.StringIO):
    """Swaps a file the instant a ticket frame arrives: after classification, before the reopen."""

    def __init__(self, text, swap):
        super().__init__(text)
        self.swap, self.swapped = swap, False

    def readline(self, *args):
        line = super().readline(*args)
        if not self.swapped and '"source_ticket"' in line:
            self.swapped = True
            self.swap()
        return line


FINAL = {"kind": "final", "payload": {"title": "t", "answer": "a", "items": []}}
READ = {"kind": "lookup", "lookup": {"kind": "read", "args": {"path": "a.js", "start": 1, "end": 2}}}


def start(**over):
    frame = {"v": 1, "id": "req1", "type": "start", "seq": 0, "mode": "ask", "profile": "throwaway-profile",
             "graph_digest": "dig", "instructions": "Answer.", "schema": {}, "question": "What?",
             "history": [], "overview": {"project": "Shop"}}
    frame.update(over)
    return frame


class AskTest(unittest.TestCase):
    def setUp(self):
        self.runner = load_plugin() and importlib.import_module("hermes_plugins.floorplan.hermes.runner")
        self.dir = tempfile.TemporaryDirectory()
        self.root = self.dir.name

    def tearDown(self):
        self.dir.cleanup()

    def write(self, name, text, encoding="utf-8"):
        path = Path(self.root, name)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding=encoding)
        return path

    def frames(self, name, *, start=1, end=2, redact=(), sha=None, lookup_id="req1-0", mode="ask"):
        """The worker's view of one read: classify, a ticket for those bytes, then its redacted window."""
        p = name
        text = ""
        src = Path(self.root, p)
        if src.is_file():
            lines = src.read_text().split("\n")
            for n in redact:
                lines[n - 1] = "[redacted: known secret]"
            text = "\n".join(lines[start - 1:end])
        return [
            {"v": 1, "id": "req1", "type": "classify_read", "seq": 1, "lookup_id": lookup_id, "path": p},
            {"v": 1, "id": "req1", "type": "source_ticket", "seq": 2, "lookup_id": lookup_id, "path": p,
             "root_digest": ROOT_DIGEST(self.root), "mode": mode, "sha256": sha or SHA(Path(self.root, p)),
             "start": start, "end": end, "redact_lines": list(redact), "byte_limit": 32768},
            {"v": 1, "id": "req1", "type": "lookup_result", "seq": 3, "lookup_id": lookup_id, "ok": True, "text": text},
        ]

    def run_ask(self, frames, decisions, *, profile="throwaway-profile", raw=None, now=time.monotonic, root=None,
                swap=None):
        llm = FakeLlm(decisions)
        ctx = types.SimpleNamespace(profile_name=profile, llm=llm)
        text = raw if raw is not None else "".join(json.dumps(f) + "\n" for f in frames)
        out = io.StringIO()
        stream = SwappingStdin(text, swap) if swap else io.StringIO(text)
        code = self.runner.ask(ctx=ctx, profile=profile, root=root or self.root, stdin=stream,
                               stdout=out, now=now)
        frames_out = [json.loads(line) for line in out.getvalue().splitlines() if line.strip()]
        return code, frames_out, llm

    @staticmethod
    def kinds(frames_out):
        return [f["type"] for f in frames_out]

    def test_a_question_answers_from_the_plugin_llm(self):
        code, out, llm = self.run_ask([start()], [FINAL])
        self.assertEqual(code, 0)
        self.assertEqual(self.kinds(out), ["ready", "result"])
        result = out[-1]
        self.assertEqual(result["payload"]["title"], "t")
        self.assertEqual((result["provider"], result["model"], result["profile"]), ("test-prov", "test-model", "throwaway-profile"))
        self.assertEqual(llm.calls[0]["purpose"], "floorplan-ask")
        self.assertLessEqual(llm.calls[0]["timeout"], 60)
        self.assertIn("What?", llm.calls[0]["text"])

    def test_a_read_is_classified_hashed_redacted_and_extracted_from_the_same_buffer(self):
        self.write("a.js", "const one = 1;\nconst KEY = 'FAKE_SECRET_xyz';\nconst three = 3;")
        code, out, _ = self.run_ask([start(), *self.frames("a.js", end=3, redact=[2])], [READ, FINAL])
        self.assertEqual(code, 0)
        self.assertEqual(self.kinds(out), ["ready", "lookup", "source_bytes", "lookup_result", "progress", "result"])
        source = out[2]
        self.assertTrue(source["ok"])
        self.assertEqual(source["sha256"], SHA(Path(self.root, "a.js")))
        progress = out[4]["text"]
        self.assertIn("Reading", progress)

    def test_the_returned_text_is_the_redacted_ticket_window(self):
        self.write("a.js", "one\nSECRET_LINE\ntwo")
        _, out, llm = self.run_ask([start(), *self.frames("a.js", end=3, redact=[2])], [READ, FINAL])
        self.assertEqual(out[0]["type"], "ready")
        ticket_reply = out[3]
        self.assertEqual(ticket_reply["type"], "lookup_result")
        self.assertTrue(ticket_reply["ok"])
        self.assertEqual(ticket_reply["text"], "one\n[redacted: known secret]\ntwo")
        self.assertNotIn("SECRET_LINE", json.dumps(out))
        # the redacted window is what the next completion input carries
        self.assertIn("[redacted: known secret]", llm.calls[1]["text"])
        self.assertNotIn("SECRET_LINE", llm.calls[1]["text"])

    def test_version_and_frame_order_are_refused(self):
        for bad, why in [([start(v=2)], "bad_version"), ([{"v": 1, "id": "req1", "type": "lookup", "seq": 0}], "frame_order")]:
            code, out, _ = self.run_ask(bad, [FINAL])
            self.assertEqual((code, out[-1]["type"], out[-1]["code"]), (1, "failure", "cli_error"), why)
        code, out, _ = self.run_ask([], [FINAL], raw="{oops\n")
        self.assertEqual((code, out[-1]["type"]), (1, "failure"))

    def test_an_out_of_schema_decision_ends_the_request(self):
        for bad in [{"kind": "chat"}, {"kind": "lookup", "lookup": {"kind": "shell", "args": {}}},
                    {"kind": "lookup", "lookup": {"kind": "read"}}, {"kind": "final", "payload": "nope"}]:
            code, out, _ = self.run_ask([start()], [bad])
            self.assertEqual((code, out[-1]["code"]), (1, "cli_error"), bad)

    def test_a_decision_with_stray_text_after_it_still_counts(self):
        # a route that can't enforce the schema (the host then leaves parsed empty) lets the model trail text
        # after a valid decision; seen live as `...}</index>` and `...}\n\n<system_warning>...`
        self.write("a.js", "const one = 1;\nconst two = 2;")
        code, out, _ = self.run_ask([start(), *self.frames("a.js")],
                                    [json.dumps(READ) + "</index>", json.dumps(FINAL) + "\n\n<system_warning>x</system_warning>"])
        self.assertEqual(code, 0)
        self.assertEqual(self.kinds(out), ["ready", "lookup", "source_bytes", "lookup_result", "progress", "result"])
        self.assertEqual(out[-1]["payload"]["title"], "t")

    def test_a_reply_without_a_valid_decision_is_still_refused(self):
        for raw in ["I can't answer that.", "[1, 2]", '{"kind": "final", "payload": "nope"} and more']:
            code, out, _ = self.run_ask([start()], [raw])
            self.assertEqual((code, out[-1]["code"], out[-1].get("message")), (1, "cli_error", "invalid_decision"), raw)

    def test_a_profile_mismatch_is_typed(self):
        code, out, _ = self.run_ask([start(profile="someone-else")], [FINAL])
        self.assertEqual((code, out[-1]["type"], out[-1]["code"]), (1, "failure", "profile_mismatch"))

    def test_a_start_without_the_profile_flag_carries_the_probed_profile(self):
        # serve.mjs started without --profile sends the profile the probe named, not an empty string
        payload = self.runner.probe_payload(profile="default-profile", plugin_version="9.9.9-test",
                                            skill_path=REPO / "skills" / "floorplan" / "SKILL.md")
        self.assertEqual(payload["profile"], "default-profile")
        code, out, _ = self.run_ask([start(profile=payload["profile"])], [FINAL], profile=payload["profile"])
        self.assertEqual((code, self.kinds(out)), (0, ["ready", "result"]))

    def test_a_symlink_in_any_component_is_refused_and_never_followed(self):
        Path(self.root, "outside").mkdir()
        Path(self.root, "outside", "canary.txt").write_text("CANARY_OUTSIDE")
        os.symlink(Path(self.root, "outside"), Path(self.root, "link"))
        code, out, _ = self.run_ask([start(), *self.frames("link/canary.txt")], [READ, FINAL])
        self.assertEqual(code, 0)
        self.assertEqual((out[2]["type"], out[2]["ok"], out[2]["reason"]), ("source_bytes", False, "symlink"))
        self.assertNotIn("CANARY_OUTSIDE", json.dumps(out))

    def test_a_file_swapped_for_a_symlink_between_classify_and_ticket_is_denied(self):
        self.write("a.js", "const a = 1;")
        Path(self.root, "canary.txt").write_text("CANARY_SWAPPED")

        def swap():
            os.remove(Path(self.root, "a.js"))
            os.symlink(Path(self.root, "canary.txt"), Path(self.root, "a.js"))

        code, out, _ = self.run_ask([start(), *self.frames("a.js")], [READ, FINAL], swap=swap)
        self.assertEqual(code, 0)
        self.assertEqual((out[3]["ok"], out[3]["reason"]), (False, "symlink"))
        self.assertNotIn("CANARY_SWAPPED", json.dumps(out))

    def test_a_fifo_and_an_oversized_file_are_refused_without_blocking(self):
        os.mkfifo(Path(self.root, "pipe"))
        # a FIFO has no bytes to hash: the classify step refuses it before any ticket is built
        code, out, _ = self.run_ask([start(), *self.frames("pipe", sha="0" * 64)], [READ, FINAL])
        self.assertEqual((out[2]["ok"], out[2]["reason"]), (False, "not_regular"))
        self.write("big.js", "x" * (512 * 1024 + 1))
        code, out, _ = self.run_ask([start(), *self.frames("big.js")], [READ, FINAL])
        self.assertEqual((out[2]["ok"], out[2]["reason"]), (False, "too_large"))

    def test_a_regular_file_swapped_after_classification_is_denied_and_the_canary_never_returns(self):
        self.write("a.js", "const a = 1;\nconst b = 2;")

        def swap():
            Path(self.root, "a.js").write_text("CANARY_REPLACED\n")

        code, out, _ = self.run_ask([start(), *self.frames("a.js")], [READ, FINAL], swap=swap)
        self.assertEqual((out[3]["ok"], out[3]["reason"]), (False, "changed"))
        self.assertNotIn("CANARY_REPLACED", json.dumps(out))

    def test_a_wrong_and_a_replayed_ticket_are_refused(self):
        self.write("a.js", "one\ntwo")
        wrong = self.frames("a.js", sha="0" * 64)
        code, out, _ = self.run_ask([start(), *wrong], [READ, FINAL])
        self.assertEqual((out[3]["ok"], out[3]["reason"]), (False, "ticket_mismatch"))
        replay = [
            {"v": 1, "id": "req1", "type": "source_ticket", "seq": 5, "lookup_id": "req1-0", "path": "a.js",
             "root_digest": ROOT_DIGEST(self.root), "mode": "ask", "sha256": SHA(Path(self.root, "a.js")),
             "start": 1, "end": 1, "redact_lines": [], "byte_limit": 32768},
            {"v": 1, "id": "req1", "type": "lookup_result", "seq": 7, "lookup_id": "req1-1", "ok": True, "data": {}},
        ]
        second = {"kind": "lookup", "lookup": {"kind": "read", "args": {"path": "a.js", "start": 1, "end": 1}}}
        code, out, _ = self.run_ask([start(), *self.frames("a.js"), *replay], [READ, second, FINAL])
        replay_denials = [f for f in out if f.get("code") == "lookup_denied" and f.get("reason") == "unknown_ticket"]
        self.assertEqual(len(replay_denials), 1)

    def test_a_ticket_without_redact_lines_is_refused_and_returns_no_text(self):
        self.write("a.js", "one\ntwo")
        scripted = self.frames("a.js")
        del scripted[1]["redact_lines"]  # a Node-side rename drops the key; redaction must not fail open
        scripted[2] = {"v": 1, "id": "req1", "type": "lookup_result", "seq": 3, "lookup_id": "req1-0",
                       "ok": False, "code": "lookup_denied", "reason": "changed"}
        code, out, llm = self.run_ask([start(), *scripted], [READ, FINAL])
        self.assertEqual((out[3]["ok"], out[3]["code"], out[3]["reason"]),
                         (False, "lookup_denied", "changed"))
        self.assertNotIn("text", out[3])
        self.assertNotIn("one\ntwo", llm.calls[1]["text"])

    def test_each_provider_error_maps_to_one_typed_failure(self):
        cases = [(PluginLlmTrustError("nope"), "model_override_denied"),
                 (RuntimeError("401 Unauthorized"), "not_logged_in"),
                 (RuntimeError("429 too many requests"), "rate_limited"),
                 (TimeoutError("deadline exceeded"), "timeout"),
                 (RuntimeError("boom"), "cli_error")]
        for exc, want in cases:
            code, out, _ = self.run_ask([start()], [exc])
            self.assertEqual((code, out[-1]["type"], out[-1]["code"]), (1, "failure", want), type(exc).__name__)

    def test_the_180_second_budget_ends_the_request_before_another_call(self):
        clock = iter([0.0, 181.0]).__next__
        code, out, llm = self.run_ask([start()], [FINAL], now=clock)
        self.assertEqual((code, out[-1]["code"]), (1, "timeout"))
        self.assertEqual(llm.calls, [])

    def test_change_mode_has_the_300_second_budget_and_binds_change_tickets(self):
        self.write("a.js", "one\ntwo")
        clock = iter([0.0, 181.0, 181.0, 181.0]).__next__
        code, out, llm = self.run_ask([start(mode="change"), *self.frames("a.js", mode="change")], [READ, FINAL], now=clock)
        self.assertEqual((code, out[-1]["type"]), (0, "result"))
        self.assertEqual(len(llm.calls), 2)

    def test_a_ticket_issued_for_another_mode_is_refused(self):
        self.write("a.js", "one\ntwo")
        code, out, llm = self.run_ask([start(mode="change"), *self.frames("a.js", mode="ask")], [READ, FINAL])
        self.assertEqual((out[3]["ok"], out[3]["reason"]), (False, "ticket_mismatch"))
        self.assertNotIn("one\ntwo", llm.calls[1]["text"])

    def test_an_unsupported_platform_refuses_before_reading(self):
        original = self.runner.SUPPORTED
        self.runner.SUPPORTED = False
        try:
            code, out, _ = self.run_ask([start()], [FINAL])
        finally:
            self.runner.SUPPORTED = original
        self.assertEqual((code, out[-1]["code"]), (1, "unsupported_runtime"))

    def test_the_confined_reader_refuses_traversal_and_absolute_paths(self):
        reader = self.runner.ConfinedReader(self.root)
        try:
            for bad in ("../x", "/etc/passwd", "a\\b", "a/../b", "", "a//b"):
                with self.assertRaises(self.runner.ReadError):
                    reader.read(bad)
        finally:
            reader.close()


if __name__ == "__main__":
    unittest.main()
