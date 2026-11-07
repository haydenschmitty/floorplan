"""`hermes floorplan …`: the model-free probe, and the bounded Ask worker.

The probe answers from the running process only: no model call, no network, no credential.

`ask` is the other half of the map server's Ask bar. It speaks newline-delimited JSON on its own
stdin/stdout and nothing else, calls `ctx.llm.complete_structured` for one decision at a time, and
reads source only through `Boundary`'s single-use tickets: a POSIX `dir_fd` walk, `O_NOFOLLOW` on
every component, one bounded buffer whose SHA-256 is checked before redaction or extraction.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import platform
import stat
import sys
import time
from pathlib import Path

PLUGIN = "floorplan"
SKILL_NAME = "floorplan"
PROTOCOL = 1  # the CLI/probe contract; `ask` extends it rather than replacing it
PLUGIN_ROOT = Path(__file__).resolve().parents[1]

MAX_RAW = 512 * 1024
MAX_FRAME = 1024 * 1024
MAX_DECISIONS = 8
MAX_LOOKUPS = 7
MAX_QUESTION = 4000
CALL_SECONDS = 60
DEADLINE_SECONDS = 180  # Ask and a guided flow
CHANGE_DEADLINE_SECONDS = 300  # a complete Change, including its one validation retry
REDACTED = "[redacted: known secret]"

SUPPORTED = os.name == "posix" and hasattr(os, "O_NOFOLLOW") and os.open in os.supports_dir_fd

DECISION_SCHEMA = {
    "type": "object",
    "properties": {
        "kind": {"type": "string", "enum": ["lookup", "final"]},
        "lookup": {
            "type": "object",
            "properties": {
                "kind": {"type": "string", "enum": ["overview", "find", "show", "path", "read", "search"]},
                # the boundary's own argument names (hermes-boundary.mjs), which also checks their bounds
                "args": {"type": "object", "properties": {
                    "words": {"type": "string"}, "kind": {"type": "string", "enum": ["module", "file", "endpoint", "symbol"]},
                    "limit": {"type": "integer"}, "id": {"type": "string"}, "from": {"type": "string"},
                    "to": {"type": "string"}, "path": {"type": "string"}, "start": {"type": "integer"},
                    "end": {"type": "integer"}, "text": {"type": "string"}}, "additionalProperties": False},
            },
            "required": ["kind", "args"],
            "additionalProperties": False,
        },
        "payload": {"type": "object"},  # replaced per request by the payload schema the server sent
    },
    "required": ["kind"],
    "additionalProperties": False,
}

LOOKUP_KINDS = ("overview", "find", "show", "path", "read", "search")


def skill_dir(skill_path) -> Path:
    """The folder of the SKILL.md this plugin registered, refusing anything outside the install."""
    directory = Path(skill_path).resolve().parent
    if not directory.is_relative_to(PLUGIN_ROOT):
        raise ValueError("skill_outside_plugin")
    return directory


def probe_payload(*, profile: str, plugin_version: str = "", skill_path=None) -> dict:
    """What this install is. Safe to print: names and versions, never a secret or a setting."""
    return {
        "plugin": PLUGIN,
        "plugin_version": plugin_version,
        "protocol": PROTOCOL,
        "profile": profile,
        "skill": f"{PLUGIN}:{SKILL_NAME}",
        "skill_dir": str(skill_dir(skill_path)),
        "commands": [PLUGIN],
        "python": {"implementation": platform.python_implementation(), "version": platform.python_version()},
        "os": {"system": platform.system(), "release": platform.release(), "machine": platform.machine()},
        "ask": "ready" if SUPPORTED else "unsupported_runtime",
    }


def setup_cli(parser) -> None:
    """`hermes floorplan probe` and `hermes floorplan ask`."""
    commands = parser.add_subparsers(dest="floorplan_command", required=True)
    commands.add_parser("probe", help="Print what this Floorplan install registered (no model calls)")
    ask = commands.add_parser("ask", help="Answer one map question over newline-delimited JSON")
    ask.add_argument("--root", default=None, help="The project root the map was built from")


def probe(args, *, profile: str, plugin_version: str = "", skill_path=None, ctx=None) -> int:
    """One handler for both subcommands: JSON on stdout for probe, the NDJSON worker for ask."""
    if getattr(args, "floorplan_command", None) == "ask":
        if ctx is None:
            print(json.dumps({"plugin": PLUGIN, "error": "cli_error"}, sort_keys=True))
            return 2
        return ask(ctx=ctx, profile=profile, root=getattr(args, "root", None) or os.getcwd())
    try:
        payload = probe_payload(profile=profile, plugin_version=plugin_version, skill_path=skill_path)
    except ValueError as exc:
        print(json.dumps({"plugin": PLUGIN, "error": str(exc)}, sort_keys=True))
        return 2
    print(json.dumps(payload, indent=2, sort_keys=True))
    return 0


# ---------- the confined reader ----------
class ReadError(Exception):
    """A read the boundary refused or could not make. `reason` is the typed code Node sees."""

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


class ConfinedReader:
    """Reads below one pinned root: no symlink, no FIFO, no `..`, one regular file at a time."""

    def __init__(self, root):
        self.root = os.path.realpath(root)
        self.root_digest = hashlib.sha256(self.root.encode("utf-8")).hexdigest()
        flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | os.O_NOFOLLOW
        self.fd = os.open(self.root, flags)

    def close(self):
        try:
            os.close(self.fd)
        except OSError:
            pass

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()

    def read(self, rel, limit=MAX_RAW) -> bytes:
        if not isinstance(rel, str) or not rel or len(rel) > 1024:
            raise ReadError("invalid_path")
        if rel.startswith("/") or "\\" in rel or "\0" in rel:
            raise ReadError("invalid_path")
        parts = rel.split("/")
        if any(p in ("", ".", "..") for p in parts):
            raise ReadError("invalid_path")
        fd = self.fd
        opened = False
        try:
            for part in parts[:-1]:
                try:
                    nxt = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                except OSError as exc:
                    raise ReadError(_reason(exc)) from exc
                if opened:
                    os.close(fd)
                fd, opened = nxt, True
            try:
                f = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
            except OSError as exc:
                raise ReadError(_reason(exc)) from exc
            try:
                st = os.fstat(f)
                if not stat.S_ISREG(st.st_mode):
                    raise ReadError("not_regular")
                if st.st_size > limit:
                    raise ReadError("too_large")
                chunks, total = [], 0
                while True:
                    block = os.read(f, min(65536, limit + 1 - total))
                    if not block:
                        break
                    total += len(block)
                    if total > limit:
                        raise ReadError("too_large")
                    chunks.append(block)
            finally:
                os.close(f)
            return b"".join(chunks)
        finally:
            if opened:
                os.close(fd)


def _reason(exc: OSError) -> str:
    import errno

    if exc.errno in (errno.ELOOP, errno.EMLINK):
        return "symlink"
    if exc.errno == errno.ENOTDIR:
        return "symlink"
    if exc.errno == errno.ENOENT:
        return "not_found"
    if exc.errno in (errno.EACCES, errno.EPERM):
        return "denied"
    return "unreadable"


# ---------- the worker ----------
class ProtocolError(Exception):
    """A frame the worker cannot accept; the request ends with `cli_error`."""


class Deadline(Exception):
    """The 180 s Ask budget ran out; the request ends with `timeout`."""


class _Session:
    def __init__(self, *, ctx, profile, root, stdin, stdout, now):
        self.ctx = ctx
        self.profile = profile
        self.root = root
        self.stdin = stdin
        self.stdout = stdout
        self.now = now
        self.deadline = None
        self.seq = 0
        self.lookup_seq = 0
        self.lookups = 0
        self.results = []
        self.pending = {}
        self.used = set()
        self.req_id = ""
        self.mode = "ask"
        self.payload_keys = ()
        self.decision_schema = DECISION_SCHEMA
        self.reader = None

    # -- framing --
    def send(self, frame: dict) -> None:
        frame = {"v": PROTOCOL, "id": self.req_id, "seq": self.seq, **frame}
        self.seq += 1
        self.stdout.write(json.dumps(frame, sort_keys=True) + "\n")
        self.stdout.flush()

    def recv(self, *, expect_id: bool = True) -> dict:
        line = self.stdin.readline()
        if not line:
            raise ProtocolError("closed")
        if len(line.encode("utf-8")) > MAX_FRAME:
            raise ProtocolError("frame_too_large")
        try:
            frame = json.loads(line)
        except (json.JSONDecodeError, ValueError) as exc:
            raise ProtocolError("bad_json") from exc
        if not isinstance(frame, dict) or frame.get("v") != PROTOCOL:
            raise ProtocolError("bad_version")
        if expect_id and frame.get("id") != self.req_id:
            raise ProtocolError("id_mismatch")
        if not isinstance(frame.get("type"), str):
            raise ProtocolError("bad_type")
        return frame

    def fail(self, code: str, message: str = "") -> int:
        try:
            self.send({"type": "failure", "code": code, **({"message": message[:300]} if message else {})})
        except Exception:
            pass
        return 1

    # -- start --
    def start_frame(self) -> dict:
        first = self.recv(expect_id=False)
        if first.get("type") != "start":
            raise ProtocolError("frame_order")
        req = first.get("id")
        if not isinstance(req, str) or not 1 <= len(req) <= 64:
            raise ProtocolError("bad_id")
        self.req_id = req
        if first.get("mode") not in ("ask", "flow", "change"):
            raise ProtocolError("bad_mode")
        self.mode = first["mode"]
        if not isinstance(first.get("instructions"), str) or not isinstance(first.get("schema"), dict):
            raise ProtocolError("bad_start")
        if not isinstance(first.get("question"), str) or len(first["question"]) > MAX_QUESTION:
            raise ProtocolError("bad_question")
        history = first.get("history") or []
        if not isinstance(history, list) or len(history) > 4:
            raise ProtocolError("bad_history")
        if not isinstance(first.get("profile"), str):
            raise ProtocolError("bad_profile")
        if first["profile"] != self.profile:
            raise ProtocolError("profile_mismatch")
        return first

    def run(self) -> int:
        try:
            start = self.start_frame()
        except ProtocolError as exc:
            code = "profile_mismatch" if str(exc) == "profile_mismatch" else "cli_error"
            return self.fail(code, str(exc))
        except Deadline:
            return self.fail("timeout")
        if not SUPPORTED:
            return self.fail("unsupported_runtime")
        if getattr(self.ctx, "profile_name", self.profile) != self.profile:
            return self.fail("profile_mismatch")
        try:
            self.reader = ConfinedReader(self.root)
        except OSError as exc:
            return self.fail("cli_error", f"root: {_reason(exc)}")
        self.deadline = self.now() + (CHANGE_DEADLINE_SECONDS if self.mode == "change" else DEADLINE_SECONDS)
        try:
            self.send({"type": "ready", "profile": self.profile, "plugin": PLUGIN, "protocol": PROTOCOL})
            return self.decide(start)
        except Deadline:
            return self.fail("timeout")
        except ProtocolError as exc:
            return self.fail("cli_error", str(exc))
        finally:
            self.reader.close()

    # -- the decision loop --
    def decide(self, start: dict) -> int:
        question = start["question"]
        overview = json.dumps(start.get("overview"), sort_keys=True)[:20000]
        history = start.get("history") or []
        # the payload's own required keys: a reply that is just the payload still counts as the final decision
        self.payload_keys = tuple(k for k in start["schema"].get("required") or () if isinstance(k, str))
        self.decision_schema = _decision_schema(start["schema"])
        base = [start["instructions"],
                "Answer with one JSON decision: {\"kind\":\"lookup\",\"lookup\":{\"kind\",\"args\"}} to look "
                "something up, or {\"kind\":\"final\",\"payload\":{…}} when you can answer. Look up only what "
                "you need; you have at most 7 lookups.",
                "The map overview:\n" + overview]
        if history:
            earlier = "\n\n".join(f"Q: {str(t.get('q', ''))[:500]}\nA: {str(t.get('a', ''))[:1500]}" for t in history[-4:])
            base.append("Earlier in this conversation:\n" + earlier)
        for _ in range(MAX_DECISIONS):
            remaining = self.deadline - self.now()
            if remaining <= 0:
                raise Deadline()
            seen = json.dumps(self.results, sort_keys=True) if self.results else "(nothing yet)"
            text = "\n\n".join(base + ["What you have looked up so far:\n" + seen[-20000:], "The question:\n" + question])
            result = self.complete(text, remaining)
            decision = self.decision(result)
            if decision[0] == "final":
                self.send({"type": "result", "payload": decision[1], "provider": getattr(result, "provider", ""),
                           "model": getattr(result, "model", ""), "profile": self.profile})
                return 0
            lookup_id = self.send_lookup(decision[1], decision[2])
            outcome = self.await_lookup(lookup_id)
            self.results.append({"lookup": decision[1], "result": _visible(outcome)})
            self.send({"type": "progress", "text": _progress(decision[1], decision[2], outcome)})
        raise ProtocolError("decision_ceiling")

    def complete(self, text: str, remaining: float):
        timeout = max(1.0, min(CALL_SECONDS, remaining))
        try:
            from agent.plugin_llm import PluginLlmTextInput

            inputs = [PluginLlmTextInput(text=text)]
        except Exception:  # the host package is absent outside Hermes; a dict block is the same shape
            inputs = [{"type": "text", "text": text}]
        try:
            # the schema, not bare JSON mode: providers that enforce or project a schema (OpenAI, the Claude
            # subscription provider) take it, and some refuse JSON-object-only mode. A route that can't take
            # it gets the request without one; decision() then digs the decision out of the reply text.
            return self.ctx.llm.complete_structured(instructions="Floorplan map assistant.", input=inputs,
                                                    json_schema=self.decision_schema, timeout=timeout,
                                                    purpose="floorplan-ask")
        except Exception as exc:
            raise _mapped(exc)

    def decision(self, result):
        parsed = getattr(result, "parsed", None)
        candidates = [parsed] if isinstance(parsed, dict) else _json_objects(getattr(result, "text", None))
        for candidate in candidates:
            found = _as_decision(candidate, self.payload_keys)
            if found:
                return found
        raise ProtocolError("invalid_decision")

    def send_lookup(self, kind: str, args: dict) -> str:
        self.lookups += 1
        if self.lookups > MAX_LOOKUPS:
            raise ProtocolError("lookup_ceiling")
        lookup_id = f"{self.req_id}-{self.lookup_seq}"
        self.lookup_seq += 1
        self.send({"type": "lookup", "lookup_id": lookup_id, "lookup": {"kind": kind, "args": args}})
        return lookup_id

    def await_lookup(self, lookup_id: str) -> dict:
        while True:
            frame = self.recv()
            kind = frame.get("type")
            if kind == "classify_read":
                self.classify(frame)
            elif kind == "source_ticket":
                self.ticket(frame)
            elif kind == "lookup_result":
                if frame.get("lookup_id") != lookup_id:
                    raise ProtocolError("lookup_mismatch")
                return frame
            elif kind == "cancel":
                raise ProtocolError("cancelled")
            else:
                raise ProtocolError("frame_order")

    def classify(self, frame: dict) -> None:
        assert self.reader is not None
        lookup_id, rel = frame.get("lookup_id"), frame.get("path")
        if lookup_id in self.used:
            self.send({"type": "source_bytes", "lookup_id": lookup_id, "path": rel, "ok": False, "reason": "unknown_ticket"})
            return
        try:
            buf = self.reader.read(rel)
        except ReadError as exc:
            self.send({"type": "source_bytes", "lookup_id": lookup_id, "path": rel, "ok": False, "reason": exc.reason})
            return
        self.pending[lookup_id] = (rel, hashlib.sha256(buf).hexdigest())
        self.send({"type": "source_bytes", "lookup_id": lookup_id, "path": rel, "ok": True,
                   "sha256": self.pending[lookup_id][1], "bytes_base64": base64.b64encode(buf).decode("ascii")})

    def ticket(self, frame: dict) -> None:
        assert self.reader is not None
        lookup_id = frame.get("lookup_id")
        pending = self.pending.get(lookup_id)
        deny = None
        if pending is None or lookup_id in self.used:
            deny = "unknown_ticket"
        elif (frame.get("path") != pending[0] or frame.get("sha256") != pending[1]
              or frame.get("root_digest") != self.reader.root_digest or frame.get("mode") != self.mode):
            deny = "ticket_mismatch"
        if deny:
            self.send({"type": "lookup_result", "lookup_id": lookup_id, "ok": False, "code": "lookup_denied", "reason": deny})
            return
        self.used.add(lookup_id)
        rel, expected = pending
        try:
            buf = self.reader.read(rel)
        except ReadError as exc:
            self.send({"type": "lookup_result", "lookup_id": lookup_id, "ok": False, "code": "lookup_denied", "reason": exc.reason})
            return
        actual = hashlib.sha256(buf).hexdigest()
        if actual != expected:  # the file changed after classification: no new bytes reach the model
            self.send({"type": "lookup_result", "lookup_id": lookup_id, "ok": False, "code": "lookup_denied", "reason": "changed"})
            return
        outcome = _extract(buf, frame)
        self.send({"type": "lookup_result", "lookup_id": lookup_id, "sha256": actual, **outcome})


def _extract(buf: bytes, frame: dict) -> dict:
    """Redacts and slices the *same* verified buffer; never reopens for extraction."""
    try:
        text = buf.decode("utf-8")
    except UnicodeDecodeError:
        return {"ok": False, "code": "lookup_denied", "reason": "decode"}
    if "\0" in text:
        return {"ok": False, "code": "lookup_denied", "reason": "binary"}
    lines = text.split("\n")
    redact = frame.get("redact_lines")
    if not isinstance(redact, list) or any(not isinstance(n, int) or n < 1 or n > len(lines) for n in redact):
        return {"ok": False, "code": "lookup_denied", "reason": "changed"}
    start, end = frame.get("start"), frame.get("end")
    if not isinstance(start, int) or not isinstance(end, int) or start < 1 or end < start:
        return {"ok": False, "code": "lookup_denied", "reason": "changed"}
    for n in redact:
        lines[n - 1] = REDACTED
    out = "\n".join(lines[start - 1:end])
    limit = frame.get("byte_limit")
    if isinstance(limit, int) and len(out.encode("utf-8")) > limit:
        return {"ok": False, "code": "lookup_denied", "reason": "too_large"}
    return {"ok": True, "text": out}


def _visible(outcome: dict) -> dict:
    """What the next completion input carries for one lookup: its data, its text, or the denial."""
    if not outcome.get("ok"):
        return {"denied": outcome.get("reason") or outcome.get("code")}
    return outcome["data"] if "data" in outcome else {"text": outcome.get("text", "")}


def _progress(kind: str, args: dict, outcome: dict) -> str:
    where = args.get("path") or args.get("words") or args.get("id") or args.get("text") or ""
    words = {"overview": "Reading the map overview", "find": f'Searching the map for "{where}"',
             "show": f"Looking at {where}", "path": f"Tracing a path through {where}",
             "read": f"Reading {where}", "search": f'Searching the code for "{where}"'}
    label = words.get(kind, "Looking something up")
    return label if outcome.get("ok") else f"{label}: not available"


def _closed(node):
    """A copy of a JSON schema in which every object says `additionalProperties: false`: Anthropic's structured
    output (the Claude subscription provider projects the schema onto it) refuses an object that doesn't."""
    if not isinstance(node, dict):
        return node
    out = dict(node)
    if isinstance(out.get("properties"), dict):
        out["properties"] = {name: _closed(sub) for name, sub in out["properties"].items()}
    if isinstance(out.get("items"), dict):
        out["items"] = _closed(out["items"])
    if out.get("type") == "object":
        out.setdefault("additionalProperties", False)
    return out


