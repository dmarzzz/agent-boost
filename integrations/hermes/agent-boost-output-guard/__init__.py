"""Hermes final-response adapter for Agent Boost.

This is a supported native Hermes plugin. It keeps ephemeral rendering state
in memory, trusts only vendor metadata on an actual Agent Boost MCP result,
and invokes the Agent Boost turn gate at the native pre-LLM boundary where
Hermes exposes fork provenance. It exposes no model-facing tools.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import stat
import subprocess
import tempfile
import threading
import time
from collections.abc import Mapping
from typing import Any, Dict, Optional


_OUTPUT_META_KEY = "org.agentboost/user-facing-output"
_TURN_GATE_STATE_SCHEMA = "org.agentboost.hermes-turn-gate"
_TURN_GATE_STATE_VERSION = 1
_TURN_GATE_STATE_DIRECTORY = "agent-boost-turn-gate-v1"
_MAX_SESSIONS = 512
_MAX_RENDERED_CHARS = 12_000
_MAX_GATE_STATE_BYTES = 64 * 1024
_MAX_BINDING_ENTRIES = 12
_MAX_BINDING_STRING_CHARS = 512
_TURN_GATE_TIMEOUT_SECONDS = 5
_MAX_TURN_GATE_OUTPUT_BYTES = 64 * 1024
_NESTED_FORK_TTL_MS = 30 * 60 * 1000
_AUXILIARY_ORIGINS = frozenset({"background_review", "side_question"})
_LOCK = threading.Lock()
_TURNS: Dict[str, Dict[str, Any]] = {}
_FORK_TURNS: Dict[tuple[str, str], int] = {}
_LOGGER = logging.getLogger(__name__)

_CONFIRMATION_TOOLS = frozenset({
    "wallet_apply_saved_profile_load",
    "wallet_apply_reauthorization",
    "wallet_apply_policy_update",
    "wallet_apply_private_balance_create",
    "wallet_apply_private_balance_fund",
    "wallet_apply_private_balance_policy_update",
    "wallet_execute_regular_transfer",
    "wallet_execute_private_transfer",
    "wallet_execute_recovery_transfer",
    "wallet_create",
    "wallet_adopt_existing",
    "wallet_archive",
    "wallet_start_new_demo",
})
_DECISION_ID_TOOLS = frozenset({
    "wallet_apply_reauthorization",
    "wallet_apply_policy_update",
    "wallet_apply_private_balance_create",
    "wallet_apply_private_balance_fund",
    "wallet_apply_private_balance_policy_update",
    "wallet_execute_regular_transfer",
    "wallet_execute_private_transfer",
    "wallet_execute_recovery_transfer",
})
_STATUS_READ_TOOLS = frozenset({
    "onboarding_status",
    "wallet_get_tree",
    "wallet_get_private_balance_operation",
    "wallet_get_private_transfer_request",
    "wallet_get_recovery_request",
    "wallet_get_regular_transfer_request",
})
_STATUS_RESULT_CODES = {
    "onboarding_status": "ONBOARDING_STATUS",
    "wallet_get_tree": "WALLET_TREE",
    "wallet_get_private_balance_operation": "PRIVATE_BALANCE_OPERATION_STATUS",
    "wallet_get_private_transfer_request": "PAYMENT_STATUS",
    "wallet_get_recovery_request": "RECOVERY_STATUS",
    "wallet_get_regular_transfer_request": "REGULAR_TRANSFER_STATUS",
}
_ALLOW_MODE_TRANSFER_RESULTS = {
    "wallet_execute_regular_transfer": {
        "status_tool": "wallet_get_regular_transfer_request",
        "request_prefix": "rreq",
        "result_codes": frozenset({
            "REGULAR_TRANSFER_REQUEST",
            "REGULAR_TRANSFER_STATUS",
        }),
        "no_effect_code": "REGULAR_TRANSFER_CONFIRMATION_REQUIRED",
    },
    "wallet_execute_private_transfer": {
        "status_tool": "wallet_get_private_transfer_request",
        "request_prefix": "req",
        "result_codes": frozenset({"PAYMENT_REQUEST", "PAYMENT_STATUS"}),
        "no_effect_code": "PAYMENT_CONFIRMATION_REQUIRED",
    },
    "wallet_execute_recovery_transfer": {
        "status_tool": "wallet_get_recovery_request",
        "request_prefix": "wrr",
        "result_codes": frozenset({"RECOVERY_REQUEST", "RECOVERY_STATUS"}),
        "no_effect_code": "RECOVERY_CONFIRMATION_REQUIRED",
    },
}
_PRIVATE_READY_FOLLOWUP_TOOLS = frozenset({
    "mcp__agent_boost__capabilities",
    "mcp__agent_boost__wallet_get_tree",
})
_STATE_DIGEST = re.compile(r"^[0-9a-f]{64}$")
_MANIFEST_DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
_BINDING_KEY = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
_BLOCKED_CONFIRMATION_TOOL_RESULT = json.dumps({
    "error": (
        "Agent Boost blocked this tool because the current user turn is bound "
        "to one exact wallet confirmation. No unrelated action was run."
    )
}, separators=(",", ":"))
_BLOCKED_ALLOW_DISPATCH_TOOL_RESULT = json.dumps({
    "error": (
        "Agent Boost already dispatched this turn's one exact allow-policy "
        "transfer. No duplicate or unrelated Agent Boost call was run; wait "
        "for a new user message so the original status-recovery handle stays "
        "authoritative."
    )
}, separators=(",", ":"))
_BLOCKED_COMPLETED_TURN_TOOL_RESULT = json.dumps({
    "error": (
        "Agent Boost already completed this wallet turn. No additional tool "
        "was run; wait for a new user message."
    )
}, separators=(",", ":"))
_BLOCKED_STATUS_ROUTE_TOOL_RESULT = json.dumps({
    "error": (
        "Agent Boost pinned this turn to one exact fresh status read. The "
        "different tool was blocked and no wallet action was run."
    )
}, separators=(",", ":"))
_BLOCKED_STATUS_AFTER_READ_TOOL_RESULT = json.dumps({
    "error": (
        "Agent Boost already performed this turn's one permitted status read. "
        "No duplicate read or unrelated wallet action was run."
    )
}, separators=(",", ":"))
_BLOCKED_STATUS_CLARIFICATION_TOOL_RESULT = json.dumps({
    "error": (
        "Agent Boost has no trusted setup or operation to check in this turn. "
        "No Agent Boost tool was run."
    )
}, separators=(",", ":"))
_BLOCKED_NESTED_FORK_TOOL_RESULT = json.dumps({
    "error": (
        "Agent Boost blocked this wallet tool because it came from a nested "
        "Hermes review or side question, not the root user turn. No wallet "
        "action was run and no confirmation authority was consumed."
    )
}, separators=(",", ":"))
_STATUS_CLARIFICATION_RESPONSE = (
    "Which setup or operation would you like me to check?"
)

_STEER_MARKER = re.compile(r"\[/?OUT-OF-BAND USER MESSAGE\b", re.IGNORECASE)
_AGENT_BOOST_FUNCTION_TAG = re.compile(
    r"<(?:function|tool_call)(?:=|>)[^\n>]*(?:agent[_-]?boost|wallet_|egress_|onboarding_)",
    re.IGNORECASE,
)
_RAW_FUNCTION_TAG = re.compile(
    r"</?(?:function|tool_call|parameter|arguments?)\b|<function=",
    re.IGNORECASE,
)
_FABRICATED_USER_TAG = re.compile(
    r"</?(?:user(?:\s+message)?|human)(?:\s[^>]*)?>",
    re.IGNORECASE,
)
_SYNTHETIC_APPROVAL_TAG = re.compile(
    r"<(?:approved?_switch(?:_to_[a-z0-9_-]+)?|confirm_(?:reauthorization|transfer|switch|policy))>",
    re.IGNORECASE,
)
_INTERNAL_FIELD = re.compile(
    r"\b(?:decision_?id|request_?id|client_?request_?id|user_?confirmed|wallet_?(?:id|name)|"
    r"amount_?atomic|amount_?native|manifest_?digest|selection_?epoch|"
    r"expected_?active_?wallet_?name|expected_?active_?selection_?epoch)\b",
    re.IGNORECASE,
)
_PRIVATE_BACKEND_FIELD = re.compile(
    r"\b(?:backend_?wallet_?name|source_?executor_?address|"
    r"target_?commitment|prepared_?deposit_?call|"
    r"shield_?(?:prepared_?deposit_?call|broadcast_?started_?at|transaction_?hash)|"
    r"(?:public|private)_?balance_?wei|required_?funding_?wei|shield_?amount_?wei)\b",
    re.IGNORECASE,
)
_PRIVATE_READY_CHAIN_VALUE = re.compile(
    r"\b0x(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})\b",
)
_OFF_SURFACE_CONFIRMATION = re.compile(
    r"\b(?:confirm(?:ation)?|approv(?:e|al)|authorize|complete|open|use)\b[^\n]{0,48}"
    r"\b(?:native\s+(?:interface|ui)|provider\s+(?:interface|ui)|wallet\s+(?:popup|app))\b|"
    r"\b(?:native\s+(?:interface|ui)|provider\s+(?:interface|ui)|wallet\s+(?:popup|app))\b"
    r"[^\n]{0,48}\b(?:confirm(?:ation)?|approv(?:e|al)|authorize|required)\b",
    re.IGNORECASE,
)
_WALLET_CONFIRMATION_SCOPE = re.compile(
    r"\b(?:agent[\s-]?boost|wallet|payment|transfer|transaction|"
    r"private\s+balance|(?:send|move)\s+(?:the\s+)?(?:funds?|eth|tokens?)|"
    r"(?:wallet|payment|transfer|spending)\s+(?:policy|permission|limit))\b",
    re.IGNORECASE,
)
_EXPLICIT_CONFIRMATION_HANDOFF = re.compile(
    r"(?:^|[.!?:]\s+)(?:please\s+)?(?:confirm|approve|authorize|open|use)\b|"
    r"\byou(?:'ll|\s+will)?\s+(?:need|must|have|should|can)\b|"
    r"\b(?:confirmation|approval|authorization)\s+"
    r"(?:is|will\s+be|remains)\s+(?:required|needed)\b|"
    r"\b(?:wallet|payment|transfer|transaction|policy|action)\b"
    r"[^\n.!?]{0,48}\b(?:requires?|needs?)\s+(?:your\s+)?"
    r"(?:confirmation|approval|authorization)\b|"
    r"\bto\s+(?:continue|proceed|complete|finish)\b",
    re.IGNORECASE,
)
_EXTERNAL_CONFIRMATION_REFERENCE = re.compile(
    r"https?://|\bwww\.|\b[a-z0-9-]+\."
    r"(?:com|org|net|io|app|dev|co|finance)\b|"
    r"\b(?:external|third[\s-]?party|merchant|checkout|website|web\s+site|"
    r"browser|dapp|exchange|bank|card\s+issuer|payment\s+page|dashboard)\b",
    re.IGNORECASE,
)
_WALLET_OPERATION_VERB = re.compile(
    r"\b(?:create|make|set\s*up|load|restore|switch|select|fund|deposit|"
    r"top\s*up|send|transfer|move|pay|change|update|edit|set|enable|disable|"
    r"authorize|reauthorize)\b",
    re.IGNORECASE,
)
_WALLET_OPERATION_CONTEXT = re.compile(
    r"\b(?:agent[\s-]?boost|wallet|private\s+balance|saved\s+(?:wallet|profile)|"
    r"sepolia|eth|ether|tokens?|funds?|"
    r"(?:wallet|spending|transfer)\s+(?:policy|permission|limit)|"
    r"(?:per[\s-]?(?:send|payment)|lifetime)\s+limit)\b|"
    r"\b0x[0-9a-f]{40}\b",
    re.IGNORECASE,
)
_DIRECT_OPERATION_REQUEST = re.compile(
    r"^\s*(?:please\s+)?(?:create|make|set\s*up|load|restore|switch|select|"
    r"fund|deposit|top\s*up|send|transfer|move|pay|change|update|edit|set|"
    r"enable|disable|authorize|reauthorize)\b|"
    r"\b(?:please|can\s+you|could\s+you|would\s+you|will\s+you|can\s+we|"
    r"could\s+we|i\s+(?:want|need)\s+(?:you\s+)?to|let(?:'s|\s+us))\b"
    r"[^\n.!?]{0,64}\b(?:create|make|set\s*up|load|restore|switch|select|"
    r"fund|deposit|top\s*up|send|transfer|move|pay|change|update|edit|set|"
    r"enable|disable|authorize|reauthorize)\b",
    re.IGNORECASE,
)
_GENERAL_INFORMATION_REQUEST = re.compile(
    r"^\s*(?:how|what|why|when|where|which)\b|"
    r"^\s*(?:can|could|would)\s+you\s+"
    r"(?:explain|describe|tell|show|walk\s+me\s+through)\b",
    re.IGNORECASE,
)
_CHAT_CONFIRMATION_ROUTE_MISS_RESPONSE = (
    "Agent Boost wallet confirmations happen here in chat. No wallet action "
    "was run; please ask me to show the wallet, payment, or policy preview again."
)
_INTERNAL_VALUE = re.compile(
    r"\b(?:(?:wd|wpd|rwd|wra|wr|req|rreq|wrr|wallet|auth|setup|archive)_|"
    r"sha256:)[A-Za-z0-9._:-]+",
)
_TOOL_SYNTAX = re.compile(
    r"\b(?:mcp__agent_boost__|wallet_(?:get|list|preview|plan|apply|execute|"
    r"create|adopt|archive|start|switch|select|reauthorize)|"
    r"egress_(?:capabilities|status|fetch)|onboarding_(?:start|status))",
    re.IGNORECASE,
)


def _turn_key(session_id: Any) -> str:
    return session_id.strip() if isinstance(session_id, str) else ""


def _is_shared_session_fork(session_id: Any, parent_session_id: Any) -> bool:
    session = _turn_key(session_id)
    parent = _turn_key(parent_session_id)
    return bool(session and parent and session == parent)


def _is_auxiliary_origin() -> bool:
    try:
        from tools.skill_provenance import get_current_write_origin

        return get_current_write_origin() in _AUXILIARY_ORIGINS
    except Exception:
        # Older Hermes releases do not expose this ambient provenance. The
        # native pre-LLM fork marker remains the authoritative tool boundary.
        return False


def _turn_gate_digest(parts: list[str]) -> str:
    digest = hashlib.sha256()
    digest.update(f"{_TURN_GATE_STATE_SCHEMA}\0".encode("utf-8"))
    for part in parts:
        digest.update(part.encode("utf-8"))
        digest.update(b"\0")
    return digest.hexdigest()


def _turn_gate_state_directory() -> str:
    override = os.environ.get("AGENT_BOOST_HERMES_TURN_GATE_DIR", "").strip()
    if override:
        return override
    hermes_home = os.environ.get("HERMES_HOME", "").strip()
    if not hermes_home:
        hermes_home = os.path.join(os.path.expanduser("~"), ".hermes")
    return os.path.join(hermes_home, "state", _TURN_GATE_STATE_DIRECTORY)


def _nested_fork_marker_path(session_id: str, turn_id: str) -> str:
    name = _turn_gate_digest(["fork-turn", session_id, turn_id]) + ".fork.json"
    return os.path.join(_turn_gate_state_directory(), name)


def _remember_nested_fork(session_id: str, turn_id: str, now_ms: int) -> None:
    expires_at_ms = now_ms + _NESTED_FORK_TTL_MS
    with _LOCK:
        _FORK_TURNS[(session_id, turn_id)] = expires_at_ms
        expired = [key for key, expiry in _FORK_TURNS.items() if expiry <= now_ms]
        for key in expired:
            _FORK_TURNS.pop(key, None)
        while len(_FORK_TURNS) > _MAX_SESSIONS * 2:
            _FORK_TURNS.pop(next(iter(_FORK_TURNS)))


def _known_nested_fork(session_id: Any, turn_id: Any) -> bool:
    session = _turn_key(session_id)
    turn = _turn_key(turn_id)
    if not session or not turn:
        return False
    now_ms = int(time.time() * 1000)
    with _LOCK:
        expiry = _FORK_TURNS.get((session, turn))
        if expiry is None:
            return False
        if expiry <= now_ms:
            _FORK_TURNS.pop((session, turn), None)
            return False
        return True


def _write_nested_fork_marker(session_id: str, turn_id: str) -> None:
    """Publish a private, opaque tombstone before a shared fork can use tools."""

    now_ms = int(time.time() * 1000)
    _remember_nested_fork(session_id, turn_id, now_ms)
    directory = _turn_gate_state_directory()
    os.makedirs(directory, mode=0o700, exist_ok=True)
    directory_stat = os.lstat(directory)
    if not stat.S_ISDIR(directory_stat.st_mode) or stat.S_ISLNK(directory_stat.st_mode):
        raise RuntimeError("Agent Boost turn-gate state path must be a real directory")
    os.chmod(directory, 0o700)
    marker = {
        "schema": _TURN_GATE_STATE_SCHEMA,
        "version": _TURN_GATE_STATE_VERSION,
        "kind": "nested_fork_turn",
        "created_at_ms": now_ms,
        "expires_at_ms": now_ms + _NESTED_FORK_TTL_MS,
    }
    fd, temporary = tempfile.mkstemp(prefix=".fork-", dir=directory)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            fd = -1
            json.dump(marker, handle, ensure_ascii=False, separators=(",", ":"))
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, _nested_fork_marker_path(session_id, turn_id))
        temporary = ""
    finally:
        if fd >= 0:
            os.close(fd)
        if temporary:
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass


def _turn_gate_payload(
    session_id: str,
    turn_id: str,
    user_message: Any,
    task_id: Any,
) -> Dict[str, Any]:
    try:
        cwd = os.getcwd()
    except OSError:
        cwd = ""
    return {
        "hook_event_name": "pre_llm_call",
        "tool_name": None,
        "tool_input": None,
        "session_id": session_id,
        "cwd": cwd,
        "extra": {
            "task_id": task_id if isinstance(task_id, str) else "",
            "turn_id": turn_id,
            "user_message": user_message,
        },
    }


def _turn_gate_failure_context() -> Dict[str, str]:
    return {
        "context": (
            "The Agent Boost turn gate could not authenticate or route this "
            "user turn. Do not call an Agent Boost wallet tool in this turn. "
            "Tell the user the wallet guard is temporarily unavailable."
        )
    }


def _invoke_turn_gate(
    executable: str,
    session_id: str,
    turn_id: str,
    user_message: Any,
    task_id: Any,
) -> Optional[Dict[str, str]]:
    payload = _turn_gate_payload(session_id, turn_id, user_message, task_id)
    try:
        completed = subprocess.run(
            [executable, "hermes-turn-gate"],
            input=json.dumps(payload, ensure_ascii=False, default=str),
            capture_output=True,
            text=True,
            timeout=_TURN_GATE_TIMEOUT_SECONDS,
            check=False,
        )
    except Exception as exc:
        _LOGGER.warning("Agent Boost native pre-LLM turn gate failed: %s", exc)
        return _turn_gate_failure_context()
    if (
        completed.returncode != 0
        or len(completed.stdout.encode("utf-8")) > _MAX_TURN_GATE_OUTPUT_BYTES
    ):
        _LOGGER.warning(
            "Agent Boost native pre-LLM turn gate exited unsafely (exit=%s)",
            completed.returncode,
        )
        return _turn_gate_failure_context()
    try:
        response = json.loads(completed.stdout)
    except (TypeError, json.JSONDecodeError):
        _LOGGER.warning("Agent Boost native pre-LLM turn gate returned invalid JSON")
        return _turn_gate_failure_context()
    if not isinstance(response, Mapping):
        return _turn_gate_failure_context()
    context = response.get("context")
    if isinstance(context, str) and context.strip():
        return {"context": context}
    if response:
        # A block/modify directive is not meaningful at Hermes' native
        # pre-LLM hook. Treat every unexpected non-empty response as a closed
        # routing failure instead of silently dropping it.
        return _turn_gate_failure_context()
    return None


def _configured_turn_gate_executable(ctx: Any) -> str:
    raw = ctx.get_config("turn_gate_executable")
    executable = raw.strip() if isinstance(raw, str) else ""
    if not executable or not os.path.isabs(executable):
        raise RuntimeError(
            "agent-boost-output-guard requires an absolute turn_gate_executable"
        )
    resolved = os.path.realpath(executable)
    if resolved != executable:
        raise RuntimeError("turn_gate_executable must already be fully resolved")
    try:
        executable_stat = os.stat(executable)
    except OSError as exc:
        raise RuntimeError("turn_gate_executable is not readable") from exc
    if not stat.S_ISREG(executable_stat.st_mode) or not os.access(executable, os.X_OK):
        raise RuntimeError("turn_gate_executable must be an executable regular file")
    return executable


def _safe_integer(value: Any) -> bool:
    return (
        isinstance(value, int)
        and not isinstance(value, bool)
        and -(2**53 - 1) <= value <= 2**53 - 1
    )


def _valid_binding(value: Any) -> bool:
    if not isinstance(value, Mapping) or len(value) > _MAX_BINDING_ENTRIES:
        return False
    for key, entry in value.items():
        if not isinstance(key, str) or not _BINDING_KEY.fullmatch(key):
            return False
        if isinstance(entry, bool):
            continue
        if _safe_integer(entry):
            continue
        if isinstance(entry, str) and 0 < len(entry) <= _MAX_BINDING_STRING_CHARS:
            continue
        return False
    return True


def _non_empty_string(value: Any) -> Optional[str]:
    if not isinstance(value, str):
        return None
    normalized = value.strip()
    return normalized if normalized else None


def _normalized_binding(tool: Any, value: Any) -> Optional[Dict[str, Any]]:
    """Mirror the turn gate's tool-specific stable binding parser."""

    if tool not in _CONFIRMATION_TOOLS or not _valid_binding(value):
        return None
    binding = dict(value)
    if tool in _DECISION_ID_TOOLS:
        decision_id = _non_empty_string(binding.get("decision_id"))
        return {"decision_id": decision_id} if decision_id else None

    expected_name = _non_empty_string(binding.get("expected_active_wallet_name"))
    expected_epoch = binding.get("expected_active_selection_epoch")
    active_binding = (
        {
            "expected_active_wallet_name": expected_name,
            "expected_active_selection_epoch": expected_epoch,
        }
        if expected_name and _safe_integer(expected_epoch)
        else None
    )
    if tool == "wallet_start_new_demo":
        return active_binding

    wallet_name = (
        _non_empty_string(binding.get("wallet_name"))
        or _non_empty_string(binding.get("name"))
        or _non_empty_string(binding.get("wallet_id"))
    )
    if not wallet_name:
        return None
    if tool == "wallet_archive":
        return {"wallet_name": wallet_name}
    if active_binding is None:
        return None
    if tool in {"wallet_create", "wallet_adopt_existing"}:
        return {"name": wallet_name, **active_binding}
    return {"wallet_name": wallet_name, **active_binding}


