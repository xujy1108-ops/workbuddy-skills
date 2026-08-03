from __future__ import annotations

from agents.base import AgentSpec, AgentResult, run_agent
from agents.influencer_profiler import SPEC as INFLUENCER_PROFILER_SPEC

AGENT_REGISTRY: dict[str, AgentSpec] = {
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