def _decision_schema(payload_schema: dict) -> dict:
    """The schema sent with each decision: DECISION_SCHEMA with this request's payload schema in place, closed."""
    schema = json.loads(json.dumps(DECISION_SCHEMA))
    schema["properties"]["payload"] = payload_schema if payload_schema else {"type": "object"}
    return _closed(schema)


def _json_objects(text) -> list:
    """Every top-level JSON object in a reply, in order. A route that can't enforce JSON lets the model wrap
    a valid decision in other text (`...}</index>`, an echoed result first, raw newlines inside a string);
    each object found is still checked like any other decision."""
    if not isinstance(text, str):
        return []
    decoder, found, i = json.JSONDecoder(strict=False), [], text.find("{")
    while i != -1:
        try:
            value, end = decoder.raw_decode(text, i)
        except ValueError:
            i = text.find("{", i + 1)
            continue
        if isinstance(value, dict):
            found.append(value)
        i = text.find("{", end)
    return found


def _as_decision(d: dict, payload_keys: tuple):
    """("final", payload) or ("lookup", kind, args) when `d` is a decision, else None."""
    kind = d.get("kind")
    if kind == "final":
        return ("final", d["payload"]) if isinstance(d.get("payload"), dict) else None
    if kind == "lookup":
        lookup = d.get("lookup")
        if isinstance(lookup, dict) and lookup.get("kind") in LOOKUP_KINDS and isinstance(lookup.get("args"), dict):
            return ("lookup", lookup["kind"], lookup["args"])
        return None
    # no wrapper at all, just the payload: the final answer, if it has every key the payload requires
    if kind is None and payload_keys and all(k in d for k in payload_keys):
        return ("final", d)
    return None


