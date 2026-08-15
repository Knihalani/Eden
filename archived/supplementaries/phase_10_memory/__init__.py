"""Phase 10 — Memory and agent-to-agent (A2A) coordination.

Three responsibilities:
  1. ``parse_a2a_event`` — normalise inbound A2A message envelopes
     (camelCase + snake_case tolerant).
  2. ``detect_swarm_topology`` — flag star / chain / mesh topologies
     in a multi-agent trace.
  3. ``detect_agent_depth_runaway`` — alert on unbounded depth in
     recursive agent spawn chains.
"""