def _normalized_status_binding(tool: Any, value: Any) -> Optional[Dict[str, Any]]:
    """Accept only the turn gate's exact status-only route bindings."""

    if tool not in _STATUS_READ_TOOLS or not _valid_binding(value):
        return None
    binding = dict(value)
    if tool == "wallet_get_tree":
        return {} if not binding else None
    if tool == "onboarding_status":
        setup_id = _non_empty_string(binding.get("setup_id"))
        since_revision = binding.get("since_revision")
        wait_ms = binding.get("wait_ms")
        if (
            not setup_id
            or len(setup_id) > _MAX_BINDING_STRING_CHARS
            or not _safe_integer(since_revision)
            or since_revision < 0
            or wait_ms != 30_000
            or set(binding) != {"setup_id", "since_revision", "wait_ms"}
        ):
            return None
        return {
            "setup_id": setup_id,
            "since_revision": since_revision,
            "wait_ms": wait_ms,
        }

    prefixes = {
        "wallet_get_regular_transfer_request": (r"rreq", r"rwd"),
        "wallet_get_private_transfer_request": (r"req", r"wd"),
        "wallet_get_recovery_request": (r"wrr", r"wr"),
        "wallet_get_private_balance_operation": (
            r"(?:pbcr|pbfr|pbpr)",
            r"(?:pbc|pbf|pbp)",
        ),
    }.get(tool)
    request_id = _non_empty_string(binding.get("request_id"))
    decision_id = _non_empty_string(binding.get("decision_id"))
    if not prefixes:
        return None
    request_prefix, decision_prefix = prefixes
    if (
        request_id
        and decision_id is None
        and set(binding) == {"request_id"}
        and re.fullmatch(
            rf"{request_prefix}_[A-Za-z0-9-]{{8,128}}", request_id
        )
        is not None
    ):
        return {"request_id": request_id}
    if (
        decision_id
        and request_id is None
        and set(binding) == {"decision_id"}
        and re.fullmatch(
            rf"{decision_prefix}_[A-Za-z0-9-]{{8,128}}", decision_id
        )
        is not None
    ):
        return {"decision_id": decision_id}
    return None