def _mapped(exc: Exception) -> Exception:
    """Typed failure mapping: trust, sign-in, rate limit, deadline, then everything else."""
    name = type(exc).__name__
    if name == "PluginLlmTrustError" or isinstance(exc, PermissionError):
        return _Failure("model_override_denied")
    text = str(exc).lower()
    if "deadline" in name.lower() or isinstance(exc, (TimeoutError, Deadline)):
        return _Failure("timeout")
    if "timeout" in text or "timed out" in text:
        return _Failure("timeout")
    if "401" in text or "unauthor" in text or "not logged in" in text or "sign in" in text:
        return _Failure("not_logged_in")
    if "429" in text or "rate limit" in text or "too many requests" in text:
        return _Failure("rate_limited")
    return _Failure("cli_error")


class _Failure(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def ask(*, ctx, profile: str, root=None, stdin=None, stdout=None, now=time.monotonic) -> int:
    """Runs one Ask request to completion. Returns the process exit code."""
    session = _Session(ctx=ctx, profile=profile, root=root or os.getcwd(),
                       stdin=stdin or sys.stdin, stdout=stdout or sys.stdout, now=now)
    try:
        return session.run()
    except _Failure as exc:
        return session.fail(exc.code)


if __name__ == "__main__":  # `python3 -m hermes.runner` is not a supported entry point
    sys.exit("run `hermes floorplan probe` instead")
