permit(principal, action, resource)
when { principal.project == resource.project && (
  (action == Service::Action::"invoke_component" && ["orders", "targets", "data_worker"].contains(resource.name)) ||
  (action == Service::Action::"invoke_tool" && ["read_metadata", "capabilities", "close_session", "run_sql", "open_session", "ask_data", "continue_task", "get_evidence", "query", "read_context", "clarify"].contains(resource.name)) ||
  (action == Service::Action::"execute_query" && resource.name == "orders" && resource.columns.containsAll(["order_date"]) && ["order_date"].containsAll(resource.columns)) ||
  (action == Service::Action::"receive_metadata" && (principal.role == "worker" || ["schema.structure", "schema.descriptions", "knowledge.rules"].contains(resource.kind))) ||
  (action == Service::Action::"receive_answer" && ["orders", "targets"].contains(resource.name) && resource.recipient == principal.caller)
) };