def _authenticated_status_route(
    session_id: str,
    turn_id: str,
) -> Optional[Dict[str, Any]]:
    """Read one exact, current-turn, status-only routed-transfer record.

    Invalid, expired, empty, and non-status route files are deliberately
    indistinguishable from absence until a valid route has been forced in
    memory. This keeps unrelated routing records from gaining provider-level
    authority while allowing a previously forced status read to fail closed.
    """

    if not session_id or not turn_id:
        return None
    expected_turn_hash = _turn_gate_digest(["turn", session_id, turn_id])
    route = _read_private_json(os.path.join(
        _turn_gate_state_directory(),
        f"{expected_turn_hash}.route.json",
    ))
    if not isinstance(route, Mapping) or not route:
        return None
    tool = route.get("tool")
    binding = _normalized_status_binding(tool, route.get("binding"))
    created = route.get("created_at_ms")
    expires = route.get("expires_at_ms")
    now_ms = int(time.time() * 1000)
    if (
        set(route) != {
            "schema",
            "version",
            "kind",
            "created_at_ms",
            "expires_at_ms",
            "turn_hash",
            "tool",
            "binding",
            "arguments_pinned",
        }
        or route.get("schema") != _TURN_GATE_STATE_SCHEMA
        or route.get("version") != _TURN_GATE_STATE_VERSION
        or route.get("kind") != "routed_transfer"
        or route.get("turn_hash") != expected_turn_hash
        or route.get("arguments_pinned") is not True
        or tool not in _STATUS_READ_TOOLS
        or binding is None
        or not _safe_integer(created)
        or not _safe_integer(expires)
        or created < 0
        or expires <= created
        or expires <= now_ms
    ):
        return None
    return {
        "tool": tool,
        "wire_tool": f"mcp__agent_boost__{tool}",
        "binding": binding,
        "turn_hash": expected_turn_hash,
    }


def _authenticated_status_clarification_route(
    session_id: str,
    turn_id: str,
) -> bool:
    """Authenticate the turn gate's exact handle-less status clarification."""

    if not session_id or not turn_id:
        return False
    expected_turn_hash = _turn_gate_digest(["turn", session_id, turn_id])
    route = _read_private_json(os.path.join(
        _turn_gate_state_directory(),
        f"{expected_turn_hash}.route.json",
    ))
    if not isinstance(route, Mapping) or not route:
        return False
    created = route.get("created_at_ms")
    expires = route.get("expires_at_ms")
    now_ms = int(time.time() * 1000)
    return bool(
        set(route) == {
            "schema",
            "version",
            "kind",
            "created_at_ms",
            "expires_at_ms",
            "turn_hash",
            "tool",
            "binding",
            "arguments_pinned",
        }
        and route.get("schema") == _TURN_GATE_STATE_SCHEMA
        and route.get("version") == _TURN_GATE_STATE_VERSION
        and route.get("kind") == "routed_transfer"
        and route.get("turn_hash") == expected_turn_hash
        and route.get("tool") == "$clarify_status_followup"
        and isinstance(route.get("binding"), Mapping)
        and len(route["binding"]) == 0
        and route.get("arguments_pinned") is True
        and _safe_integer(created)
        and _safe_integer(expires)
        and created >= 0
        and expires > created
        and expires > now_ms
    )


def _read_private_json(path: str) -> Any:
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags)
    except FileNotFoundError:
        return None
    except OSError:
        # Only fail closed when the exact current-turn file is known to exist.
        # A missing or inaccessible parent directory must not affect unrelated
        # non-Agent-Boost conversations.
        return {} if os.path.lexists(path) else None
    try:
        metadata = os.fstat(descriptor)
        if (
            not stat.S_ISREG(metadata.st_mode)
            or metadata.st_uid != os.geteuid()
            or stat.S_IMODE(metadata.st_mode) & 0o077
            or metadata.st_size > _MAX_GATE_STATE_BYTES
        ):
            return {}
        with os.fdopen(descriptor, "r", encoding="utf-8") as handle:
            descriptor = -1
            content = handle.read(_MAX_GATE_STATE_BYTES + 1)
        if len(content.encode("utf-8")) > _MAX_GATE_STATE_BYTES:
            return {}
        parsed = json.loads(content)
        return parsed if isinstance(parsed, Mapping) else {}
    except (OSError, UnicodeError, ValueError):
        return {}
    finally:
        if descriptor >= 0:
            os.close(descriptor)


def _authenticated_decision(
    session_id: str,
    turn_id: str,
) -> tuple[str, Optional[Dict[str, Any]]]:
    """Load the exact unclaimed decision and its matching prior preview.

    The turn gate writes this pair only after authenticating an actual user
    reply, then consumes both records before an exact confirmation call may
    execute. This plugin never creates, changes, or retires that authority.
    """

    if not session_id or not turn_id:
        return "missing", None
    expected_turn_hash = _turn_gate_digest(["turn", session_id, turn_id])
    session_hash = _turn_gate_digest(["session", session_id])
    directory = _turn_gate_state_directory()
    decision = _read_private_json(os.path.join(
        directory,
        f"{expected_turn_hash}.decision.json",
    ))
    if decision is None:
        return "missing", None
    pending = _read_private_json(os.path.join(
        directory,
        f"{session_hash}.pending.json",
    ))
    if (
        not isinstance(decision, Mapping)
        or not decision
        or not isinstance(pending, Mapping)
        or not pending
    ):
        return "invalid", None

    created = decision.get("created_at_ms")
    expires = decision.get("expires_at_ms")
    pending_created = pending.get("created_at_ms")
    pending_expires = pending.get("expires_at_ms")
    preview_turn_hash = decision.get("preview_turn_hash")
    tool = decision.get("tool")
    binding = _normalized_binding(tool, decision.get("binding"))
    pending_tool = pending.get("tool")
    pending_binding = _normalized_binding(pending_tool, pending.get("binding"))
    now_ms = int(time.time() * 1000)
    if (
        decision.get("schema") != _TURN_GATE_STATE_SCHEMA
        or decision.get("version") != _TURN_GATE_STATE_VERSION
        or decision.get("kind") != "user_decision"
        or decision.get("decision_turn_hash") != expected_turn_hash
        or not isinstance(preview_turn_hash, str)
        or not _STATE_DIGEST.fullmatch(preview_turn_hash)
        or preview_turn_hash == expected_turn_hash
        or tool not in _CONFIRMATION_TOOLS
        or binding is None
        or not _safe_integer(created)
        or not _safe_integer(expires)
        or created < 0
        or expires <= created
        or expires <= now_ms
        or not isinstance(decision.get("user_confirmed"), bool)
        or pending.get("schema") != _TURN_GATE_STATE_SCHEMA
        or pending.get("version") != _TURN_GATE_STATE_VERSION
        or pending.get("kind") != "pending_continuation"
        or pending.get("preview_turn_hash") != preview_turn_hash
        or pending_tool != tool
        or pending_binding != binding
        or not _safe_integer(pending_created)
        or not _safe_integer(pending_expires)
        or pending_created < 0
        or pending_expires <= pending_created
        or pending_expires <= now_ms
    ):
        return "invalid", None
    return "active", {
        "tool": tool,
        "wire_tool": f"mcp__agent_boost__{tool}",
        "binding": binding,
        "user_confirmed": decision["user_confirmed"],
        "decision_turn_hash": expected_turn_hash,
        "preview_turn_hash": preview_turn_hash,
    }


def _authenticated_allow_mode_dispatch_marker(
    session_id: str,
    turn_id: str,
) -> Optional[Dict[str, Any]]:
    """Authenticate the exact current-turn allow-mode transfer dispatch.

    The shell turn gate stages this session-scoped record immediately before
    it commits the one-shot allow-mode execution claim. Keeping a copy in the
    native plugin makes a missing or unsigned post-tool event pessimistic: the
    model cannot turn a transport timeout into a success claim.
    """

    if not session_id or not turn_id:
        return None
    expected_turn_hash = _turn_gate_digest(["turn", session_id, turn_id])
    session_hash = _turn_gate_digest(["session", session_id])
    record = _read_private_json(os.path.join(
        _turn_gate_state_directory(),
        f"{session_hash}.dispatch-status.json",
    ))
    if not isinstance(record, Mapping) or not record:
        return None

    source_tool = record.get("source_tool")
    effect = _ALLOW_MODE_TRANSFER_RESULTS.get(source_tool)
    source_binding = _normalized_binding(
        source_tool,
        record.get("source_binding"),
    )
    status_tool = record.get("tool")
    status_binding = _normalized_status_binding(status_tool, record.get("binding"))
    created = record.get("created_at_ms")
    expires = record.get("expires_at_ms")
    now_ms = int(time.time() * 1000)
    if (
        set(record) != {
            "schema",
            "version",
            "kind",
            "created_at_ms",
            "expires_at_ms",
            "dispatch_turn_hash",
            "tool",
            "binding",
            "source_tool",
            "source_binding",
        }
        or record.get("schema") != _TURN_GATE_STATE_SCHEMA
        or record.get("version") != _TURN_GATE_STATE_VERSION
        or record.get("kind") != "pending_dispatch_status"
        or record.get("dispatch_turn_hash") != expected_turn_hash
        or effect is None
        or status_tool != effect["status_tool"]
        or source_binding is None
        or dict(record.get("source_binding", {})) != source_binding
        or status_binding is None
        or dict(record.get("binding", {})) != status_binding
        or status_binding != source_binding
        or not _safe_integer(created)
        or not _safe_integer(expires)
        or created < 0
        or expires <= created
        or expires <= now_ms
    ):
        return None

    dispatch = {
        "tool": source_tool,
        "wire_tool": f"mcp__agent_boost__{source_tool}",
        "binding": source_binding,
        "status_tool": status_tool,
        "status_binding": status_binding,
        "dispatch_turn_hash": expected_turn_hash,
    }
    return dispatch


