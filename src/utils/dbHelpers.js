export function isManagerOrAdmin(user) {
  if (!user) return false;
  const adminRoles = ["admin", "super_admin", "general_manager", "operations_manager"];
  return adminRoles.includes(user.role);
}

export function getBrandCondition(req, tableAlias = "", brandCol = "brand_id") {
  const brandId = req.query.brand_id || req.body.brand_id || req.params.brand_id;
  const prefix = tableAlias ? `${tableAlias}.` : "";
  
  // For customers, we need to join customer_brands
  // For tables that natively have brand_id (call_logs, purchase_history, etc), we just filter by brand_id
  const isCustomersTable = tableAlias === "c" || tableAlias === "customers";
  const joinClause = isCustomersTable ? `JOIN customer_brands cb ON cb.customer_id = ${prefix || ""}id` : "";
  const filterCol = isCustomersTable ? `cb.brand_id` : `${prefix || ""}${brandCol}`;

  if (brandId && brandId !== "all") {
    return { join: joinClause, condition: `${filterCol} = ?`, param: brandId };
  } else if (req.user && isManagerOrAdmin(req.user)) {
    return { join: "", condition: "1=1", param: null };
  } else if (req.user && req.user.brands && req.user.brands.length > 0) {
    const placeholders = req.user.brands.map(() => "?").join(",");
    if (isCustomersTable) {
      return { 
        join: `LEFT JOIN customer_brands cb ON cb.customer_id = ${prefix || ""}id`, 
        condition: `(${filterCol} IN (${placeholders}) OR ${prefix}assigned_agent_id = ?)`, 
        params: [...req.user.brands, req.user.id] 
      };
    }
    return { join: joinClause, condition: `${filterCol} IN (${placeholders})`, params: req.user.brands };
  } else {
    // If agent has no specific brand restriction, allow their assigned customers
    if (isCustomersTable && req.user?.id) {
      return { join: "", condition: `${prefix}assigned_agent_id = ?`, params: [req.user.id] };
    }
    return { join: "", condition: "1=0", param: null };
  }
}

/**
 * Returns SQL condition scoping customer records to the authenticated user.
 * - Admins and Managers: 1=1 (all customers)
 * - Agents: table.assigned_agent_id = req.user.id
 */
export function getCustomerScopeCondition(req, tableAlias = "customers", agentCol = "assigned_agent_id") {
  const prefix = tableAlias ? `${tableAlias}.` : "";
  if (!req.user) {
    return { condition: "1=0", params: [] };
  }

  // Admins & Managers see all customers
  if (isManagerOrAdmin(req.user)) {
    return { condition: "1=1", params: [] };
  }

  // Agents only see customers assigned to them
  return {
    condition: `${prefix}${agentCol} = ?`,
    params: [req.user.id]
  };
}
