from __future__ import annotations

from agents.base import AgentSpec, AgentResult, run_agent
from agents.executor import SPEC as EXECUTOR_SPEC
from agents.researcher import SPEC as RESEARCHER_SPEC
from agents.reviewer import SPEC as REVIEWER_SPEC
from agents.influencer_profiler import SPEC as INFLUENCER_PROFILER_SPEC
from agents.script_scorer import SPEC as SCRIPT_SCORER_SPEC
from agents.writer import SPEC as WRITER_SPEC

AGENT_REGISTRY: dict[str, AgentSpec] = {
    RESEARCHER_SPEC.name: RESEARCHER_SPEC,
    WRITER_SPEC.name: WRITER_SPEC,
    REVIEWER_SPEC.name: REVIEWER_SPEC,
    EXECUTOR_SPEC.name: EXECUTOR_SPEC,
    SCRIPT_SCORER_SPEC.name: SCRIPT_SCORER_SPEC,
    INFLUENCER_PROFILER_SPEC.name: INFLUENCER_PROFILER_SPEC,
}


def get_agent(name: str) -> AgentSpec:
    key = name.strip().lower()
    if key not in AGENT_REGISTRY:
        known = ", ".join(sorted(AGENT_REGISTRY))
        raise KeyError(f"Unknown agent '{name}'. Available: {known}")
    return AGENT_REGISTRY[key]


def list_agents() -> list[dict[str, str]]:
    return [
        {"name": spec.name, "description": spec.description}
        for spec in AGENT_REGISTRY.values()
    ]


def invoke(name: str, user_input: str) -> AgentResult:
    key = name.strip().lower()
    if key == INFLUENCER_PROFILER_SPEC.name:
        from agents.influencer_profiler import run_influencer_profiler

        return run_influencer_profiler(user_input)
    return run_agent(get_agent(name), user_input)


__all__ = [
    "AGENT_REGISTRY",
    "get_agent",
    "list_agents",
    "invoke",
    "AgentSpec",
    "AgentResult",
]