def _authenticated_allow_mode_dispatch(
    session_id: str,
    turn_id: str,
    tool_name: Any,
    args: Any,
) -> Optional[Dict[str, Any]]:
    dispatch = _authenticated_allow_mode_dispatch_marker(session_id, turn_id)
    if dispatch is None:
        return None
    return dispatch if _exact_allow_mode_arguments(tool_name, args, dispatch) else None


def _remember_allow_mode_dispatch(
    session_id: str,
    turn_id: str,
    tool_name: Any,
    args: Any,
) -> Optional[str]:
    """Persist authenticated dispatch provenance in this turn's memory."""

    dispatch = _authenticated_allow_mode_dispatch(
        session_id,
        turn_id,
        tool_name,
        args,
    )
    if dispatch is None:
        return None
    with _LOCK:
        state = _TURNS.get(session_id)
        if state is None or state.get("turn_id") != turn_id:
            return None
        if state.get("allow_execution_dispatched"):
            forced = state.get("forced_allow_dispatch")
            same_dispatch = bool(
                isinstance(forced, Mapping)
                and forced.get("dispatch_turn_hash") == dispatch["dispatch_turn_hash"]
                and forced.get("wire_tool") == dispatch["wire_tool"]
                and forced.get("binding") == dispatch["binding"]
            )
            return "existing" if same_dispatch else None
        state["allow_execution_dispatched"] = True
        state["forced_allow_dispatch"] = {
            **dispatch,
            "invocation_tool": tool_name,
        }
        # The shell gate has committed the one-shot execution and staged its
        # immutable recovery handle. Until post_tool proves the exact signed
        # result, treat every provider summary as unverified.
        state["forced_result_missing"] = True
        state["forced_result_verified"] = False
        state["forced_user_confirmed"] = None
    return "new"


def _unclaimed_user_decision(session_id: str, turn_id: str) -> Optional[str]:
    status, decision = _authenticated_decision(session_id, turn_id)
    if status == "missing":
        return None
    if status != "active" or decision is None:
        return "invalid"
    return "approval" if decision["user_confirmed"] else "rejection"


def _declared_tool_name(value: Any, api_mode: str) -> Optional[str]:
    if not isinstance(value, Mapping):
        return None
    if api_mode == "chat_completions":
        function = value.get("function")
        name = function.get("name") if isinstance(function, Mapping) else None
    elif api_mode in {"codex_responses", "anthropic_messages"}:
        name = value.get("name")
    else:
        return None
    return name if isinstance(name, str) and name else None


def _matching_tool_declaration(
    request: Mapping[str, Any],
    api_mode: str,
    wire_tool: str,
) -> tuple[Optional[Mapping[str, Any]], Optional[list[Any]], Optional[str]]:
    tools = request.get("tools")
    if not isinstance(tools, list):
        return None, None, None
    direct_matches = [
        item for item in tools
        if _declared_tool_name(item, api_mode) == wire_tool
    ]
    if len(direct_matches) > 1:
        return None, tools, None
    if len(direct_matches) == 1 and isinstance(direct_matches[0], Mapping):
        return direct_matches[0], tools, wire_tool

    # With Hermes Tool Search enabled, the exact MCP declaration is deferred
    # behind one generic bridge. We can still force the authenticated action:
    # pin the provider to `tool_call`, then replace the outer bridge arguments
    # in tool_request middleware before schema validation and dispatch.
    bridge_matches = [
        item for item in tools
        if _declared_tool_name(item, api_mode) == "tool_call"
    ]
    if len(bridge_matches) != 1 or not isinstance(bridge_matches[0], Mapping):
        return None, tools, None
    return bridge_matches[0], tools, "tool_call"


def _remember_forced_decision(
    session_id: str,
    turn_id: str,
    decision: Mapping[str, Any],
    invocation_tool: str,
) -> bool:
    with _LOCK:
        state = _TURNS.get(session_id)
        if state is None or state.get("turn_id") != turn_id:
            return False
        state["forced_decision"] = {
            **decision,
            "invocation_tool": invocation_tool,
        }
    return True


def _clear_forced_decision(session_id: str, turn_id: str) -> None:
    with _LOCK:
        state = _TURNS.get(session_id)
        if state is not None and state.get("turn_id") == turn_id:
            state["forced_decision"] = None


def _same_status_route(left: Mapping[str, Any], right: Mapping[str, Any]) -> bool:
    return all(
        left.get(key) == right.get(key)
        for key in ("wire_tool", "binding", "turn_hash")
    )


def _remember_forced_status_route(
    session_id: str,
    turn_id: str,
    route: Mapping[str, Any],
    invocation_tool: str,
) -> bool:
    with _LOCK:
        state = _TURNS.get(session_id)
        if state is None or state.get("turn_id") != turn_id:
            return False
        existing = state.get("forced_status_route")
        if isinstance(existing, Mapping) and not _same_status_route(existing, route):
            state["status_result_missing"] = True
            return False
        state["forced_status_route"] = {
            **route,
            "invocation_tool": invocation_tool,
        }
        state["status_result_missing"] = not bool(
            state.get("status_result_verified")
        )
    return True


def _provider_tool_choice(
    request: Mapping[str, Any],
    mode: str,
    declaration: Mapping[str, Any],
    invocation_tool: str,
) -> Optional[Dict[str, Any]]:
    effective = dict(request)
    if mode == "chat_completions":
        effective["tools"] = [declaration]
        effective["tool_choice"] = {
            "type": "function",
            "function": {"name": invocation_tool},
        }
    elif mode == "codex_responses":
        effective["tools"] = [declaration]
        effective["tool_choice"] = {"type": "function", "name": invocation_tool}
    elif mode == "anthropic_messages":
        effective["tools"] = [declaration]
        effective["tool_choice"] = {"type": "tool", "name": invocation_tool}
    else:
        return None
    return effective


def _private_ready_followup_wire_tool(state: Mapping[str, Any]) -> Optional[str]:
    if not (
        state.get("status_result_verified")
        and state.get("status_result_private_ready")
    ):
        return None
    if not state.get("status_capabilities_dispatched"):
        return "mcp__agent_boost__capabilities"
    if (
        state.get("status_capabilities_verified")
        and not state.get("status_tree_dispatched")
    ):
        return "mcp__agent_boost__wallet_get_tree"
    return None


def _force_private_ready_followup_tool(
    request: Mapping[str, Any],
    session_id: str,
    turn_id: str,
    api_mode: str,
) -> Optional[Dict[str, Any]]:
    """Deterministically finish private-ready setup with capabilities then tree."""

    with _LOCK:
        state = _TURNS.get(session_id)
        if state is None or state.get("turn_id") != turn_id:
            return None
        wire_tool = _private_ready_followup_wire_tool(state)
    if wire_tool is None:
        return None
    declaration, _tools, invocation_tool = _matching_tool_declaration(
        request,
        api_mode,
        wire_tool,
    )
    if declaration is None or invocation_tool is None:
        return None
    effective = _provider_tool_choice(
        request,
        api_mode,
        declaration,
        invocation_tool,
    )
    if effective is None:
        return None
    with _LOCK:
        state = _TURNS.get(session_id)
        if (
            state is None
            or state.get("turn_id") != turn_id
            or _private_ready_followup_wire_tool(state) != wire_tool
        ):
            return None
    return {
        "request": effective,
        "source": "agent-boost-output-guard",
        "reason": "verified Agent Boost setup completion",
    }


def _force_status_route_tool(
    request: Mapping[str, Any],
    session_id: str,
    turn_id: str,
    api_mode: str,
) -> Optional[Dict[str, Any]]:
    """Pin one authenticated status route at the provider boundary."""

    with _LOCK:
        state = _TURNS.get(session_id)
        if state is None or state.get("turn_id") != turn_id:
            return None
        if state.get("status_read_dispatched"):
            # The route may remain until post_tool, but it never authorizes a
            # second provider-forced read in the same user turn.
            return None
        remembered = state.get("forced_status_route")

    current = _authenticated_status_route(session_id, turn_id)
    if isinstance(remembered, Mapping):
        if current is None or not _same_status_route(remembered, current):
            with _LOCK:
                state = _TURNS.get(session_id)
                if state is not None and state.get("turn_id") == turn_id:
                    state["status_result_missing"] = True
            return None
        route: Mapping[str, Any] = remembered
    elif current is not None:
        route = current
    else:
        return None

    declaration, tools, invocation_tool = _matching_tool_declaration(
        request,
        api_mode,
        str(route["wire_tool"]),
    )
    if declaration is None or tools is None or invocation_tool is None:
        # A valid durable route still requires a fresh signed result. Remember
        # that obligation even when this provider payload cannot expose the
        # direct declaration or the Tool Search bridge.
        _remember_forced_status_route(
            session_id,
            turn_id,
            route,
            str(route["wire_tool"]),
        )
        return None
    effective = _provider_tool_choice(
        request,
        api_mode,
        declaration,
        invocation_tool,
    )
    if effective is None or not _remember_forced_status_route(
        session_id,
        turn_id,
        route,
        invocation_tool,
    ):
        return None
    return {
        "request": effective,
        "source": "agent-boost-output-guard",
        "reason": "authenticated Agent Boost status route",
    }


def _force_decision_tool(
    request: Any = None,
    session_id: Any = "",
    turn_id: Any = "",
    api_mode: Any = "",
    **_: Any,
) -> Optional[Dict[str, Any]]:
    """Pin an authenticated confirmation turn to its one valid wire tool."""

    if _is_auxiliary_origin() or _known_nested_fork(session_id, turn_id):
        return None
    session = _turn_key(session_id)
    turn = _turn_key(turn_id)
    mode = api_mode.strip() if isinstance(api_mode, str) else ""
    if not session or not turn or not isinstance(request, Mapping):
        return None
    with _LOCK:
        state = _TURNS.get(session)
        if state is None or state.get("turn_id") != turn:
            return None

    status, decision = _authenticated_decision(session, turn)
    if status == "missing":
        _clear_forced_decision(session, turn)
        if _authenticated_status_clarification_route(session, turn):
            with _LOCK:
                state = _TURNS.get(session)
                if state is not None and state.get("turn_id") == turn:
                    state["status_clarification"] = True
            # This authenticated route deliberately names no tool. Preserve
            # the provider request and let the output hook emit the one safe
            # clarification instead of steering a model-authored status read.
            return None
        private_ready_followup = _force_private_ready_followup_tool(
            request,
            session,
            turn,
            mode,
        )
        if private_ready_followup is not None:
            return private_ready_followup
        return _force_status_route_tool(request, session, turn, mode)
    if status != "active" or decision is None:
        _clear_forced_decision(session, turn)
        return None
    wire_tool = decision["wire_tool"]
    declaration, tools, invocation_tool = _matching_tool_declaration(
        request,
        mode,
        wire_tool,
    )
    if declaration is None or tools is None or invocation_tool is None:
        _clear_forced_decision(session, turn)
        return None

    # Ollama can treat named tool_choice as steering rather than a hard
    # protocol constraint. Exposing only the authenticated action removes the
    # remaining wrong-tool branch without affecting the next request.
    effective = _provider_tool_choice(
        request,
        mode,
        declaration,
        invocation_tool,
    )
    if effective is None:
        _clear_forced_decision(session, turn)
        return None

    if not _remember_forced_decision(session, turn, decision, invocation_tool):
        return None
    return {
        "request": effective,
        "source": "agent-boost-output-guard",
        "reason": "authenticated Agent Boost confirmation",
    }


