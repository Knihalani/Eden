output "public_ips" {
  description = "Point EDEN_DOMAIN's DNS here: the load balancer, else the router(s), else the single box."
  value = (
    length(hcloud_load_balancer.eden) > 0 ? [hcloud_load_balancer.eden[0].ipv4] :
    length(hcloud_server.router) > 0 ? hcloud_server.router[*].ipv4_address :
    hcloud_server.node[*].ipv4_address
  )
}

output "node_private_ips" {
  value = local.node_ips
}

output "nodes_file" {
  description = "The cluster router's nodes file (deploy/compose/cluster-router/nodes)."
  value       = local.nodes_file
}

output "ssh" {
  value = concat(
    [for s in hcloud_server.node : "root@${s.ipv4_address}  # ${s.name}"],
    [for s in hcloud_server.router : "root@${s.ipv4_address}  # ${s.name}"],
  )
}
