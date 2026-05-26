"""Chain builder pattern for Eden pipeline graph construction."""

from dataclasses import dataclass, field
from typing import Callable, Optional
from langgraph.graph import StateGraph, END

from eden.pipeline.state import EdenJobState


# Global registries
NODE_REGISTRY: dict[str, Callable] = {}
ROUTER_REGISTRY: dict[str, Callable] = {}


@dataclass
class ChainConfig:
    """Configuration for building the Eden pipeline chain."""

    # Edges in the chain - each tuple is (from_node, to_node)
    # For conditional edges, use (from_node, router_name) where router_name is registered in ROUTER_REGISTRY
    edges: list[tuple[str, str]] = field(default_factory=list)

    # Entry point node name
    entry_point: str = "planner"

    # Optional interrupt configuration
    interrupt_before_nodes: Optional[list[str]] = None


def register_node(name: str, node_func: Callable) -> None:
    """Register a node function with the NODE_REGISTRY.

    Args:
        name: Node name identifier
        node_func: Async function that takes EdenJobState and returns dict
    """
    NODE_REGISTRY[name] = node_func


def register_router(name: str, router_func: Callable) -> None:
    """Register a router function with the ROUTER_REGISTRY.

    Args:
        name: Router name identifier
        router_func: Function that takes EdenJobState and returns str (node name)
    """
    ROUTER_REGISTRY[name] = router_func


def clear_registries() -> None:
    """Clear all registries. Useful for testing."""
    NODE_REGISTRY.clear()
    ROUTER_REGISTRY.clear()


def build_chain(config: Optional[ChainConfig] = None) -> list[tuple[str, str | Callable]]:
    """Build a chain from ChainConfig or return default chain.

    Args:
        config: Optional ChainConfig to customize the chain

    Returns:
        List of (source, target) tuples where target is either a node name or router function
    """
    if config is None:
        # Default Eden chain
        return [
            ("planner", "critic"),
            ("critic", "critic_router"),
            ("refiner", "fact_checker"),
            ("fact_checker", "executor"),
            ("executor", "code_quality"),
            ("code_quality", "code_quality_router"),
            ("verifier", "verifier_router"),
            ("tester", "tester_router"),
            ("archivist", END),
        ]

    chain = []
    for from_node, to_node in config.edges:
        chain.append((from_node, to_node))
    return chain


def build_graph_from_chain(
    chain: list[tuple[str, str | Callable]],
    checkpointer=None,
    interrupt_before_nodes: Optional[list[str]] = None,
) -> StateGraph:
    """Build a StateGraph from a chain specification.

    Args:
        chain: List of (source, target) tuples
        checkpointer: Optional checkpointer for state persistence
        interrupt_before_nodes: Optional list of node names to interrupt before

    Returns:
        Compiled StateGraph
    """
    graph = StateGraph(EdenJobState)

    # Add all registered nodes
    for node_name, node_func in NODE_REGISTRY.items():
        graph.add_node(node_name, node_func)

    # Add edges from chain
    for from_node, to_node in chain:
        # Handle END sentinel
        if to_node is END:
            graph.add_edge(from_node, END)
        elif isinstance(to_node, str) and to_node in ROUTER_REGISTRY:
            # Conditional edge via router
            router_func = ROUTER_REGISTRY[to_node]
            graph.add_conditional_edges(from_node, router_func)
        elif isinstance(to_node, str):
            # Direct edge
            graph.add_edge(from_node, to_node)
        else:
            # It's a callable (router function directly)
            graph.add_conditional_edges(from_node, to_node)

    # Set entry point
    graph.set_entry_point(chain[0][0] if chain else "planner")

    return graph


def compile_graph(
    checkpointer=None,
    interrupt_before_nodes: Optional[list[str]] = None,
    config: Optional[ChainConfig] = None,
):
    """Compile the Eden graph with optional configuration.

    Args:
        checkpointer: Optional checkpointer for state persistence
        interrupt_before_nodes: Optional list of node names to interrupt before
        config: Optional ChainConfig to customize the chain

    Returns:
        Compiled graph
    """
    chain = build_chain(config)
    graph = build_graph_from_chain(chain, checkpointer, interrupt_before_nodes)
    compiled = graph.compile(checkpointer=checkpointer)
    return compiled
