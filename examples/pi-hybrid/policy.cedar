permit(principal, action, resource)
when { principal.zone == "private" };
permit(principal, action == Warble::Action::"invoke_component", resource)
when { principal.zone == "public" && resource.document == "data_worker" };
permit(principal, action == Warble::Action::"receive_answer", resource)
when { principal.zone == "public" };
permit(principal, action == Warble::Action::"receive_metadata", resource)
when { principal.zone == "public" && (
  (resource.kind == "schema.structure" && resource.document == "structure") ||
  (resource.kind == "schema.descriptions" && resource.document == "descriptions") ||
  (resource.kind == "knowledge.rules" && ["business-rules", "weekly-target"].contains(resource.document))
) };
