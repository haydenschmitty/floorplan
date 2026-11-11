"""Floorplan as a native Hermes plugin: the shared skill, and one `hermes floorplan` command.

`skills/floorplan/SKILL.md` is registered read-only as `floorplan:floorplan` (the `/floorplan:floorplan`
slash form) and is not copied anywhere. Nothing here runs on its own: no hooks, no MCP server, no tools.
"""
from pathlib import Path

REPO = Path(__file__).resolve().parent
SKILL_MD = REPO / "skills" / "floorplan" / "SKILL.md"


def register(ctx) -> None:
    from .hermes.runner import probe, setup_cli

    ctx.register_skill("floorplan", SKILL_MD, "Draw and update a codebase map (Floorplan).")
    ctx.register_cli_command(
        "floorplan",
        "Floorplan map tools: probe this install, and answer the map's questions",
        setup_fn=setup_cli,
        handler_fn=lambda args: probe(args, profile=ctx.profile_name, plugin_version=ctx.manifest.version,
                                      skill_path=SKILL_MD, ctx=ctx),
        description="Build, refresh and query a Floorplan map from Hermes.",
    )