def _pin_private_ready_followup_arguments(
    tool_name: str,
    args: Any,
    session_id: str,
    turn_id: str,
) -> Optional[Dict[str, Any]]:
    with _LOCK:
        state = _TURNS.get(session_id)
        if state is None or state.get("turn_id") != turn_id:
            return None
        wire_tool = _private_ready_followup_wire_tool(state)
    if wire_tool is None:
        return None
    if tool_name == wire_tool:
        invocation_tool = tool_name
    elif (
        tool_name == "tool_call"
        and isinstance(args, Mapping)
        and args.get("name") == wire_tool
    ):
        invocation_tool = "tool_call"
    else:
        return None
    effective_args = (
        {"name": wire_tool, "arguments": {}}
        if invocation_tool == "tool_call"
        else {}
    )
    return {
        "args": effective_args,
        "source": "agent-boost-output-guard",
        "reason": "verified Agent Boost setup completion arguments",
    }


def _pin_status_arguments(
    tool_name: str,
    args: Any,
    session_id: str,
    turn_id: str,
) -> Optional[Dict[str, Any]]:
    with _LOCK:
        state = _TURNS.get(session_id)
        if state is None or state.get("turn_id") != turn_id:
            return None
        if state.get("status_read_dispatched"):
            return None
        remembered = state.get("forced_status_route")

    current = _authenticated_status_route(session_id, turn_id)
    if isinstance(remembered, Mapping):
        if current is None or not _same_status_route(remembered, current):
            with _LOCK:
                state = _TURNS.get(session_id)
                if state is not None and state.get("turn_id") == turn_id:
                    state["status_result_missing"] = True
            return None
        route: Mapping[str, Any] = remembered
        invocation_tool = route.get("invocation_tool")
    elif current is not None:
        route = current
        wire_tool = route.get("wire_tool")
        if tool_name == wire_tool:
            invocation_tool = tool_name
        elif (
            tool_name == "tool_call"
            and isinstance(args, Mapping)
            and args.get("name") == wire_tool
        ):
            invocation_tool = "tool_call"
        else:
            return None
    else:
        return None

    wire_tool = route.get("wire_tool")
    if not isinstance(wire_tool, str) or not isinstance(invocation_tool, str):
        return None
    if tool_name != invocation_tool and not (
        invocation_tool == "tool_call" and tool_name == wire_tool
    ):
        return None
    if not _remember_forced_status_route(
        session_id,
        turn_id,
        route,
        invocation_tool,
    ):
        return None
    pinned = dict(route["binding"])
    effective_args = (
        {"name": wire_tool, "arguments": pinned}
        if tool_name == "tool_call"
        else pinned
    )
    return {
        "args": effective_args,
        "source": "agent-boost-output-guard",
        "reason": "authenticated Agent Boost status binding",
    }


def _pin_decision_arguments(
    tool_name: Any = "",
    args: Any = None,
    session_id: Any = "",
    turn_id: Any = "",
    **_: Any,
) -> Optional[Dict[str, Any]]:
    """Replace model-authored args with the authenticated stable binding."""

    if _is_auxiliary_origin() or _known_nested_fork(session_id, turn_id):
        return None
    session = _turn_key(session_id)
    turn = _turn_key(turn_id)
    if not session or not turn or not isinstance(tool_name, str):
        return None
    with _LOCK:
        state = _TURNS.get(session)
        forced = state.get("forced_decision") if state is not None else None
        if state is None or state.get("turn_id") != turn:
            return None
    if not isinstance(forced, Mapping):
        followup = _pin_private_ready_followup_arguments(
            tool_name,
            args,
            session,
            turn,
        )
        if followup is not None:
            return followup
        return _pin_status_arguments(tool_name, args, session, turn)
    invocation_tool = forced.get("invocation_tool")
    wire_tool = forced.get("wire_tool")
    # Current Hermes resolves `tool_call` and invokes middleware with the
    # underlying tool name; older/alternate host paths may expose the bridge
    # itself. Accept exactly those two representations and no near match.
    if tool_name != invocation_tool and not (
        invocation_tool == "tool_call" and tool_name == wire_tool
    ):
        return None

    status, decision = _authenticated_decision(session, turn)
    if status != "active" or decision is None or any(
        decision.get(key) != forced.get(key)
        for key in (
            "wire_tool",
            "binding",
            "user_confirmed",
            "decision_turn_hash",
            "preview_turn_hash",
        )
    ):
        _clear_forced_decision(session, turn)
        return None
    pinned = {
        **decision["binding"],
        "user_confirmed": decision["user_confirmed"],
    }
    effective_args = (
        {"name": decision["wire_tool"], "arguments": pinned}
        if tool_name == "tool_call"
        else pinned
    )
    return {
        "args": effective_args,
        "source": "agent-boost-output-guard",
        "reason": "authenticated Agent Boost confirmation binding",
    }


def _enforce_status_execution(
    tool_name: str,
    args: Mapping[str, Any],
    next_call: Any,
    session_id: str,
    turn_id: str,
) -> tuple[bool, Any]:
    """Enforce one routed status read, retaining proof after route cleanup."""

    with _LOCK:
        state = _TURNS.get(session_id)
        if state is None or state.get("turn_id") != turn_id:
            return False, None
        remembered = state.get("forced_status_route")
        dispatched = bool(state.get("status_read_dispatched"))
        verified = bool(state.get("status_result_verified"))
        private_ready = bool(state.get("status_result_private_ready"))
        clarification = bool(state.get("status_clarification"))

    if clarification or _authenticated_status_clarification_route(
        session_id,
        turn_id,
    ):
        if _agent_boost_wire_tool(tool_name, args) is not None:
            return True, _BLOCKED_STATUS_CLARIFICATION_TOOL_RESULT
        return False, None

    if dispatched:
        if verified and private_ready and _routing_only_tool(tool_name):
            return True, next_call(dict(args))
        if verified and private_ready:
            followup_tool = _agent_boost_wire_tool(tool_name, args)
            allow_followup = False
            with _LOCK:
                state = _TURNS.get(session_id)
                if state is None or state.get("turn_id") != turn_id:
                    return True, _BLOCKED_STATUS_AFTER_READ_TOOL_RESULT
                if (
                    followup_tool == "mcp__agent_boost__capabilities"
                    and not state.get("status_capabilities_dispatched")
                    and not state.get("status_tree_dispatched")
                ):
                    state["status_capabilities_dispatched"] = True
                    allow_followup = True
                elif (
                    followup_tool == "mcp__agent_boost__wallet_get_tree"
                    and state.get("status_capabilities_verified")
                    and not state.get("status_tree_dispatched")
                ):
                    state["status_tree_dispatched"] = True
                    allow_followup = True
            if allow_followup:
                effective_args = (
                    {"name": followup_tool, "arguments": {}}
                    if tool_name == "tool_call"
                    else {}
                )
                return True, next_call(effective_args)
        return True, _BLOCKED_STATUS_AFTER_READ_TOOL_RESULT

    current = _authenticated_status_route(session_id, turn_id)
    if isinstance(remembered, Mapping):
        if current is None or not _same_status_route(remembered, current):
            with _LOCK:
                state = _TURNS.get(session_id)
                if state is not None and state.get("turn_id") == turn_id:
                    state["status_result_missing"] = True
            return True, _BLOCKED_STATUS_ROUTE_TOOL_RESULT
        route: Mapping[str, Any] = remembered
    elif current is not None:
        route = current
    else:
        return False, None

    if _routing_only_tool(tool_name):
        return True, next_call(dict(args))
    wire_tool = str(route["wire_tool"])
    actual_wire_tool = _agent_boost_wire_tool(tool_name, args)
    if actual_wire_tool != wire_tool:
        return True, _BLOCKED_STATUS_ROUTE_TOOL_RESULT

    invocation_tool = "tool_call" if tool_name == "tool_call" else wire_tool
    with _LOCK:
        state = _TURNS.get(session_id)
        if state is None or state.get("turn_id") != turn_id:
            return True, _BLOCKED_STATUS_ROUTE_TOOL_RESULT
        if state.get("status_read_dispatched"):
            return True, _BLOCKED_STATUS_AFTER_READ_TOOL_RESULT
        state["forced_status_route"] = {
            **route,
            "invocation_tool": invocation_tool,
        }
        state["status_read_dispatched"] = True
        state["status_result_missing"] = True
        state["status_result_verified"] = False
        state["status_result_private_ready"] = False

    pinned = dict(route["binding"])
    effective_args = (
        {"name": wire_tool, "arguments": pinned}
        if tool_name == "tool_call"
        else pinned
    )
    return True, next_call(effective_args)


