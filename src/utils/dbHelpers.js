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
  } else if (req.user.role === 'admin' || req.user.role === 'general_manager' || req.user.role === 'operations_manager') {
    return { join: "", condition: "1=1", param: null };
  } else if (req.user.brands && req.user.brands.length > 0) {
    const placeholders = req.user.brands.map(() => "?").join(",");
    return { join: joinClause, condition: `${filterCol} IN (${placeholders})`, params: req.user.brands };
  } else {
    return { join: "", condition: "1=0", param: null };
  }
}
