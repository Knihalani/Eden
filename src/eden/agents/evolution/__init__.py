"""Evolution Engine — async background processes.

Components:
- Distiller: Nightly batch clustering of episodic memory
- PromptEvolvers: Per-agent prompt improvement
- ResearchHarvester: Weekly research crawling
- RetrievalTuner: KB retrieval optimization
- PatternMiner: Monthly deep cross-job analysis
"""

from eden.agents.evolution.components import (
    EvolutionComponent,
    Distiller,
    PromptEvolvers,
    ResearchHarvester,
    RetrievalTuner,
    PatternMiner,
)

__all__ = [
    "EvolutionComponent",
    "Distiller",
    "PromptEvolvers",
    "ResearchHarvester",
    "RetrievalTuner",
    "PatternMiner",
]