def _enforce_decision_execution(
    tool_name: Any = "",
    args: Any = None,
    next_call: Any = None,
    session_id: Any = "",
    turn_id: Any = "",
    api_request_id: Any = "",
    **_: Any,
) -> Any:
    """Allow exactly one authenticated confirmation action in its user turn."""

    if _is_auxiliary_origin() or _known_nested_fork(session_id, turn_id):
        if _agent_boost_wire_tool(tool_name, args) is not None:
            return _BLOCKED_NESTED_FORK_TOOL_RESULT
        return next_call(args) if callable(next_call) else _BLOCKED_NESTED_FORK_TOOL_RESULT
    session = _turn_key(session_id)
    turn = _turn_key(turn_id)
    request_id = _turn_key(api_request_id)
    if (
        not session
        or not turn
        or not isinstance(tool_name, str)
        or not callable(next_call)
    ):
        return next_call(args) if callable(next_call) else _BLOCKED_CONFIRMATION_TOOL_RESULT
    with _LOCK:
        active_state = _TURNS.get(session)
        allow_execution_dispatched = bool(
            active_state is not None
            and active_state.get("turn_id") == turn
            and active_state.get("allow_execution_dispatched")
        )
    if allow_execution_dispatched and _agent_boost_wire_tool(tool_name, args) is not None:
        # post_tool is an independent observer hook and remains free to
        # authenticate the exact result. Native execution middleware must not
        # let a second call (including a status read) replace or race the
        # already-staged recovery subject in this same assistant turn.
        return _BLOCKED_ALLOW_DISPATCH_TOOL_RESULT
    if not isinstance(args, Mapping):
        current_status_route = _authenticated_status_route(session, turn)
        current_status_clarification = _authenticated_status_clarification_route(
            session,
            turn,
        )
        with _LOCK:
            state = _TURNS.get(session)
            remembered_status_clarification = bool(
                state is not None
                and state.get("turn_id") == turn
                and state.get("status_clarification")
            )
            forced_status = (
                state.get("forced_status_route")
                if state is not None and state.get("turn_id") == turn
                else None
            )
            forced_decision = (
                state.get("forced_decision")
                if state is not None and state.get("turn_id") == turn
                else None
            )
        if (
            (current_status_clarification or remembered_status_clarification)
            and _agent_boost_wire_tool(tool_name, args) is not None
        ):
            return _BLOCKED_STATUS_CLARIFICATION_TOOL_RESULT
        if current_status_route is not None or isinstance(forced_status, Mapping):
            return _BLOCKED_STATUS_ROUTE_TOOL_RESULT
        decision_status, _decision = _authenticated_decision(session, turn)
        if decision_status == "active" or isinstance(forced_decision, Mapping):
            return _BLOCKED_CONFIRMATION_TOOL_RESULT
        return next_call(args)

    with _LOCK:
        state = _TURNS.get(session)
        completed_wallet_turn = bool(
            state is not None
            and state.get("turn_id") == turn
            and (state.get("hard_boundary") or state.get("complete_turn"))
        )
    if completed_wallet_turn:
        # The signed Agent Boost result is already the whole response for this
        # user turn. Stop weak models from appending a redundant read, retry,
        # or unrelated side effect; the output hook will retain that signed
        # rendering even if Hermes observes this blocked attempt afterward.
        return _BLOCKED_COMPLETED_TURN_TOOL_RESULT

    status_handled, status_result = _enforce_status_execution(
        tool_name,
        args,
        next_call,
        session,
        turn,
    )
    if status_handled:
        return status_result

    allow_dispatch_state = _remember_allow_mode_dispatch(
        session,
        turn,
        tool_name,
        args,
    )
    if allow_dispatch_state is not None:
        if allow_dispatch_state != "new":
            return _BLOCKED_CONFIRMATION_TOOL_RESULT
        return next_call(dict(args))

    status, decision = _authenticated_decision(session, turn)
    if status == "missing":
        with _LOCK:
            state = _TURNS.get(session)
            forced = state.get("forced_decision") if state is not None else None
            orphaned_forced_call = bool(
                state is not None
                and state.get("turn_id") == turn
                and isinstance(forced, Mapping)
                and not state.get("decision_execution_dispatched")
            )
            if orphaned_forced_call:
                # A legacy/internal Hermes path may consume the shell-gate
                # receipt before execution middleware. Never infer that this
                # missing receipt authorizes dispatch; fail closed instead.
                state["decision_execution_blocked"] = True
                state["forced_result_missing"] = True
                state["forced_user_confirmed"] = forced.get("user_confirmed")
            blocked = bool(
                state is not None
                and state.get("turn_id") == turn
                and state.get("decision_execution_blocked")
            )
            same_response_batch = bool(
                state is not None
                and state.get("turn_id") == turn
                and state.get("decision_execution_dispatched")
                and (
                    not request_id
                    or not state.get("decision_execution_request_id")
                    or state.get("decision_execution_request_id") == request_id
                )
            )
        if blocked or orphaned_forced_call or same_response_batch:
            return _BLOCKED_CONFIRMATION_TOOL_RESULT
        try:
            return next_call(dict(args))
        finally:
            # Hermes runs native execution middleware outside the shell
            # pre_tool hook. On that host order, the gate's dispatch marker is
            # created inside next_call, immediately before the destructive MCP
            # call. Capture it on both normal return and transport exception.
            _remember_allow_mode_dispatch(session, turn, tool_name, args)
    if status != "active" or decision is None:
        return _BLOCKED_CONFIRMATION_TOOL_RESULT

    wire_tool = decision["wire_tool"]
    is_bridge = tool_name == "tool_call"
    exact_tool = tool_name == wire_tool or (
        is_bridge and args.get("name") == wire_tool
    )
    with _LOCK:
        state = _TURNS.get(session)
        if state is None or state.get("turn_id") != turn:
            return _BLOCKED_CONFIRMATION_TOOL_RESULT
        if state.get("decision_execution_blocked") or state.get("decision_execution_dispatched"):
            return _BLOCKED_CONFIRMATION_TOOL_RESULT
        if not exact_tool:
            state["decision_execution_blocked"] = True
            return _BLOCKED_CONFIRMATION_TOOL_RESULT
        state["decision_execution_dispatched"] = True
        state["decision_execution_request_id"] = request_id
        # Preserve confirmation provenance through post_tool even if an
        # unsupported provider path skipped llm_request request rewriting.
        state["forced_decision"] = {
            **decision,
            "invocation_tool": tool_name,
        }
        # Pessimistic until the exact post-tool observer supplies a signed
        # Agent Boost rendering. This also covers a dropped observer event.
        state["forced_result_missing"] = True
        state["forced_result_verified"] = False
        state["forced_user_confirmed"] = decision["user_confirmed"]

    pinned = {
        **decision["binding"],
        "user_confirmed": decision["user_confirmed"],
    }
    effective_args = (
        {"name": wire_tool, "arguments": pinned}
        if is_bridge
        else pinned
    )
    return next_call(effective_args)


def _start_root_turn(
    session_id: Any = "",
    turn_id: Any = "",
    user_message: Any = "",
    **_: Any,
) -> None:
    key = _turn_key(session_id)
    if not key:
        return None
    wallet_operation_intent = _wallet_operation_intent(user_message)
    with _LOCK:
        _TURNS.pop(key, None)
        _TURNS[key] = {
            "turn_id": _turn_key(turn_id),
            "wallet_operation_intent": wallet_operation_intent,
            "saw_agent_boost": False,
            "rendered_calls": 0,
            "mixed_turn": False,
            "rendered": None,
            "hard_boundary": False,
            "complete_turn": False,
            "forced_decision": None,
            "forced_allow_dispatch": None,
            "forced_result_missing": False,
            "forced_result_verified": False,
            "forced_user_confirmed": None,
            "decision_execution_blocked": False,
            "decision_execution_dispatched": False,
            "decision_execution_request_id": "",
            "allow_execution_dispatched": False,
            "forced_status_route": None,
            "status_read_dispatched": False,
            "status_result_missing": False,
            "status_result_verified": False,
            "status_result_private_ready": False,
            "status_capabilities_dispatched": False,
            "status_capabilities_verified": False,
            "status_tree_dispatched": False,
            "status_tree_verified": False,
            "status_clarification": False,
        }
        while len(_TURNS) > _MAX_SESSIONS:
            _TURNS.pop(next(iter(_TURNS)))


def _pre_llm(
    ctx: Any,
    session_id: Any = "",
    turn_id: Any = "",
    user_message: Any = "",
    task_id: Any = "",
    parent_session_id: Any = "",
    **kwargs: Any,
) -> Optional[Dict[str, str]]:
    session = _turn_key(session_id)
    turn = _turn_key(turn_id)
    # Cache-parity background reviews and side questions deliberately reuse
    # the root session ID. Distinct-session branch/compression children have a
    # parent too, but are real turns and must still pass through the gate.
    if _is_shared_session_fork(session, parent_session_id):
        if session and turn:
            _write_nested_fork_marker(session, turn)
        return None
    try:
        turn_gate_executable = _configured_turn_gate_executable(ctx)
    except Exception as exc:
        # Plugin Doctor registers plugins under a fresh, deliberately blank
        # HERMES_HOME, so profile-scoped settings are unavailable there.  Keep
        # registration side-effect free and validate at the first real root
        # turn instead.  Configuration failures must happen before any root
        # turn state or gate attestation can be created.
        _LOGGER.warning("Agent Boost turn-gate configuration is unavailable: %s", exc)
        return _turn_gate_failure_context()
    _start_root_turn(
        session_id=session,
        turn_id=turn,
        user_message=user_message,
        **kwargs,
    )
    if not session or not turn:
        return _turn_gate_failure_context()
    return _invoke_turn_gate(
        turn_gate_executable,
        session,
        turn,
        user_message,
        task_id,
    )
    return None


def _agent_boost_wire_tool(tool_name: Any, args: Any) -> Optional[str]:
    if not isinstance(tool_name, str):
        return None
    if tool_name.startswith("mcp__agent_boost__"):
        return tool_name
    if tool_name != "tool_call" or not isinstance(args, Mapping):
        return None
    inner = args.get("name")
    return inner if isinstance(inner, str) and inner.startswith("mcp__agent_boost__") else None


def _agent_boost_tool(tool_name: Any, args: Any) -> bool:
    return _agent_boost_wire_tool(tool_name, args) is not None


def _exact_status_post_arguments(
    tool_name: Any,
    args: Any,
    route: Mapping[str, Any],
) -> bool:
    if not isinstance(tool_name, str) or not isinstance(args, Mapping):
        return False
    wire_tool = route.get("wire_tool")
    binding = route.get("binding")
    if not isinstance(wire_tool, str) or not isinstance(binding, Mapping):
        return False
    if tool_name == wire_tool:
        actual = args
    elif tool_name == "tool_call" and args.get("name") == wire_tool:
        actual = args.get("arguments")
        if isinstance(actual, str):
            try:
                actual = json.loads(actual)
            except (TypeError, ValueError):
                return False
    else:
        return False
    return isinstance(actual, Mapping) and dict(actual) == dict(binding)


def _exact_allow_mode_arguments(
    tool_name: Any,
    args: Any,
    dispatch: Mapping[str, Any],
) -> bool:
    """Match only the exact destructive call staged by the shell gate."""

    if not isinstance(tool_name, str) or not isinstance(args, Mapping):
        return False
    wire_tool = dispatch.get("wire_tool")
    binding = dispatch.get("binding")
    if not isinstance(wire_tool, str) or not isinstance(binding, Mapping):
        return False
    if tool_name == wire_tool:
        actual = args
    elif tool_name == "tool_call" and args.get("name") == wire_tool:
        actual = args.get("arguments")
        if isinstance(actual, str):
            try:
                actual = json.loads(actual)
            except (TypeError, ValueError):
                return False
    else:
        return False
    # An allow-mode execution deliberately omits user_confirmed and the shell
    # gate pins a one-field decision binding. Reject extra fields here too, so
    # this provenance cannot be borrowed by a different invocation.
    return isinstance(actual, Mapping) and dict(actual) == dict(binding)


def _exact_empty_post_arguments(
    tool_name: Any,
    args: Any,
    wire_tool: str,
) -> bool:
    if not isinstance(tool_name, str) or not isinstance(args, Mapping):
        return False
    if tool_name == wire_tool:
        actual = args
    elif tool_name == "tool_call" and args.get("name") == wire_tool:
        actual = args.get("arguments")
        if isinstance(actual, str):
            try:
                actual = json.loads(actual)
            except (TypeError, ValueError):
                return False
    else:
        return False
    return isinstance(actual, Mapping) and len(actual) == 0


def _routing_only_tool(tool_name: Any) -> bool:
    return tool_name in {"skill_view", "tool_search", "tool_describe"}


def _top_level_result(value: Any) -> Optional[Mapping[str, Any]]:
    if isinstance(value, Mapping):
        return value
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text:
        return None
    if text.startswith("{"):
        try:
            parsed = json.loads(text)
        except (TypeError, ValueError):
            return None
        return parsed if isinstance(parsed, Mapping) else None

    # Hermes wraps MCP output before adding it to model context. Decode only
    # the wrapper's one top-level JSON payload; never recurse into result/body
    # strings where untrusted content could forge vendor metadata.
    if not text.startswith("<untrusted_tool_result"):
        return None
    opening_end = text.find(">")
    closing_start = text.rfind("</untrusted_tool_result>")
    if opening_end < 0 or closing_start <= opening_end:
        return None
    body = text[opening_end + 1 : closing_start]
    json_start = body.find("{")
    if json_start < 0:
        return None
    decoder = json.JSONDecoder()
    try:
        parsed, consumed = decoder.raw_decode(body[json_start:])
    except (TypeError, ValueError):
        return None
    if body[json_start + consumed :].strip():
        return None
    return parsed if isinstance(parsed, Mapping) else None


def _authoritative_rendering(result: Any) -> Optional[str]:
    record = _top_level_result(result)
    meta = record.get("_meta") if isinstance(record, Mapping) else None
    output = meta.get(_OUTPUT_META_KEY) if isinstance(meta, Mapping) else None
    if not isinstance(output, Mapping):
        return None
    rendered = output.get("rendered_response")
    if (
        output.get("schema_version") != 1
        or output.get("mode") != "replace"
        or not isinstance(rendered, str)
    ):
        return None
    rendered = rendered.strip()
    if not rendered or len(rendered) > _MAX_RENDERED_CHARS:
        return None
    # This text came from top-level vendor metadata on the authenticated
    # Agent Boost tool result. Friendly wallet names may legitimately resemble
    # tool names or internal-field prefixes, so reject only structural prompt
    # artifacts here. The broader token checks remain for model-authored text.
    if _unsafe_authoritative_text(rendered):
        return None
    return rendered


def _authoritative_hard_boundary(result: Any) -> bool:
    record = _top_level_result(result)
    meta = record.get("_meta") if isinstance(record, Mapping) else None
    control = meta.get("org.agentboost/turn-control") if isinstance(meta, Mapping) else None
    return bool(
        isinstance(control, Mapping)
        and control.get("schema_version") == 1
        and control.get("boundary") == "new_user_turn"
    )


def _authoritative_complete_turn(result: Any) -> bool:
    record = _top_level_result(result)
    meta = record.get("_meta") if isinstance(record, Mapping) else None
    output = meta.get(_OUTPUT_META_KEY) if isinstance(meta, Mapping) else None
    return bool(
        isinstance(output, Mapping)
        and output.get("schema_version") == 1
        and output.get("mode") == "replace"
        and output.get("complete_turn") is True
    )


def _signed_status_result(
    result: Any,
    route: Mapping[str, Any],
) -> Optional[Dict[str, Any]]:
    """Validate the expected status envelope from top-level vendor metadata."""

    record = _top_level_result(result)
    meta = record.get("_meta") if isinstance(record, Mapping) else None
    context = (
        meta.get("org.agentboost/model-context")
        if isinstance(meta, Mapping)
        else None
    )
    tool = route.get("tool")
    expected_code = _STATUS_RESULT_CODES.get(tool)
    if tool == "wallet_get_tree":
        return (
            {"private_ready": False}
            if route.get("binding") == {}
            and _signed_private_ready_followup(
                result,
                "mcp__agent_boost__wallet_get_tree",
            )
            else None
        )
    if (
        not isinstance(context, Mapping)
        or context.get("schema") != "org.agentboost.tool-result"
        or context.get("schema_version") != "1.0"
        or not isinstance(context.get("manifest_digest"), str)
        or _MANIFEST_DIGEST.fullmatch(context["manifest_digest"]) is None
        or context.get("code") != expected_code
        or not isinstance(context.get("data"), Mapping)
        or not isinstance(route.get("binding"), Mapping)
    ):
        return None

    data = context["data"]
    binding = route["binding"]
    if tool == "onboarding_status":
        setup = data.get("setup")
        since_revision = binding.get("since_revision")
        phase = setup.get("phase") if isinstance(setup, Mapping) else None
        if (
            not isinstance(setup, Mapping)
            or setup.get("setupId") != binding.get("setup_id")
            or not _safe_integer(setup.get("revision"))
            or not _safe_integer(since_revision)
            or setup["revision"] < since_revision
            or phase not in {
                "not_started",
                "creating_wallet",
                "preparing_privacy",
                "awaiting_funding",
                "funding_pending",
                "funded_public",
                "shielding",
                "private_ready",
                "failed",
            }
        ):
            return None
        if phase != "private_ready" and (
            _authoritative_rendering(result) is None
            or not _authoritative_complete_turn(result)
        ):
            return None
        return {"private_ready": phase == "private_ready"}

    request = data.get("request")
    request_phase = request.get("phase") if isinstance(request, Mapping) else None
    request_id = binding.get("request_id")
    decision_id = binding.get("decision_id")
    if tool == "wallet_get_private_balance_operation":
        if (
            isinstance(request_id, str)
            and request_id.startswith("pbcr_")
            or isinstance(decision_id, str)
            and decision_id.startswith("pbc_")
        ):
            allowed_phases = {"creating", "created", "failed", "indeterminate"}
        elif (
            isinstance(request_id, str)
            and request_id.startswith("pbfr_")
            or isinstance(decision_id, str)
            and decision_id.startswith("pbf_")
        ):
            allowed_phases = {
                "executing",
                "submitted",
                "confirmed",
                "failed",
                "indeterminate",
            }
        elif (
            isinstance(request_id, str)
            and request_id.startswith("pbpr_")
            or isinstance(decision_id, str)
            and decision_id.startswith("pbp_")
        ):
            allowed_phases = {"applying", "applied", "failed"}
        else:
            return None
    else:
        allowed_phases = {
            "planned",
            "executing",
            "submitted",
            "confirmed",
            "failed",
            "indeterminate",
        }
    if (
        not isinstance(request, Mapping)
        or (
            request_id is not None
            and request.get("requestId") != request_id
        )
        or (
            decision_id is not None
            and request.get("decisionId") != decision_id
        )
        or request_phase not in allowed_phases
        or _authoritative_rendering(result) is None
        or not _authoritative_complete_turn(result)
    ):
        return None
    return {"private_ready": False}


def _signed_allow_mode_result(
    result: Any,
    dispatch: Mapping[str, Any],
) -> bool:
    """Validate a terminal, unresolved, or no-effect allow-mode result."""

    record = _top_level_result(result)
    meta = record.get("_meta") if isinstance(record, Mapping) else None
    context = (
        meta.get("org.agentboost/model-context")
        if isinstance(meta, Mapping)
        else None
    )
    source_tool = dispatch.get("tool")
    effect = _ALLOW_MODE_TRANSFER_RESULTS.get(source_tool)
    binding = dispatch.get("binding")
    if (
        effect is None
        or not isinstance(binding, Mapping)
        or not isinstance(context, Mapping)
        or context.get("schema") != "org.agentboost.tool-result"
        or context.get("schema_version") != "1.0"
        or not isinstance(context.get("manifest_digest"), str)
        or _MANIFEST_DIGEST.fullmatch(context["manifest_digest"]) is None
        or not isinstance(context.get("data"), Mapping)
        or _authoritative_rendering(result) is None
    ):
        return False

    code = context.get("code")
    data = context["data"]
    decision_id = binding.get("decision_id")
    if code == effect["no_effect_code"]:
        plan = data.get("plan")
        return bool(
            isinstance(plan, Mapping)
            and plan.get("decisionId") == decision_id
            and _authoritative_hard_boundary(result)
        )
    if code not in effect["result_codes"]:
        return False

    request = data.get("request")
    request_id = request.get("requestId") if isinstance(request, Mapping) else None
    phase = request.get("phase") if isinstance(request, Mapping) else None
    if (
        not isinstance(request, Mapping)
        or request.get("decisionId") != decision_id
        or not isinstance(request_id, str)
        or re.fullmatch(
            rf"{effect['request_prefix']}_[A-Za-z0-9-]{{8,128}}",
            request_id,
        ) is None
        or phase not in {
            "executing",
            "submitted",
            "confirmed",
            "failed",
            "indeterminate",
        }
        or not _authoritative_complete_turn(result)
    ):
        return False
    if code.endswith("_REQUEST") and data.get("verification_unavailable") is not True:
        return False
    return True


def _signed_private_ready_followup(result: Any, wire_tool: str) -> bool:
    record = _top_level_result(result)
    meta = record.get("_meta") if isinstance(record, Mapping) else None
    context = (
        meta.get("org.agentboost/model-context")
        if isinstance(meta, Mapping)
        else None
    )
    if wire_tool == "mcp__agent_boost__capabilities":
        return bool(
            isinstance(context, Mapping)
            and context.get("schema") == "org.agentboost.tool-result"
            and context.get("schema_version") == "1.0"
            and isinstance(context.get("manifest_digest"), str)
            and _MANIFEST_DIGEST.fullmatch(context["manifest_digest"])
            and context.get("code") == "CAPABILITIES"
            and context.get("outcome") == "ready"
            and isinstance(context.get("data"), Mapping)
        )
    if wire_tool == "mcp__agent_boost__wallet_get_tree":
        return bool(
            isinstance(context, Mapping)
            and context.get("response_mode") == "verbatim"
            and isinstance(context.get("rendered"), str)
            and context.get("rendered") == _authoritative_rendering(result)
            and _authoritative_hard_boundary(result)
        )
    return False


def _unsafe_authoritative_text(text: str) -> bool:
    return bool(
        _STEER_MARKER.search(text)
        or _RAW_FUNCTION_TAG.search(text)
        or _FABRICATED_USER_TAG.search(text)
        or _SYNTHETIC_APPROVAL_TAG.search(text)
        or _PRIVATE_BACKEND_FIELD.search(text)
        or _OFF_SURFACE_CONFIRMATION.search(text)
    )


def _unsafe_agent_boost_text(text: str) -> bool:
    return bool(
        _unsafe_authoritative_text(text)
        or _INTERNAL_FIELD.search(text)
        or _INTERNAL_VALUE.search(text)
        or _TOOL_SYNTAX.search(text)
    )


def _wallet_operation_intent(user_message: Any) -> bool:
    """Recognize a direct same-turn Agent Boost-style wallet operation request."""

    if not isinstance(user_message, str):
        return False
    text = user_message.strip()
    return bool(
        text
        and not _GENERAL_INFORMATION_REQUEST.search(text)
        and not _EXTERNAL_CONFIRMATION_REFERENCE.search(text)
        and _DIRECT_OPERATION_REQUEST.search(text)
        and _WALLET_OPERATION_VERB.search(text)
        and _WALLET_OPERATION_CONTEXT.search(text)
    )


def _unverified_wallet_confirmation_handoff(
    text: str,
    wallet_operation_intent: bool = False,
) -> bool:
    """Recognize a narrow route-miss handoff without tool provenance."""

    return bool(
        (_WALLET_CONFIRMATION_SCOPE.search(text) or wallet_operation_intent)
        and _OFF_SURFACE_CONFIRMATION.search(text)
        and _EXPLICIT_CONFIRMATION_HANDOFF.search(text)
        and not _EXTERNAL_CONFIRMATION_REFERENCE.search(text)
    )


def _after_tool(
    tool_name: Any = "",
    args: Any = None,
    result: Any = None,
    session_id: Any = "",
    turn_id: Any = "",
    **_: Any,
) -> None:
    if _is_auxiliary_origin() or _known_nested_fork(session_id, turn_id):
        return None
    key = _turn_key(session_id)
    if not key:
        return None
    wire_tool = _agent_boost_wire_tool(tool_name, args)
    is_agent_boost = wire_tool is not None
    with _LOCK:
        state = _TURNS.get(key)
        event_turn_id = _turn_key(turn_id)
        active_turn_id = state.get("turn_id") if state is not None else ""
        # An interrupted turn may finish a tool after Hermes has already
        # started the replacement turn in the same session. Never let that
        # late result overwrite the replacement turn's response state.
        if state is not None and active_turn_id and event_turn_id and event_turn_id != active_turn_id:
            return None
        if state is None:
            state = {
                "turn_id": event_turn_id,
                "wallet_operation_intent": False,
                "saw_agent_boost": False,
                "rendered_calls": 0,
                "mixed_turn": False,
                "rendered": None,
                "hard_boundary": False,
                "complete_turn": False,
                "forced_decision": None,
                "forced_allow_dispatch": None,
                "forced_result_missing": False,
                "forced_result_verified": False,
                "forced_user_confirmed": None,
                "decision_execution_blocked": False,
                "decision_execution_dispatched": False,
                "decision_execution_request_id": "",
                "allow_execution_dispatched": False,
                "forced_status_route": None,
                "status_read_dispatched": False,
                "status_result_missing": False,
                "status_result_verified": False,
                "status_result_private_ready": False,
                "status_capabilities_dispatched": False,
                "status_capabilities_verified": False,
                "status_tree_dispatched": False,
                "status_tree_verified": False,
                "status_clarification": False,
            }
            _TURNS[key] = state
        if is_agent_boost:
            state["saw_agent_boost"] = True
            # A valid newer rendering supersedes the prior one. A same-turn
            # gate block or tool error has no signed rendering, and must not
            # erase the preview that the user is waiting to see.
            rendered = _authoritative_rendering(result)
            forced = state.get("forced_decision")
            if isinstance(forced, Mapping) and wire_tool == forced.get("wire_tool"):
                # The external turn gate consumes its durable receipt before
                # MCP execution. Retain authenticated provenance in memory so
                # an unsigned transport/tool failure cannot become a model-
                # authored success or cancellation claim.
                if rendered is not None:
                    state["forced_result_verified"] = True
                    state["forced_result_missing"] = False
                elif not state.get("forced_result_verified"):
                    state["forced_result_missing"] = True
                state["forced_user_confirmed"] = forced.get("user_confirmed")
            forced_allow = state.get("forced_allow_dispatch")
            if (
                isinstance(forced_allow, Mapping)
                and wire_tool == forced_allow.get("wire_tool")
                and _exact_allow_mode_arguments(tool_name, args, forced_allow)
            ):
                if _signed_allow_mode_result(result, forced_allow):
                    state["forced_result_verified"] = True
                    state["forced_result_missing"] = False
                elif not state.get("forced_result_verified"):
                    state["forced_result_missing"] = True
                state["forced_user_confirmed"] = None
            forced_status = state.get("forced_status_route")
            if (
                state.get("status_read_dispatched")
                and isinstance(forced_status, Mapping)
                and wire_tool == forced_status.get("wire_tool")
                and _exact_status_post_arguments(tool_name, args, forced_status)
            ):
                status_proof = _signed_status_result(result, forced_status)
                if status_proof is not None:
                    state["status_result_verified"] = True
                    state["status_result_missing"] = False
                    state["status_result_private_ready"] = bool(
                        status_proof.get("private_ready")
                    )
                elif not state.get("status_result_verified"):
                    state["status_result_missing"] = True
            if (
                state.get("status_result_verified")
                and state.get("status_result_private_ready")
                and wire_tool in _PRIVATE_READY_FOLLOWUP_TOOLS
                and _exact_empty_post_arguments(tool_name, args, wire_tool)
            ):
                followup_verified = _signed_private_ready_followup(result, wire_tool)
                if wire_tool == "mcp__agent_boost__capabilities":
                    state["status_capabilities_verified"] = bool(
                        state.get("status_capabilities_dispatched")
                        and followup_verified
                    )
                elif wire_tool == "mcp__agent_boost__wallet_get_tree":
                    state["status_tree_verified"] = bool(
                        state.get("status_tree_dispatched")
                        and followup_verified
                    )
            if rendered is not None:
                state["rendered_calls"] += 1
                state["rendered"] = rendered
                state["hard_boundary"] = _authoritative_hard_boundary(result)
                state["complete_turn"] = _authoritative_complete_turn(result)
        elif not _routing_only_tool(tool_name):
            state["mixed_turn"] = True
    return None


def _has_contamination(response_text: str, saw_agent_boost: bool) -> bool:
    if _STEER_MARKER.search(response_text):
        return True
    if _AGENT_BOOST_FUNCTION_TAG.search(response_text):
        return True
    return saw_agent_boost and _unsafe_agent_boost_text(response_text)


def _transform(
    response_text: Any = "",
    session_id: Any = "",
    **_: Any,
) -> Optional[str]:
    # Hermes' final-output hook carries no parent or turn IDs. The host's
    # ambient provenance is therefore the only reliable fork discriminator.
    # Never inspect or retire root rendering/approval state for an auxiliary
    # response.
    if _is_auxiliary_origin():
        return None
    if not isinstance(response_text, str) or not response_text:
        return None
    key = _turn_key(session_id)
    with _LOCK:
        current = _TURNS.get(key) if key else None
        state = dict(current) if current is not None else None
    turn_id = _turn_key(state.get("turn_id")) if state else ""
    unclaimed_decision = _unclaimed_user_decision(key, turn_id)
    pending_allow_dispatch = _authenticated_allow_mode_dispatch_marker(
        key,
        turn_id,
    )

    # A valid current-turn decision receipt is consumed atomically before the
    # exact confirmation tool may run. If it remains now, a weak model skipped
    # (or failed to match) that call. Never let prose alone claim the action or
    # cancellation happened. This check intentionally precedes all model-text
    # and rendering arbitration; it is grounded in the durable gate receipt,
    # not in a success-word heuristic.
    if unclaimed_decision == "approval":
        return (
            "I didn’t execute that approved wallet action, so I can’t report it "
            "as completed. Please send your approval again."
        )
    if unclaimed_decision == "rejection":
        return (
            "I didn’t record that cancellation, so I can’t report the action as "
            "cancelled. Please send cancel again."
        )
    if unclaimed_decision == "invalid":
        return (
            "I couldn’t safely complete that wallet confirmation. Please ask me "
            "to show a fresh preview before trying again."
        )

    forced_result_missing = bool(state and state.get("forced_result_missing"))
    forced_result_verified = bool(state and state.get("forced_result_verified"))
    if forced_result_missing or (
        pending_allow_dispatch is not None and not forced_result_verified
    ):
        if state.get("forced_user_confirmed") is True:
            return (
                "I couldn’t verify the approved wallet action’s Agent Boost "
                "result, so I won’t claim it completed or retry it automatically. "
                "Ask me to check its status before trying again."
            )
        if state.get("forced_user_confirmed") is False:
            return (
                "I couldn’t verify that Agent Boost recorded the cancellation, "
                "so I won’t claim it was cancelled. Ask me for a fresh preview "
                "before trying again."
            )
        return (
            "I couldn’t verify this wallet action’s Agent Boost result, so I "
            "won’t claim it completed or retry it automatically. Ask me to "
            "check its status before trying again."
        )

    status_clarification = bool(
        state and state.get("status_clarification")
    ) or _authenticated_status_clarification_route(key, turn_id)
    if status_clarification:
        return _STATUS_CLARIFICATION_RESPONSE

    current_status_route = _authenticated_status_route(key, turn_id)
    forced_status_route = state.get("forced_status_route") if state else None
    status_result_verified = bool(state and state.get("status_result_verified"))
    if (
        (current_status_route is not None or isinstance(forced_status_route, Mapping))
        and not status_result_verified
    ):
        return (
            "I couldn’t verify a fresh Agent Boost status result for that "
            "operation, so I won’t answer from earlier chat state. Please ask "
            "me to check again."
        )
    private_ready_status = bool(
        state
        and state.get("status_result_verified")
        and state.get("status_result_private_ready")
    )
    private_ready_tree_verified = bool(
        state and state.get("status_tree_verified")
    )
    if private_ready_status and not private_ready_tree_verified:
        return (
            "The private balance is ready, but I couldn’t verify the fresh "
            "capabilities and wallet tree needed to complete setup. Please ask "
            "me to check again."
        )

    saw_agent_boost = bool(state and state.get("saw_agent_boost"))
    rendered_calls = int(state.get("rendered_calls", 0)) if state else 0
    mixed_turn = bool(state and state.get("mixed_turn"))
    rendered = state.get("rendered") if state else None
    hard_boundary = bool(state and state.get("hard_boundary"))
    complete_turn = bool(state and state.get("complete_turn"))
    wallet_operation_intent = bool(
        state and state.get("wallet_operation_intent")
    )
    if (
        not saw_agent_boost
        and _unverified_wallet_confirmation_handoff(
            response_text,
            wallet_operation_intent,
        )
    ):
        # A provider route miss has no signed Agent Boost result to render, but
        # it must not invent a second confirmation surface. Keep this lexical
        # fallback deliberately narrow so real external-site directions and
        # unrelated confirmations pass through unchanged.
        return _CHAT_CONFIRMATION_ROUTE_MISS_RESPONSE
    contaminated = _has_contamination(response_text, saw_agent_boost)
    setup_completion_contaminated = bool(
        contaminated
        or (
            private_ready_status
            and _PRIVATE_READY_CHAIN_VALUE.search(response_text)
        )
    )

    # A one-call Agent Boost turn with an authoritative rendering never depends
    # on model paraphrase. Some multi-call flows require synthesis, but a result
    # explicitly marked complete_turn (for example a verified transfer status)
    # is already the full receipt and must win over model-added prose. Any
    # contamination also fails over to the latest trusted rendering.
    composite_turn = mixed_turn or rendered_calls > 1
    if (
        private_ready_status
        and private_ready_tree_verified
        and isinstance(rendered, str)
        and rendered in response_text
        and re.search(r"\b3\s*/\s*3\b", response_text) is not None
        and not setup_completion_contaminated
    ):
        # In the setup-completion flow the signed tree is one required part of
        # the 3/3 response, not the whole response. Preserve clean synthesis
        # only when it embeds that exact trusted tree byte-for-byte.
        return None
    if isinstance(rendered, str) and (
        hard_boundary or complete_turn or not composite_turn or contaminated
    ):
        return rendered
    if not contaminated:
        return None
    if saw_agent_boost:
        return (
            "I couldn’t safely display the Agent Boost result. Ask me to check "
            "its current status before retrying anything."
        )
    return "I couldn’t produce a valid response. Please send your request again."


def register(ctx: Any) -> None:
    def native_pre_llm(**kwargs: Any) -> Optional[Dict[str, str]]:
        return _pre_llm(ctx, **kwargs)

    ctx.register_hook("pre_llm_call", native_pre_llm)
    ctx.register_hook("post_tool_call", _after_tool)
    ctx.register_hook("transform_llm_output", _transform)
    ctx.register_middleware("llm_request", _force_decision_tool)
    ctx.register_middleware("tool_request", _pin_decision_arguments)
    ctx.register_middleware("tool_execution", _enforce_decision_execution)
